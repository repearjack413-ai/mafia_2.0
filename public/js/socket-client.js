const socket = io();

const ROLE_META = {
  Killer: {
    title: 'Killer',
    description: 'Direct suspicion elsewhere and remove villagers before the room identifies you.',
    className: 'role-theme-killer',
    glyph: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4l6 6-9 9-6 1 1-6 8-8z"></path>
        <path d="M13 5l6 6"></path>
      </svg>
    `
  },
  Doctor: {
    title: 'Doctor',
    description: 'Protect key players and keep the killers from controlling the pace of the game.',
    className: 'role-theme-doctor',
    glyph: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14"></path>
        <path d="M5 12h14"></path>
        <path d="M7 3h10v18H7z"></path>
      </svg>
    `
  },
  Villager: {
    title: 'Villager',
    description: 'Read the table carefully, compare stories, and expose the killers before the room collapses.',
    className: 'role-theme-villager',
    glyph: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 18h16"></path>
        <path d="M6 18V9l6-4 6 4v9"></path>
        <path d="M10 18v-4h4v4"></path>
      </svg>
    `
  }
};

const STORAGE_KEYS = {
  admin: 'mafia.admin.session'
};

const state = {
  currentPage: document.body.dataset.page || 'unknown',
  currentLobbyCode: null,
  currentRole: null,
  currentLobby: null,
  joinUrl: '',
  adminSessionId: null,
  playerSessionId: null,
  playerName: '',
  assignments: [],
  hasConnectedOnce: false,
  requestedDemoMode: false
};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

function createToastContainer() {
  let container = document.querySelector('.toast-stack');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-stack';
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message, type = 'info', duration = 3500) {
  const container = createToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

function generateSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getAdminSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.admin) || 'null');
  } catch (error) {
    return null;
  }
}

function setAdminSession(session) {
  localStorage.setItem(STORAGE_KEYS.admin, JSON.stringify(session));
}

function clearAdminSession() {
  localStorage.removeItem(STORAGE_KEYS.admin);
}

function getPlayerStorageKey(code) {
  return `mafia.player.session.${normalizeCode(code)}`;
}

function getPlayerSession(code) {
  try {
    return JSON.parse(localStorage.getItem(getPlayerStorageKey(code)) || 'null');
  } catch (error) {
    return null;
  }
}

function setPlayerSession(code, session) {
  localStorage.setItem(getPlayerStorageKey(code), JSON.stringify(session));
}

function clearPlayerSession(code) {
  if (code) {
    localStorage.removeItem(getPlayerStorageKey(code));
  }
}

function updateUrl(pathname, code) {
  const url = code ? `${pathname}?code=${encodeURIComponent(code)}` : pathname;
  history.replaceState({}, '', url);
}

function copyText(value, successMessage) {
  if (!value) {
    showToast('Nothing to copy yet.', 'warning');
    return;
  }

  navigator.clipboard
    .writeText(value)
    .then(() => showToast(successMessage, 'success'))
    .catch(() => showToast('Clipboard access was blocked on this device.', 'warning'));
}

function setButtonBusy(button, busy, busyLabel) {
  if (!button) return;

  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent.trim();
  }

  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function setSignalPill(element, text, accent = false) {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('signal-pill-warning', accent);
}

function setJoinError(message) {
  const box = $('joinError');
  if (!box) return;
  if (!message) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }

  box.textContent = message;
  box.classList.remove('hidden');
}

function renderResumeButton() {
  const resumeBtn = $('resumeBtn');
  if (!resumeBtn) return;

  const session = getAdminSession();
  if (!session || !session.code) {
    resumeBtn.classList.add('hidden');
    return;
  }

  resumeBtn.classList.remove('hidden');
  resumeBtn.addEventListener('click', () => {
    window.location.href = `/lobby.html?code=${encodeURIComponent(session.code)}`;
  });
}

function renderEmptyLobbyState(title, message) {
  const emptyState = $('lobbyEmptyState');
  if (!emptyState) return;

  emptyState.classList.remove('hidden');
  $('emptyStateTitle').textContent = title;
  $('emptyStateMessage').textContent = message;

  const panels = document.querySelectorAll('.lobby-hero, .lobby-grid, .roles-panel');
  panels.forEach((panel) => panel.classList.add('hidden'));
}

function hideEmptyLobbyState() {
  const emptyState = $('lobbyEmptyState');
  if (!emptyState) return;

  emptyState.classList.add('hidden');
  const panels = document.querySelectorAll('.lobby-hero, .lobby-grid');
  panels.forEach((panel) => panel.classList.remove('hidden'));
}

function renderRoster(players, isAdminView) {
  if (!players.length) {
    return '<li class="empty-roster">No players at the table yet.</li>';
  }

  return players
    .map((player, index) => {
      const statusLabel = player.connected ? 'Connected' : 'Reconnecting';
      const statusClass = player.connected ? 'seat-pill-online' : 'seat-pill-offline';
      const playerTypeTag = player.isTestPlayer
        ? '<span class="seat-pill seat-pill-test">Test seat</span>'
        : '';
      const kickButton = isAdminView
        ? `<button class="seat-action" type="button" data-kick-player="${escapeHtml(player.id)}">Remove</button>`
        : '';

      return `
        <li class="seat-row">
          <div class="seat-main">
            <span class="seat-avatar">${escapeHtml(player.name.charAt(0).toUpperCase())}</span>
            <div>
              <div class="seat-name">${escapeHtml(player.name)}</div>
              <div class="seat-meta">Seat ${index + 1}</div>
            </div>
          </div>
          <div class="seat-aside">
            ${playerTypeTag}
            <span class="seat-pill ${statusClass}">${statusLabel}</span>
            ${kickButton}
          </div>
        </li>
      `;
    })
    .join('');
}

function renderAssignments(assignments) {
  const body = $('rolesTableBody');
  const summary = $('roleSummary');
  const section = $('rolesSection');
  if (!body || !summary || !section) return;

  if (!assignments.length) {
    body.innerHTML = '';
    summary.innerHTML = '';
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  body.innerHTML = assignments
    .map((assignment, index) => {
      const meta = ROLE_META[assignment.role] || ROLE_META.Villager;
      const statusClass = assignment.connected ? 'seat-pill-online' : 'seat-pill-offline';
      const playerType = assignment.isTestPlayer ? '<span class="seat-pill seat-pill-test">Test</span>' : '';
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(assignment.name)}</td>
          <td>${playerType} <span class="seat-pill ${statusClass}">${assignment.connected ? 'Connected' : 'Offline'}</span></td>
          <td><span class="role-tag ${meta.className}">${meta.title}</span></td>
        </tr>
      `;
    })
    .join('');

  const counts = assignments.reduce((accumulator, assignment) => {
    accumulator[assignment.role] = (accumulator[assignment.role] || 0) + 1;
    return accumulator;
  }, {});

  summary.innerHTML = Object.entries(counts)
    .map(([role, count]) => {
      const meta = ROLE_META[role] || ROLE_META.Villager;
      return `<span class="summary-chip ${meta.className}">${count} ${meta.title}${count > 1 ? 's' : ''}</span>`;
    })
    .join('');
}

