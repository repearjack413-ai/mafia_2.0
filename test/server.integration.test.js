const assert = require('node:assert/strict');
const { io: createClient } = require('socket.io-client');
const { createAppServer } = require('../server');

async function startTestServer(overrides = {}) {
  const runtime = createAppServer({
    port: 0,
    publicAppUrl: 'https://game.example.com',
    playerGraceMs: 80,
    adminGraceMs: 100,
    ...overrides
  });

  const address = await runtime.start({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { runtime, baseUrl };
}

async function connectClient(baseUrl) {
  const socket = createClient(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  });

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  return socket;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

function waitFor(socket, event) {
  return new Promise((resolve) => {
    socket.once(event, resolve);
  });
}

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

async function testQrUrlUsesConfiguredPublicDomain() {
  const { runtime, baseUrl } = await startTestServer();
  const admin = await connectClient(baseUrl);

  try {
    const created = await emitAck(admin, 'create-lobby', { adminSessionId: 'admin-1' });
    assert.equal(created.success, true);

    const response = await fetch(`${baseUrl}/api/qrcode/${created.code}`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.url, `https://game.example.com/join.html?code=${created.code}`);
    assert.match(body.qr, /^data:image\/png;base64,/);
  } finally {
    admin.disconnect();
    await runtime.close();
  }
}

async function testCompleteMultiplayerGameFlow() {
  const { runtime, baseUrl } = await startTestServer();
  const admin = await connectClient(baseUrl);
  const sockets = [];

  try {
    const created = await emitAck(admin, 'create-lobby', { adminSessionId: 'admin-main' });
    assert.equal(created.success, true);

    const names = ['Ava', 'Noah', 'Mia', 'Luca'];
    const roleEvents = [];

    for (const name of names) {
      const socket = await connectClient(baseUrl);
      sockets.push(socket);
      roleEvents.push(waitFor(socket, 'role-assigned'));
      const joined = await emitAck(socket, 'join-lobby', {
        code: created.code,
        name,
        playerSessionId: `player-${name}`
      });
      assert.equal(joined.success, true);
      assert.equal(joined.lobby.playerCount >= 1, true);
    }

    const duplicateSocket = await connectClient(baseUrl);
    sockets.push(duplicateSocket);
    const duplicate = await emitAck(duplicateSocket, 'join-lobby', {
      code: created.code,
      name: 'Ava',
      playerSessionId: 'duplicate-player'
    });
    assert.match(duplicate.error, /already taken/i);

    const assigned = await emitAck(admin, 'assign-roles', { code: created.code });
    assert.equal(assigned.success, true);
    assert.equal(assigned.assignments.length, 4);

    const deliveredRoles = await Promise.all(roleEvents);
    assert.equal(deliveredRoles.length, 4);
    deliveredRoles.forEach((payload) => {
      assert.ok(['Killer', 'Doctor', 'Villager'].includes(payload.role));
    });

    const lateSocket = await connectClient(baseUrl);
    sockets.push(lateSocket);
    const lateJoin = await emitAck(lateSocket, 'join-lobby', {
      code: created.code,
      name: 'Zoe',
      playerSessionId: 'late-player'
    });
    assert.match(lateJoin.error, /cannot join|started/i);

    const reset = await emitAck(admin, 'reset-lobby', { code: created.code });
    assert.equal(reset.success, true);

    const lobbyResponse = await fetch(`${baseUrl}/api/lobby/${created.code}`);
    const lobbyBody = await lobbyResponse.json();
    assert.equal(lobbyBody.rolesAssigned, false);
    assert.equal(lobbyBody.playerCount, 4);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    admin.disconnect();
    await runtime.close();
  }
}

async function testPlayerReconnectRestoresIdentityAndRole() {
  const { runtime, baseUrl } = await startTestServer();
  const admin = await connectClient(baseUrl);
  const playerA = await connectClient(baseUrl);
  const playerB = await connectClient(baseUrl);
  const playerC = await connectClient(baseUrl);
  const playerD = await connectClient(baseUrl);

  try {
    const created = await emitAck(admin, 'create-lobby', { adminSessionId: 'admin-reconnect' });
    const players = [
      ['Rin', playerA, 'player-rin'],
      ['Sol', playerB, 'player-sol'],
      ['Kai', playerC, 'player-kai'],
      ['Uma', playerD, 'player-uma']
    ];

    for (const [name, socket, sessionId] of players) {
      const joined = await emitAck(socket, 'join-lobby', {
        code: created.code,
        name,
        playerSessionId: sessionId
      });
      assert.equal(joined.success, true);
    }

    const playerARoleEvent = waitFor(playerA, 'role-assigned');
    const assigned = await emitAck(admin, 'assign-roles', { code: created.code });
    assert.equal(assigned.success, true);
    const originalRole = (await playerARoleEvent).role;

    playerA.disconnect();

    const reconnectSocket = await connectClient(baseUrl);
    const restoredRoleEvent = waitFor(reconnectSocket, 'role-assigned');
    const restored = await emitAck(reconnectSocket, 'join-lobby', {
      code: created.code,
      name: 'Rin',
      playerSessionId: 'player-rin'
    });

    assert.equal(restored.success, true);
    assert.equal(restored.restored, true);
    assert.equal(restored.lobby.playerCount, 4);

    const restoredRole = await restoredRoleEvent;
    assert.equal(restoredRole.role, originalRole);

    const lobbyResponse = await fetch(`${baseUrl}/api/lobby/${created.code}`);
    const lobbyBody = await lobbyResponse.json();
    assert.equal(lobbyBody.playerCount, 4);
    assert.equal(lobbyBody.players.filter((player) => player.name === 'Rin').length, 1);

    reconnectSocket.disconnect();
  } finally {
    admin.disconnect();
    playerB.disconnect();
    playerC.disconnect();
    playerD.disconnect();
    await runtime.close();
  }
}

async function testAdminRefreshRestoresLobby() {
  const { runtime, baseUrl } = await startTestServer();
  const admin = await connectClient(baseUrl);

  try {
    const created = await emitAck(admin, 'create-lobby', { adminSessionId: 'admin-refresh' });
    assert.equal(created.restored, false);

    admin.disconnect();

    const refreshedAdmin = await connectClient(baseUrl);
    const restored = await emitAck(refreshedAdmin, 'restore-lobby', {
      code: created.code,
      adminSessionId: 'admin-refresh'
    });

    assert.equal(restored.success, true);
    assert.equal(restored.code, created.code);

    refreshedAdmin.disconnect();
  } finally {
    await runtime.close();
  }
}

async function testDisconnectedPlayerIsRemovedAfterGracePeriod() {
  const { runtime, baseUrl } = await startTestServer({ playerGraceMs: 60 });
  const admin = await connectClient(baseUrl);
  const player = await connectClient(baseUrl);

  try {
    const created = await emitAck(admin, 'create-lobby', { adminSessionId: 'admin-cleanup' });
    const joined = await emitAck(player, 'join-lobby', {
      code: created.code,
      name: 'Nora',
      playerSessionId: 'player-nora'
    });
    assert.equal(joined.success, true);

    player.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 120));

    const response = await fetch(`${baseUrl}/api/lobby/${created.code}`);
    const body = await response.json();
    assert.equal(body.playerCount, 0);
  } finally {
    admin.disconnect();
    await runtime.close();
  }
}

