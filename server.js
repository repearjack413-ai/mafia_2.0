const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory lobby storage
const lobbies = new Map();

// Generate a 6-char lobby code
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return lobbies.has(code) ? generateCode() : code;
}

// Get local network IP
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

const LOCAL_IP = getLocalIP();

function getPublicBaseUrl(req) {
  const explicitBaseUrl = process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL;
  if (explicitBaseUrl) {
    return explicitBaseUrl.replace(/\/$/, '');
  }

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
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

  return `http://localhost:${PORT}`;
}

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    lobbies: lobbies.size
  });
});

// REST: Get lobby info
app.get('/api/lobby/:code', (req, res) => {
  const lobby = lobbies.get(req.params.code.toUpperCase());
  if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
  res.json({
    code: lobby.code,
    players: lobby.players.map((p) => ({ id: p.id, name: p.name })),
    rolesAssigned: lobby.rolesAssigned
  });
});

// REST: Get QR code
app.get('/api/qrcode/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!lobbies.has(code)) return res.status(404).json({ error: 'Lobby not found' });
  const joinURL = `${getPublicBaseUrl(req)}/join.html?code=${encodeURIComponent(code)}`;
  try {
    const dataURL = await QRCode.toDataURL(joinURL, {
      width: 300,
      margin: 2,
      color: { dark: '#e2c168', light: '#1a1a2e' }
    });
    res.json({ qr: dataURL, url: joinURL });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Role assignment logic
function assignRoles(players) {
  const count = players.length;
  const numKillers = Math.max(1, Math.floor(count / 4));
  const numDoctors = count >= 4 ? Math.max(1, Math.floor(count / 5)) : 0;
  const numVillagers = count - numKillers - numDoctors;

  const roles = [];
  for (let i = 0; i < numKillers; i++) roles.push('Killer');
  for (let i = 0; i < numDoctors; i++) roles.push('Doctor');
  for (let i = 0; i < numVillagers; i++) roles.push('Villager');

  // Fisher-Yates shuffle
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
}

// Socket.IO
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Create lobby
  socket.on('create-lobby', (callback) => {
    const code = generateCode();
    const lobby = {
      code,
      adminId: socket.id,
      players: [],
      rolesAssigned: false,
      roles: {}
    };
    lobbies.set(code, lobby);
    socket.join(code);
    console.log(`Lobby ${code} created by ${socket.id}`);
    callback({ code, ip: LOCAL_IP, port: PORT });
  });

  // Join lobby
  socket.on('join-lobby', ({ code, name }, callback) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);

    if (!lobby) return callback({ error: 'Lobby not found. Check the code and try again.' });
    if (lobby.rolesAssigned) return callback({ error: 'Game already started. Cannot join.' });
    if (lobby.players.find((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return callback({ error: 'That name is already taken. Choose a different name.' });
    }

    const player = { id: socket.id, name };
    lobby.players.push(player);
    socket.join(code);
    socket.lobbyCode = code;
    socket.playerName = name;

    console.log(`${name} joined lobby ${code}`);

    // Notify everyone in the lobby
    io.to(code).emit('player-joined', {
      players: lobby.players.map((p) => ({ id: p.id, name: p.name })),
      newPlayer: name
    });

    callback({ success: true, players: lobby.players.map((p) => ({ id: p.id, name: p.name })) });
  });

  // Assign roles (admin only)
  socket.on('assign-roles', ({ code }, callback) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);

    if (!lobby) return callback({ error: 'Lobby not found.' });
    if (lobby.adminId !== socket.id) return callback({ error: 'Only the admin can assign roles.' });
    if (lobby.players.length < 4) return callback({ error: 'Need at least 4 players to assign roles.' });

    const roles = assignRoles(lobby.players);
    lobby.rolesAssigned = true;

    const assignments = {};
    lobby.players.forEach((player, i) => {
      player.role = roles[i];
      assignments[player.id] = roles[i];
    });
    lobby.roles = assignments;

    // Send each player only their own role
    lobby.players.forEach((player) => {
      io.to(player.id).emit('role-assigned', { role: player.role });
    });

    // Send the admin all roles
    const adminView = lobby.players.map((p) => ({ name: p.name, role: p.role }));
    callback({ success: true, assignments: adminView });

    // Notify lobby that roles are assigned
    io.to(code).emit('roles-revealed', {});

    console.log(`Roles assigned in lobby ${code}:`, adminView);
  });

  // Kick player (admin only)
  socket.on('kick-player', ({ code, playerId }, callback) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);

    if (!lobby) return callback({ error: 'Lobby not found.' });
    if (lobby.adminId !== socket.id) return callback({ error: 'Only the admin can kick players.' });

    const idx = lobby.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return callback({ error: 'Player not found.' });

    const kicked = lobby.players.splice(idx, 1)[0];
    io.to(playerId).emit('kicked', { message: 'You have been removed from the lobby.' });

    const playerSocket = io.sockets.sockets.get(playerId);
    if (playerSocket) playerSocket.leave(code);

    io.to(code).emit('player-joined', {
      players: lobby.players.map((p) => ({ id: p.id, name: p.name })),
      newPlayer: null
    });

    callback({ success: true });
    console.log(`${kicked.name} was kicked from lobby ${code}`);
  });

  // Reset lobby (admin only)
  socket.on('reset-lobby', ({ code }, callback) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);

    if (!lobby) return callback({ error: 'Lobby not found.' });
    if (lobby.adminId !== socket.id) return callback({ error: 'Only the admin can reset.' });

    lobby.rolesAssigned = false;
    lobby.roles = {};
    lobby.players.forEach((p) => delete p.role);

    io.to(code).emit('lobby-reset', {
      players: lobby.players.map((p) => ({ id: p.id, name: p.name }))
    });

    callback({ success: true });
    console.log(`Lobby ${code} was reset`);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    for (const [code, lobby] of lobbies) {
      if (lobby.adminId === socket.id) {
        io.to(code).emit('lobby-closed', { message: 'The admin has left. Lobby closed.' });
        lobbies.delete(code);
        console.log(`Lobby ${code} closed (admin left)`);
        break;
      }

      const idx = lobby.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const left = lobby.players.splice(idx, 1)[0];
        io.to(code).emit('player-joined', {
          players: lobby.players.map((p) => ({ id: p.id, name: p.name })),
          newPlayer: null
        });
        console.log(`${left.name} left lobby ${code}`);
        break;
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nMafia Lobby Server running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${LOCAL_IP}:${PORT}\n`);
});

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down server...`);
  io.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