function updateRoleCard(role) {
  const meta = ROLE_META[role] || ROLE_META.Villager;
  const roleBack = $('roleCardBack');
  const roleGlyph = $('roleGlyph');
  const roleName = $('roleName');
  const roleDesc = $('roleDesc');
  const roleGlyphFront = $('roleGlyphFront');
  const flipCard = $('roleCardFlip');
  const toggleButton = $('toggleRoleBtn');

  if (!roleBack || !roleGlyph || !roleName || !roleDesc || !flipCard || !toggleButton) return;

  roleBack.className = `role-card-back ${meta.className}`;
  roleGlyph.innerHTML = meta.glyph;
  roleName.textContent = meta.title;
  roleDesc.textContent = meta.description;
  if (roleGlyphFront) roleGlyphFront.textContent = '?';
  flipCard.classList.remove('flipped');
  toggleButton.textContent = 'Reveal Role';
}

function setRoleCardFlipped(forceValue) {
  const flipCard = $('roleCardFlip');
  const toggleButton = $('toggleRoleBtn');
  if (!flipCard || !toggleButton) return;

  const nextValue = typeof forceValue === 'boolean' ? forceValue : !flipCard.classList.contains('flipped');
  flipCard.classList.toggle('flipped', nextValue);
  toggleButton.textContent = nextValue ? 'Hide Role' : 'Reveal Role';
}

