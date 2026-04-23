const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_CODE_LENGTH = 6;
const DEFAULT_MAX_PLAYERS = 12;
const DEFAULT_PLAYER_GRACE_MS = 45000;
const DEFAULT_ADMIN_GRACE_MS = 60000;
const TEST_GAME_PLAYER_NAMES = ['Ava', 'Noah', 'Mila', 'Luca', 'Iris', 'Theo'];

function generateCode(existingLobbies, length = DEFAULT_CODE_LENGTH) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return existingLobbies.has(code) ? generateCode(existingLobbies, length) : code;
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

function isValidLobbyCode(code) {
  return /^[A-Z2-9]{6}$/.test(code);
}

function serializePlayer(player) {
  return {
    id: player.sessionId,
    name: player.name,
    connected: Boolean(player.connected),
    isTestPlayer: Boolean(player.isTestPlayer)
  };
}

function serializeLobby(lobby) {
  const players = Array.from(lobby.players.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(serializePlayer);
  const connectedPlayers = players.filter((player) => player.connected).length;

  return {
    code: lobby.code,
    players,
    playerCount: players.length,
    connectedPlayers,
    rolesAssigned: lobby.rolesAssigned,
    minimumPlayers: 4,
    maxPlayers: lobby.maxPlayers,
    adminConnected: Boolean(lobby.admin.connected)
  };
}

function assignRoles(players) {
  const count = players.length;
  const numKillers = Math.max(1, Math.floor(count / 4));
  const numDoctors = count >= 4 ? Math.max(1, Math.floor(count / 5)) : 0;
  const numVillagers = count - numKillers - numDoctors;

  const roles = [];
  for (let i = 0; i < numKillers; i += 1) roles.push('Killer');
  for (let i = 0; i < numDoctors; i += 1) roles.push('Doctor');
  for (let i = 0; i < numVillagers; i += 1) roles.push('Villager');

  for (let i = roles.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
}

function getAdminAssignments(lobby) {
  return Array.from(lobby.players.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((player) => ({
      id: player.sessionId,
      name: player.name,
      connected: player.connected,
      role: player.role || null,
      isTestPlayer: Boolean(player.isTestPlayer)
    }));
}

function getOrderedPlayers(lobby) {
  return Array.from(lobby.players.values()).sort((a, b) => a.joinedAt - b.joinedAt);
}

function createAppServer(options = {}) {
  const config = {
    port: Number(options.port || process.env.PORT || 3000),
    publicAppUrl: options.publicAppUrl || process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || '',
    railwayPublicDomain: options.railwayPublicDomain || process.env.RAILWAY_PUBLIC_DOMAIN || '',
    maxPlayers: Number(options.maxPlayers || process.env.MAX_PLAYERS || DEFAULT_MAX_PLAYERS),
    playerGraceMs: Number(options.playerGraceMs || process.env.PLAYER_GRACE_MS || DEFAULT_PLAYER_GRACE_MS),
    adminGraceMs: Number(options.adminGraceMs || process.env.ADMIN_GRACE_MS || DEFAULT_ADMIN_GRACE_MS),
    localIP: options.localIP || getLocalIP()
  };

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const lobbies = new Map();
  const localIP = config.localIP;

  app.set('trust proxy', true);
  app.use(express.static(path.join(__dirname, 'public')));

  function getPublicBaseUrl(req) {
    if (config.publicAppUrl) {
      return config.publicAppUrl.replace(/\/$/, '');
    }

    if (config.railwayPublicDomain) {
      return `https://${config.railwayPublicDomain}`;
    }

    const forwardedProto = req.get('x-forwarded-proto');
    const forwardedHost = req.get('x-forwarded-host');
    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }

    const host = req.get('host');
    if (host) {
      return `${req.protocol}://${host}`;
    }

    return `http://localhost:${config.port}`;
  }

  function clearTimer(handle) {
    if (handle) {
      clearTimeout(handle);
    }
  }

  function findLobbyByAdminSession(adminSessionId) {
    for (const lobby of lobbies.values()) {
      if (lobby.admin.sessionId === adminSessionId) {
        return lobby;
      }
    }
    return null;
  }

  function removePlayerFromLobby(lobby, playerSessionId, reason = 'left') {
    const player = lobby.players.get(playerSessionId);
    if (!player) return;

    clearTimer(player.removeTimer);
    lobby.players.delete(playerSessionId);

    if (reason === 'kicked' && player.socketId) {
      io.to(player.socketId).emit('kicked', { message: 'You have been removed from the lobby.' });
    }

    broadcastLobbyState(lobby.code, {
      type: reason === 'kicked' ? 'player-kicked' : 'player-left',
      name: player.name
    });

    maybeCleanupLobby(lobby.code);
  }

  function closeLobby(code, message) {
    const lobby = lobbies.get(code);
    if (!lobby) return;

    clearTimer(lobby.admin.closeTimer);
    for (const player of lobby.players.values()) {
      clearTimer(player.removeTimer);
    }

    io.to(code).emit('lobby-closed', { message });
    lobbies.delete(code);
  }

  function maybeCleanupLobby(code) {
    const lobby = lobbies.get(code);
    if (!lobby) return;

    if (lobby.admin.connected) {
      return;
    }

    // When the storyteller is temporarily offline, keep the lobby alive until
    // the reconnect grace timer expires so refresh/reconnect flows can recover.
  }

  function broadcastLobbyState(code, eventMeta = null) {
    const lobby = lobbies.get(code);
    if (!lobby) return;

    const payload = {
      ...serializeLobby(lobby),
      event: eventMeta
    };

    io.to(code).emit('lobby-state', payload);
  }

  function attachSocketToLobby(socket, lobby, role, sessionId) {
    socket.join(lobby.code);
    socket.data.lobbyCode = lobby.code;
    socket.data.sessionId = sessionId;
    socket.data.role = role;
  }

  function scheduleAdminClose(lobby) {
    clearTimer(lobby.admin.closeTimer);
    lobby.admin.closeTimer = setTimeout(() => {
      const current = lobbies.get(lobby.code);
      if (current && !current.admin.connected) {
        closeLobby(lobby.code, 'The storyteller did not reconnect in time. Lobby closed.');
      }
    }, config.adminGraceMs);
  }

  function schedulePlayerRemoval(lobby, player) {
    clearTimer(player.removeTimer);
    player.removeTimer = setTimeout(() => {
      const currentLobby = lobbies.get(lobby.code);
      if (!currentLobby) return;
      const currentPlayer = currentLobby.players.get(player.sessionId);
      if (currentPlayer && !currentPlayer.connected) {
        removePlayerFromLobby(currentLobby, currentPlayer.sessionId, 'left');
      }
    }, config.playerGraceMs);
  }

  function restorePlayerRole(player) {
    return player.role ? { role: player.role } : null;
  }

  function assignRolesInLobby(lobby) {
    const orderedPlayers = getOrderedPlayers(lobby);
    const roles = assignRoles(orderedPlayers);

    lobby.rolesAssigned = true;
    lobby.roles = {};

    orderedPlayers.forEach((player, index) => {
      player.role = roles[index];
      lobby.roles[player.sessionId] = player.role;
      if (player.socketId) {
        io.to(player.socketId).emit('role-assigned', { role: player.role, restored: false });
      }
    });

    return orderedPlayers.map((player) => ({
      id: player.sessionId,
      name: player.name,
      connected: player.connected,
      role: player.role,
      isTestPlayer: Boolean(player.isTestPlayer)
    }));
  }

  function hasHumanPlayers(lobby) {
    return Array.from(lobby.players.values()).some((player) => !player.isTestPlayer);
  }

  function hasTestPlayers(lobby) {
    return Array.from(lobby.players.values()).some((player) => player.isTestPlayer);
  }

  function resetLobbyRoles(lobby) {
    lobby.rolesAssigned = false;
    lobby.roles = {};

    for (const player of lobby.players.values()) {
      player.role = null;
    }
  }

  function clearTestPlayers(lobby) {
    let removedCount = 0;
    for (const [sessionId, player] of lobby.players.entries()) {
      if (player.isTestPlayer) {
        clearTimer(player.removeTimer);
        lobby.players.delete(sessionId);
        removedCount += 1;
      }
    }

    return removedCount;
  }

  function seedTestPlayers(lobby) {
    clearTestPlayers(lobby);
    resetLobbyRoles(lobby);

    const seededAt = Date.now();
    TEST_GAME_PLAYER_NAMES.forEach((name, index) => {
      const sessionId = `test-${uuidv4()}`;
      lobby.players.set(sessionId, {
        sessionId,
        socketId: null,
        name,
        connected: true,
        joinedAt: seededAt + index,
        role: null,
        removeTimer: null,
        isTestPlayer: true
      });
    });
  }

  app.get('/health', (req, res) => {
    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      lobbies: lobbies.size
    });
  });

  app.get('/api/lobby/:code', (req, res) => {
    const code = normalizeCode(req.params.code);
    const lobby = lobbies.get(code);
    if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
    return res.json(serializeLobby(lobby));
  });

  app.get('/api/qrcode/:code', async (req, res) => {
    const code = normalizeCode(req.params.code);
    const lobby = lobbies.get(code);
    if (!lobby) return res.status(404).json({ error: 'Lobby not found' });

    const joinUrl = `${getPublicBaseUrl(req)}/join.html?code=${encodeURIComponent(code)}`;

    try {
      const dataUrl = await QRCode.toDataURL(joinUrl, {
        width: 320,
        margin: 2,
        color: { dark: '#f2d18b', light: '#150f1d' }
      });

      return res.json({ qr: dataUrl, url: joinUrl });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });

  io.on('connection', (socket) => {
    socket.on('create-lobby', (payload = {}, callback = () => {}) => {
      const adminSessionId = payload.adminSessionId || uuidv4();
      const existingLobby = findLobbyByAdminSession(adminSessionId);

      if (existingLobby) {
        clearTimer(existingLobby.admin.closeTimer);
        existingLobby.admin.connected = true;
        existingLobby.admin.socketId = socket.id;
        attachSocketToLobby(socket, existingLobby, 'admin', adminSessionId);
        broadcastLobbyState(existingLobby.code, { type: 'admin-restored' });

        return callback({
          success: true,
          restored: true,
          lobby: serializeLobby(existingLobby),
          code: existingLobby.code,
          adminSessionId,
          assignments: existingLobby.rolesAssigned ? getAdminAssignments(existingLobby) : []
        });
      }

      const code = generateCode(lobbies);
      const lobby = {
        code,
        createdAt: Date.now(),
        maxPlayers: config.maxPlayers,
        rolesAssigned: false,
        roles: {},
        admin: {
          sessionId: adminSessionId,
          socketId: socket.id,
          connected: true,
          closeTimer: null
        },
        players: new Map()
      };

      lobbies.set(code, lobby);
      attachSocketToLobby(socket, lobby, 'admin', adminSessionId);
      broadcastLobbyState(code, { type: 'lobby-created' });

      return callback({
        success: true,
        restored: false,
        code,
        adminSessionId,
        lobby: serializeLobby(lobby),
        localNetworkUrl: `http://${localIP}:${config.port}`
      });
    });

    socket.on('restore-lobby', ({ code, adminSessionId } = {}, callback = () => {}) => {
      const normalizedCode = normalizeCode(code);
      const lobby = lobbies.get(normalizedCode);

      if (!lobby) return callback({ error: 'Lobby not found.' });
      if (!adminSessionId || lobby.admin.sessionId !== adminSessionId) {
        return callback({ error: 'You are not the storyteller for this lobby.' });
      }

      clearTimer(lobby.admin.closeTimer);
      lobby.admin.connected = true;
      lobby.admin.socketId = socket.id;
      attachSocketToLobby(socket, lobby, 'admin', adminSessionId);
      broadcastLobbyState(lobby.code, { type: 'admin-restored' });

      return callback({
        success: true,
        code: lobby.code,
        adminSessionId,
        lobby: serializeLobby(lobby),
        assignments: lobby.rolesAssigned ? getAdminAssignments(lobby) : []
      });
    });

    socket.on('join-lobby', ({ code, name, playerSessionId } = {}, callback = () => {}) => {
      const normalizedCode = normalizeCode(code);
      const normalizedName = sanitizeName(name);
      const sessionId = playerSessionId || uuidv4();
      const lobby = lobbies.get(normalizedCode);

      if (!isValidLobbyCode(normalizedCode)) {
        return callback({ error: 'Lobby code must be 6 characters.' });
      }

      if (!lobby) {
        return callback({ error: 'Lobby not found. Check the code and try again.' });
      }

      if (!normalizedName || normalizedName.length < 2) {
        return callback({ error: 'Enter a name with at least 2 characters.' });
      }

      const existingPlayer = lobby.players.get(sessionId);
      const conflictingPlayer = Array.from(lobby.players.values()).find(
        (player) =>
          player.sessionId !== sessionId &&
          player.name.toLowerCase() === normalizedName.toLowerCase()
      );

      if (conflictingPlayer) {
        return callback({ error: 'That name is already taken. Choose a different name.' });
      }

      if (lobby.rolesAssigned && !existingPlayer) {
        return callback({ error: 'Game already started. New players cannot join right now.' });
      }

      if (!existingPlayer && lobby.players.size >= lobby.maxPlayers) {
        return callback({ error: `Lobby is full. Maximum ${lobby.maxPlayers} players.` });
      }

      let player = existingPlayer;
      let eventType = 'player-joined';

      if (!player) {
        player = {
          sessionId,
          socketId: socket.id,
          name: normalizedName,
          connected: true,
          joinedAt: Date.now(),
          role: null,
          removeTimer: null
        };
        lobby.players.set(sessionId, player);
      } else {
        clearTimer(player.removeTimer);
        player.socketId = socket.id;
        player.connected = true;
        eventType = 'player-restored';
        if (!lobby.rolesAssigned) {
          player.name = normalizedName;
        }
      }

      attachSocketToLobby(socket, lobby, 'player', sessionId);
      broadcastLobbyState(lobby.code, { type: eventType, name: player.name });

      if (player.role) {
        io.to(player.socketId).emit('role-assigned', { role: player.role, restored: true });
      }

      return callback({
        success: true,
        playerSessionId: sessionId,
        lobby: serializeLobby(lobby),
        role: restorePlayerRole(player),
        restored: eventType === 'player-restored'
      });
    });

    socket.on('assign-roles', ({ code } = {}, callback = () => {}) => {
      const normalizedCode = normalizeCode(code);
      const lobby = lobbies.get(normalizedCode);

      if (!lobby) return callback({ error: 'Lobby not found.' });
      if (lobby.admin.socketId !== socket.id) {
        return callback({ error: 'Only the storyteller can assign roles.' });
      }

      const connectedPlayers = Array.from(lobby.players.values()).filter((player) => player.connected);
      if (connectedPlayers.length < 4) {
        return callback({ error: 'Need at least 4 connected players to assign roles.' });
      }

      const assignments = assignRolesInLobby(lobby);

      broadcastLobbyState(lobby.code, { type: 'roles-assigned' });

      return callback({
        success: true,
        assignments
      });
    });

    socket.on('run-test-game', ({ code } = {}, callback = () => {}) => {
      const normalizedCode = normalizeCode(code);
      const lobby = lobbies.get(normalizedCode);

      if (!lobby) return callback({ error: 'Lobby not found.' });
      if (lobby.admin.socketId !== socket.id) {
        return callback({ error: 'Only the storyteller can run the test game.' });
      }
      if (hasHumanPlayers(lobby)) {
        return callback({ error: 'Remove real players before running the test game.' });
      }

      seedTestPlayers(lobby);
      const assignments = assignRolesInLobby(lobby);

      broadcastLobbyState(lobby.code, { type: 'test-game-ready' });

      return callback({
        success: true,
        lobby: serializeLobby(lobby),
        assignments
      });
    });

    socket.on('clear-test-game', ({ code } = {}, callback = () => {}) => {
      const normalizedCode = normalizeCode(code);
      const lobby = lobbies.get(normalizedCode);

      if (!lobby) return callback({ error: 'Lobby not found.' });
      if (lobby.admin.socketId !== socket.id) {
        return callback({ error: 'Only the storyteller can clear the test game.' });
      }
      if (!hasTestPlayers(lobby)) {
        return callback({ error: 'No test game is active right now.' });
      }

      clearTestPlayers(lobby);
      resetLobbyRoles(lobby);

      const serializedLobby = serializeLobby(lobby);
      io.to(lobby.code).emit('lobby-reset', { lobby: serializedLobby });
      broadcastLobbyState(lobby.code, { type: 'test-game-cleared' });

      return callback({
        success: true,
        lobby: serializedLobby
      });
    });

    socket.on('kick-player', ({ code, playerId } = {}, callback = () => {}) => {
      const normalizedCode = normalizeCode(code);
      const lobby = lobbies.get(normalizedCode);
      if (!lobby) return callback({ error: 'Lobby not found.' });
      if (lobby.admin.socketId !== socket.id) {
        return callback({ error: 'Only the storyteller can remove players.' });
      }

      if (!lobby.players.has(playerId)) {
        return callback({ error: 'Player not found.' });
      }

      removePlayerFromLobby(lobby, playerId, 'kicked');
      return callback({ success: true });
    });

    socket.on('reset-lobby', ({ code } = {}, callback = () => {}) => {
      const normalizedCode = normalizeCode(code);
      const lobby = lobbies.get(normalizedCode);

      if (!lobby) return callback({ error: 'Lobby not found.' });
      if (lobby.admin.socketId !== socket.id) {
        return callback({ error: 'Only the storyteller can reset the lobby.' });
      }

      resetLobbyRoles(lobby);

      io.to(lobby.code).emit('lobby-reset', { lobby: serializeLobby(lobby) });
      broadcastLobbyState(lobby.code, { type: 'lobby-reset' });

      return callback({ success: true });
    });

    socket.on('disconnect', () => {
      const { lobbyCode, sessionId, role } = socket.data || {};
      if (!lobbyCode || !sessionId) return;

      const lobby = lobbies.get(lobbyCode);
      if (!lobby) return;

      if (role === 'admin' && lobby.admin.sessionId === sessionId) {
        lobby.admin.connected = false;
        lobby.admin.socketId = null;
        scheduleAdminClose(lobby);
        broadcastLobbyState(lobby.code, { type: 'admin-disconnected' });
        maybeCleanupLobby(lobby.code);
        return;
      }

      const player = lobby.players.get(sessionId);
      if (!player) return;

      player.connected = false;
      player.socketId = null;
      schedulePlayerRemoval(lobby, player);
      broadcastLobbyState(lobby.code, { type: 'player-disconnected', name: player.name });
    });
  });

  async function start(listenOptions = {}) {
    const port = listenOptions.port || config.port;
    const host = listenOptions.host || '0.0.0.0';

    await new Promise((resolve) => {
      server.listen(port, host, resolve);
    });

    return server.address();
  }

  async function close() {
    for (const lobby of lobbies.values()) {
      clearTimer(lobby.admin.closeTimer);
      for (const player of lobby.players.values()) {
        clearTimer(player.removeTimer);
      }
    }

    if (!server.listening) return;

    await new Promise((resolve, reject) => {
      io.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  return {
    app,
    server,
    io,
    config,
    state: { lobbies },
    start,
    close
  };
}

if (require.main === module) {
  const runtime = createAppServer();

  runtime.start().then(() => {
    console.log('\nMafia Lobby Server running!');
    console.log(`   Local:   http://localhost:${runtime.config.port}`);
    console.log(`   Network: http://${runtime.config.localIP}:${runtime.config.port}\n`);
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}. Shutting down server...`);
    runtime
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));

    setTimeout(() => {
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  assignRoles,
  createAppServer,
  generateCode,
  isValidLobbyCode,
  normalizeCode,
  sanitizeName,
  serializeLobby
};