async function testLobbyClosesWhenStorytellerDoesNotReturn() {
  const { runtime, baseUrl } = await startTestServer({ adminGraceMs: 70 });
  const admin = await connectClient(baseUrl);
  const player = await connectClient(baseUrl);

  try {
    const created = await emitAck(admin, 'create-lobby', { adminSessionId: 'admin-timeout' });
    const joined = await emitAck(player, 'join-lobby', {
      code: created.code,
      name: 'Iris',
      playerSessionId: 'player-iris'
    });
    assert.equal(joined.success, true);

    const closedEvent = waitFor(player, 'lobby-closed');
    admin.disconnect();

    const closed = await closedEvent;
    assert.match(closed.message, /closed|reconnect/i);

    const response = await fetch(`${baseUrl}/api/lobby/${created.code}`);
    assert.equal(response.status, 404);
  } finally {
    player.disconnect();
    await runtime.close();
  }
}

async function testRunTestGameSeedsMockPlayersAndRejectsHumanMixing() {
  const { runtime, baseUrl } = await startTestServer();
  const admin = await connectClient(baseUrl);
  const humanPlayer = await connectClient(baseUrl);

  try {
    const created = await emitAck(admin, 'create-lobby', { adminSessionId: 'admin-demo' });
    assert.equal(created.success, true);

    const seeded = await emitAck(admin, 'run-test-game', { code: created.code });
    assert.equal(seeded.success, true);
    assert.equal(seeded.lobby.playerCount, 6);
    assert.equal(seeded.assignments.length, 6);
    seeded.assignments.forEach((assignment) => {
      assert.equal(assignment.isTestPlayer, true);
      assert.ok(['Killer', 'Doctor', 'Villager'].includes(assignment.role));
    });

    const reset = await emitAck(admin, 'reset-lobby', { code: created.code });
    assert.equal(reset.success, true);

    const joined = await emitAck(humanPlayer, 'join-lobby', {
      code: created.code,
      name: 'Nina',
      playerSessionId: 'human-nina'
    });
    assert.equal(joined.success, true);

    const denied = await emitAck(admin, 'run-test-game', { code: created.code });
    assert.match(denied.error, /remove real players/i);
  } finally {
    humanPlayer.disconnect();
    admin.disconnect();
    await runtime.close();
  }
}

async function main() {
  await runCase('QR URL uses the configured public app domain', testQrUrlUsesConfiguredPublicDomain);
  await runCase('complete multiplayer game flow assigns roles, blocks duplicate names, and resets cleanly', testCompleteMultiplayerGameFlow);
  await runCase('player reconnect restores identity and role without duplicating the player list', testPlayerReconnectRestoresIdentityAndRole);
  await runCase('admin refresh restores the existing lobby instead of creating a new one', testAdminRefreshRestoresLobby);
  await runCase('disconnected players are removed after the reconnect grace period', testDisconnectedPlayerIsRemovedAfterGracePeriod);
  await runCase('the lobby closes if the storyteller does not return before the grace period ends', testLobbyClosesWhenStorytellerDoesNotReturn);
  await runCase('run test game seeds mock players and refuses to mix with human players', testRunTestGameSeedsMockPlayersAndRejectsHumanMixing);

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