function bindRoleControls() {
  const flipCard = $('roleCardFlip');
  const toggleButton = $('toggleRoleBtn');
  if (!flipCard || !toggleButton || flipCard.dataset.bound === 'true') return;

  flipCard.dataset.bound = 'true';

  flipCard.addEventListener('click', () => {
    setRoleCardFlipped();
  });

  toggleButton.addEventListener('click', () => {
    setRoleCardFlipped();
  });
}

function setJoinStage(stage) {
  const stages = {
    join: $('joinPage'),
    waiting: $('waitingRoom'),
    role: $('rolePage')
  };

  Object.entries(stages).forEach(([name, node]) => {
    if (!node) return;
    node.classList.toggle('hidden', name !== stage);
  });
}

function updateLobbyState(lobby) {
  if (!lobby) return;

  state.currentLobby = lobby;
  state.currentLobbyCode = lobby.code;

  const connectedPlayers = typeof lobby.connectedPlayers === 'number'
    ? lobby.connectedPlayers
    : (lobby.players || []).filter((player) => player.connected).length;

  if (state.currentPage === 'lobby') {
    hideEmptyLobbyState();

    if ($('lobbyCodeDisplay')) $('lobbyCodeDisplay').textContent = lobby.code;
    if ($('playerCount')) $('playerCount').textContent = String(connectedPlayers);
    if ($('playerCountSummary')) {
      $('playerCountSummary').textContent = `${connectedPlayers} connected / ${lobby.playerCount} total`;
    }
    if ($('tableStateLabel')) {
      $('tableStateLabel').textContent = lobby.rolesAssigned ? 'Roles assigned' : 'Open for seating';
    }
    if ($('rosterHint')) {
      $('rosterHint').textContent = lobby.rolesAssigned
        ? 'Players can reconnect to their assigned roles.'
        : connectedPlayers >= lobby.minimumPlayers
          ? 'Table is ready for role assignment.'
          : `Need ${lobby.minimumPlayers} connected players to assign roles.`;
    }
    setSignalPill(
      $('hostStatusPill'),
      lobby.adminConnected ? 'Storyteller online' : 'Storyteller reconnecting',
      !lobby.adminConnected
    );

    const assignButton = $('assignRolesBtn');
    const resetButton = $('resetBtn');
    if (assignButton) {
      assignButton.disabled = lobby.rolesAssigned || connectedPlayers < lobby.minimumPlayers;
      assignButton.classList.toggle('hidden', lobby.rolesAssigned);
    }
    if (resetButton) {
      resetButton.classList.toggle('hidden', !lobby.rolesAssigned);
    }
  }

  if (state.currentPage === 'join') {
    if ($('joinCodeDisplay')) $('joinCodeDisplay').textContent = lobby.code;
    if ($('playerCountSummary')) {
      $('playerCountSummary').textContent = `${connectedPlayers} connected / ${lobby.playerCount} total`;
    }
    if ($('tableSummary')) {
      $('tableSummary').textContent = lobby.rolesAssigned
        ? 'Roles are locked. Reconnecting players keep their seat.'
        : connectedPlayers >= lobby.minimumPlayers
          ? 'The table is ready. Waiting for the storyteller to deal roles.'
          : `Waiting for ${Math.max(lobby.minimumPlayers - connectedPlayers, 0)} more connected player(s).`;
    }
    setSignalPill(
      $('storytellerStatus'),
      lobby.adminConnected ? 'Storyteller online' : 'Storyteller reconnecting',
      !lobby.adminConnected
    );
  }

  const roster = $('playerList');
  if (roster) {
    roster.innerHTML = renderRoster(lobby.players || [], state.currentPage === 'lobby');
  }
}

function loadQrCode(code) {
  const qrContainer = $('qrContainer');
  const joinUrlDisplay = $('joinUrlDisplay');
  if (!code || !qrContainer || !joinUrlDisplay) return;

  qrContainer.innerHTML = '<div class="qr-loading">Generating secure invite QR...</div>';

  fetch(`/api/qrcode/${encodeURIComponent(code)}`)
    .then((response) => response.json())
    .then((data) => {
      if (!data.qr) {
        throw new Error(data.error || 'QR generation failed');
      }
      state.joinUrl = data.url;
      qrContainer.innerHTML = `<img src="${data.qr}" alt="QR code for joining lobby ${escapeHtml(code)}">`;
      joinUrlDisplay.textContent = data.url;
    })
    .catch((error) => {
      qrContainer.innerHTML = '<div class="qr-loading">Invite QR is temporarily unavailable.</div>';
      joinUrlDisplay.textContent = 'Unable to load invite URL.';
      showToast(error.message || 'Failed to load QR code.', 'error');
    });
}

function handleJoinSuccess(data, fallbackName) {
  const immediateRole = data.role && data.role.role ? data.role.role : null;
  const playerName = fallbackName || state.playerName;

  state.playerSessionId = data.playerSessionId;
  state.playerName = playerName;
  state.currentLobbyCode = data.lobby.code;
  setPlayerSession(data.lobby.code, {
    playerSessionId: data.playerSessionId,
    name: playerName
  });
  updateUrl('/join.html', data.lobby.code);
  updateLobbyState(data.lobby);

  if ($('myNameDisplay')) $('myNameDisplay').textContent = playerName;
  setJoinError('');

  if (immediateRole) {
    state.currentRole = immediateRole;
    updateRoleCard(immediateRole);
    setJoinStage('role');
  } else {
    setJoinStage('waiting');
  }

  showToast(data.restored ? 'Seat restored successfully.' : 'You are now seated at the table.', 'success');
}

function emitJoinRequest(code, name, playerSessionId, silent = false) {
  const joinButton = $('joinBtn');
  const normalizedCode = normalizeCode(code);
  const normalizedName = sanitizeName(name);

  if (!silent) {
    setButtonBusy(joinButton, true, 'Connecting...');
  }

  socket.emit(
    'join-lobby',
    {
      code: normalizedCode,
      name: normalizedName,
      playerSessionId
    },
    (data) => {
      setButtonBusy(joinButton, false, 'Take a Seat');

      if (data.error) {
        if (playerSessionId) {
          clearPlayerSession(normalizedCode);
        }
        if (!silent) {
          setJoinError(data.error);
          showToast(data.error, 'error');
        } else {
          $('joinHint').textContent = 'Previous seat could not be restored. Join again to take a fresh seat.';
        }
        return;
      }

      handleJoinSuccess(data, normalizedName);
    }
  );
}

function initHomePage() {
  renderResumeButton();

  const createButton = $('createBtn');
  const testGameButton = $('testGameBtn');
  if (createButton) {
    createButton.addEventListener('click', () => {
      clearAdminSession();
      window.location.href = '/lobby.html?new=1';
    });
  }

  if (testGameButton) {
    testGameButton.addEventListener('click', () => {
      clearAdminSession();
      window.location.href = '/lobby.html?new=1&demo=1';
    });
  }
}

function handleLobbyCreateOrRestore(data) {
  state.currentLobbyCode = data.code;
  state.adminSessionId = data.adminSessionId;
  state.assignments = data.assignments || [];

  setAdminSession({
    code: data.code,
    adminSessionId: data.adminSessionId
  });

  updateLobbyState(data.lobby);
  renderAssignments(state.assignments);
  loadQrCode(data.code);
  updateUrl('/lobby.html', data.code);
}

function initLobbyPage() {
  const params = new URLSearchParams(window.location.search);
  const requestedCode = normalizeCode(params.get('code'));
  const requestedNew = params.get('new') === '1';
  const requestedDemo = params.get('demo') === '1' || params.get('test') === '1';
  const stored = getAdminSession();

  const copyCodeBtn = $('copyCodeBtn');
  const copyUrlBtn = $('copyUrlBtn');
  const runTestGameButton = $('runTestGameBtn');
  const assignButton = $('assignRolesBtn');
  const resetButton = $('resetBtn');
  const playerList = $('playerList');

  state.requestedDemoMode = requestedDemo;

  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', () => copyText(state.currentLobbyCode, 'Lobby code copied.'));
  }

  if (copyUrlBtn) {
    copyUrlBtn.addEventListener('click', () => copyText(state.joinUrl, 'Invite link copied.'));
  }

  function runTestGame({ suppressToast = false } = {}) {
    if (runTestGameButton) {
      setButtonBusy(runTestGameButton, true, 'Loading Demo...');
    }

    socket.emit('run-test-game', { code: state.currentLobbyCode }, (data) => {
      if (runTestGameButton) {
        setButtonBusy(runTestGameButton, false, 'Run Test Game');
      }

      if (data.error) {
        if (!suppressToast) {
          showToast(data.error, 'error');
        }
        return;
      }

      if (data.lobby) {
        updateLobbyState(data.lobby);
      }
      state.assignments = data.assignments || [];
      renderAssignments(state.assignments);

      if (!suppressToast) {
        showToast('Test game loaded with mock players and roles.', 'success');
      }
    });
  }

  if (runTestGameButton) {
    runTestGameButton.addEventListener('click', () => {
      runTestGame();
    });
  }

  if (assignButton) {
    assignButton.addEventListener('click', () => {
      setButtonBusy(assignButton, true, 'Assigning...');
      socket.emit('assign-roles', { code: state.currentLobbyCode }, (data) => {
        setButtonBusy(assignButton, false, 'Assign Roles');
        if (data.error) {
          showToast(data.error, 'error');
          return;
        }

        state.assignments = data.assignments || [];
        renderAssignments(state.assignments);
        if (state.currentLobby) {
          updateLobbyState({
            ...state.currentLobby,
            rolesAssigned: true
          });
        }
        showToast('Roles assigned. Players can now reveal their cards.', 'success');
      });
    });
  }

  if (resetButton) {
    resetButton.addEventListener('click', () => {
      socket.emit('reset-lobby', { code: state.currentLobbyCode }, (data) => {
        if (data.error) {
          showToast(data.error, 'error');
          return;
        }
        state.assignments = [];
        renderAssignments([]);
        showToast('The table has been reset for a fresh round.', 'info');
      });
    });
  }

  if (playerList) {
    playerList.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-kick-player]');
      if (!actionButton) return;
      const playerId = actionButton.getAttribute('data-kick-player');
      socket.emit('kick-player', { code: state.currentLobbyCode, playerId }, (data) => {
        if (data.error) {
          showToast(data.error, 'error');
          return;
        }
        showToast('Player removed from the table.', 'info');
      });
    });
  }

  function createNewLobby() {
    const adminSessionId = generateSessionId();
    socket.emit('create-lobby', { adminSessionId }, (data) => {
      if (data.error) {
        renderEmptyLobbyState('Unable to create a storyteller session.', data.error);
        return;
      }
      handleLobbyCreateOrRestore(data);
      if (state.requestedDemoMode) {
        showToast('Storyteller table opened. Preparing the test game...', 'info');
        runTestGame({ suppressToast: true });
      } else {
        showToast('New storyteller table opened.', 'success');
      }
    });
  }

  function restoreExistingLobby(code, adminSessionId) {
    socket.emit('restore-lobby', { code, adminSessionId }, (data) => {
      if (data.error) {
        clearAdminSession();
        renderEmptyLobbyState(
          'This storyteller session cannot be restored.',
          'The lobby may have closed, or this browser is not the original storyteller session.'
        );
        showToast(data.error, 'error');
        return;
      }

      handleLobbyCreateOrRestore(data);
      if (state.requestedDemoMode) {
        showToast('Storyteller table restored. Preparing the test game...', 'info');
        runTestGame({ suppressToast: true });
      } else {
        showToast('Storyteller table restored.', 'success');
      }
    });
  }

  if (requestedNew) {
    createNewLobby();
    return;
  }

  if (requestedCode && stored && stored.code === requestedCode && stored.adminSessionId) {
    restoreExistingLobby(requestedCode, stored.adminSessionId);
    return;
  }

  if (!requestedCode && stored && stored.code && stored.adminSessionId) {
    restoreExistingLobby(stored.code, stored.adminSessionId);
    return;
  }

  if (requestedCode) {
    renderEmptyLobbyState(
      'Storyteller credentials are missing.',
      'This URL belongs to an existing table, but this browser does not have the storyteller session needed to manage it.'
    );
    return;
  }

  createNewLobby();
}

function initJoinPage() {
  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = normalizeCode(params.get('code'));
  const joinForm = $('joinForm');

  bindRoleControls();

  if ($('lobbyCode')) {
    $('lobbyCode').value = codeFromUrl;
  }

  if (joinForm) {
    joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = normalizeCode($('lobbyCode').value);
      const name = sanitizeName($('playerName').value);

      if (!code || !name) {
        setJoinError('Enter both the lobby code and your player name.');
        return;
      }

      state.playerName = name;
      emitJoinRequest(code, name, generateSessionId(), false);
    });
  }

  if (codeFromUrl) {
    const stored = getPlayerSession(codeFromUrl);
    if (stored && stored.playerSessionId && stored.name) {
      $('playerName').value = stored.name;
      $('joinHint').textContent = 'Attempting to restore your previous seat on this device.';
      emitJoinRequest(codeFromUrl, stored.name, stored.playerSessionId, true);
    }
  }
}

socket.on('connect', () => {
  if (state.hasConnectedOnce && state.currentPage !== 'home') {
    showToast('Connection restored.', 'success', 2000);
  }
  state.hasConnectedOnce = true;
});

socket.on('disconnect', () => {
  if (state.currentPage !== 'home') {
    showToast('Connection interrupted. Attempting to recover your session.', 'warning');
  }
});

socket.on('lobby-state', (payload) => {
  if (!payload || !payload.code) return;
  if (state.currentLobbyCode && payload.code !== state.currentLobbyCode) return;

  updateLobbyState(payload);

  const eventType = payload.event && payload.event.type;
  if (!eventType) return;

  if (eventType === 'admin-disconnected' && state.currentPage === 'join') {
    showToast('The storyteller is reconnecting to the table.', 'warning');
  }

  if (eventType === 'admin-restored' && state.currentPage === 'join') {
    showToast('The storyteller is back at the table.', 'success');
  }

  if (eventType === 'player-restored' && state.currentPage === 'lobby') {
    showToast(`${payload.event.name} reconnected to their seat.`, 'info');
  }

  if (eventType === 'test-game-ready' && state.currentPage === 'lobby') {
    showToast('Test game is ready to inspect.', 'success');
  }
});

socket.on('role-assigned', (payload) => {
  const role = payload && payload.role;
  if (!role) return;

  state.currentRole = role;
  updateRoleCard(role);
  setJoinStage('role');
  showToast(payload.restored ? 'Your role was restored.' : 'Your role card is ready.', 'success');
});

socket.on('lobby-reset', (payload) => {
  state.currentRole = null;
  state.assignments = [];

  if (payload && payload.lobby) {
    updateLobbyState(payload.lobby);
  }

  renderAssignments([]);

  if (state.currentPage === 'join') {
    setRoleCardFlipped(false);
    setJoinStage('waiting');
    showToast('The storyteller reset the table for a new round.', 'info');
  }
});

socket.on('kicked', (payload) => {
  clearPlayerSession(state.currentLobbyCode);
  const overlay = $('kickedOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
  }
  if ($('kickedMsg')) {
    $('kickedMsg').textContent = payload && payload.message ? payload.message : 'The storyteller removed your seat.';
  }
  showToast('You were removed from the table.', 'error');
});

socket.on('lobby-closed', (payload) => {
  clearPlayerSession(state.currentLobbyCode);
  clearAdminSession();
  const overlay = $('closedOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
  }
  if ($('closedMsg') && payload && payload.message) {
    $('closedMsg').textContent = payload.message;
  }
  showToast('This table is no longer active.', 'error');
});

function init() {
  if (state.currentPage === 'home') {
    initHomePage();
  }

  if (state.currentPage === 'lobby') {
    initLobbyPage();
  }

  if (state.currentPage === 'join') {
    initJoinPage();
  }
}

init();
