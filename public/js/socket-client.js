const socket = io();

const ROLE_META = {
  Storyteller: {
    title: 'Storyteller',
    description: 'Guide the pace from inside the room, spark discussion, and keep everyone reading each other.',
    className: 'role-theme-storyteller',
    glyph: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 7.5A2.5 2.5 0 0 1 8.5 5H18v12H8.5A2.5 2.5 0 0 0 6 19.5z"></path>
        <path d="M6 7.5v12"></path>
        <path d="M10 9.5h5"></path>
        <path d="M10 13h4"></path>
      </svg>
    `
  },
  Killer: {
    title: 'Killer',
    description: 'Direct suspicion elsewhere and remove villagers before the room identifies you.',
    className: 'role-theme-killer',
    glyph: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3l7 4v4c0 5-2.9 8.3-7 10-4.1-1.7-7-5-7-10V7l7-4z"></path>
        <path d="M9.5 10.5c.8-1 1.6-1.5 2.5-1.5s1.7.5 2.5 1.5"></path>
        <path d="M10 14c.8.5 1.4.8 2 .8s1.2-.3 2-.8"></path>
      </svg>
    `
  },
  Doctor: {
    title: 'Doctor',
    description: 'Protect key players and keep the killers from controlling the pace of the game.',
    className: 'role-theme-doctor',
    glyph: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 6V4.5h6V6"></path>
        <path d="M5 8.5h14v9A2.5 2.5 0 0 1 16.5 20h-9A2.5 2.5 0 0 1 5 17.5z"></path>
        <path d="M12 10.5v5"></path>
        <path d="M9.5 13h5"></path>
      </svg>
    `
  },
  Police: {
    title: 'Police',
    description: 'Investigate the table carefully, pressure contradictions, and expose hidden threats before the room turns.',
    className: 'role-theme-police',
    glyph: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3l7 3.5v4.5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6.5z"></path>
        <path d="M12 8v6"></path>
        <path d="M9 11h6"></path>
      </svg>
    `
  },
  Villager: {
    title: 'Villager',
    description: 'Read the table carefully, compare stories, and expose the killers before the room collapses.',
    className: 'role-theme-villager',
    glyph: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9.5L12 5l8 4.5"></path>
        <path d="M6 10.5v7"></path>
        <path d="M10 10.5v7"></path>
        <path d="M14 10.5v7"></path>
        <path d="M18 10.5v7"></path>
        <path d="M3 18.5h18"></path>
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
  requestedDemoMode: false,
  previewPlayerId: null,
  roleConfigSyncTimer: null
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

function hasTestSeats(lobby) {
  return Boolean(lobby && Array.isArray(lobby.players) && lobby.players.some((player) => player.isTestPlayer));
}

function findLobbyPlayer(playerId) {
  if (!state.currentLobby || !Array.isArray(state.currentLobby.players)) {
    return null;
  }

  return state.currentLobby.players.find((player) => player.id === playerId) || null;
}

function findAssignment(playerId) {
  return state.assignments.find((assignment) => assignment.id === playerId) || null;
}

function getRoleConfigInputIds() {
  return ['storytellerCount', 'killerCount', 'policeCount', 'doctorCount'];
}

function sanitizeRoleCount(value, maximum = 12) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, maximum);
}

function readRoleConfigForm() {
  return {
    storytellerCount: sanitizeRoleCount($('storytellerCount')?.value, 1),
    killerCount: sanitizeRoleCount($('killerCount')?.value),
    policeCount: sanitizeRoleCount($('policeCount')?.value),
    doctorCount: sanitizeRoleCount($('doctorCount')?.value)
  };
}

function getRoleMixSummary(roleConfig, playerCount) {
  const storytellerCount = sanitizeRoleCount(roleConfig?.storytellerCount, 1);
  const killerCount = sanitizeRoleCount(roleConfig?.killerCount);
  const policeCount = sanitizeRoleCount(roleConfig?.policeCount);
  const doctorCount = sanitizeRoleCount(roleConfig?.doctorCount);
  const specialRoleCount = storytellerCount + killerCount + policeCount + doctorCount;

  return {
    storytellerCount,
    killerCount,
    policeCount,
    doctorCount,
    specialRoleCount,
    villagerCount: playerCount - specialRoleCount
  };
}

function renderRoleConfigurator(lobby) {
  const summaryLabel = $('roleConfigSummary');
  const hintLabel = $('roleConfigHint');
  if (!summaryLabel || !hintLabel || !lobby || !lobby.roleConfig) return;

  const inputIds = getRoleConfigInputIds();
  inputIds.forEach((id) => {
    const input = $(id);
    if (!input) return;
    const nextValue = String(lobby.roleConfig[id]);
    if (input.value !== nextValue) {
      input.value = nextValue;
    }
  });

  const displaySeatCount = lobby.roleConfigCustomized
    ? lobby.playerCount
    : Math.max(lobby.playerCount, lobby.minimumPlayers);
  const summary = getRoleMixSummary(lobby.roleConfig, displaySeatCount);

  summaryLabel.textContent =
    `${summary.storytellerCount} storyteller, ${summary.killerCount} killer${summary.killerCount === 1 ? '' : 's'}, ` +
    `${summary.policeCount} police, ${summary.doctorCount} doctor${summary.doctorCount === 1 ? '' : 's'}, ` +
    `${Math.max(summary.villagerCount, 0)} villager${Math.max(summary.villagerCount, 0) === 1 ? '' : 's'}`;

  if (lobby.playerCount < lobby.minimumPlayers) {
    hintLabel.textContent = `Suggested mix shown for ${lobby.minimumPlayers} seats. Add ${Math.max(lobby.minimumPlayers - lobby.connectedPlayers, 0)} more connected player(s) to start.`;
    hintLabel.classList.remove('role-config-warning');
    return;
  }

  const liveSummary = getRoleMixSummary(lobby.roleConfig, lobby.playerCount);
  if (liveSummary.villagerCount < 0) {
    hintLabel.textContent = `This mix needs ${Math.abs(liveSummary.villagerCount)} more seated player(s), or fewer special roles.`;
    hintLabel.classList.add('role-config-warning');
    return;
  }

  hintLabel.textContent = lobby.roleConfigCustomized
    ? `Villagers fill the remaining ${liveSummary.villagerCount} seat(s).`
    : `Suggested mix adapts automatically until you edit it. ${liveSummary.villagerCount} villager seat(s) will auto-fill.`;
  hintLabel.classList.toggle('role-config-warning', false);
}

function syncRoleConfigFromForm() {
  if (!state.currentLobbyCode) return;

  socket.emit(
    'update-role-config',
    {
      code: state.currentLobbyCode,
      roleConfig: readRoleConfigForm()
    },
    (data) => {
      if (data && data.error) {
        showToast(data.error, 'error');
      }
    }
  );
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
        ? isAdminView
          ? `<button class="seat-pill seat-pill-test seat-preview-trigger" type="button" data-preview-player="${escapeHtml(player.id)}">Test Seat</button>`
          : '<span class="seat-pill seat-pill-test">Test seat</span>'
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

function getScopedId(prefix, baseId) {
  if (!prefix) return baseId;
  return `${prefix}${baseId.charAt(0).toUpperCase()}${baseId.slice(1)}`;
}

function updateRoleCard(role, prefix = '') {
  const meta = ROLE_META[role] || ROLE_META.Villager;
  const roleBack = $(getScopedId(prefix, 'roleCardBack'));
  const roleGlyph = $(getScopedId(prefix, 'roleGlyph'));
  const roleName = $(getScopedId(prefix, 'roleName'));
  const roleDesc = $(getScopedId(prefix, 'roleDesc'));
  const roleGlyphFront = $(getScopedId(prefix, 'roleGlyphFront'));
  const flipCard = $(getScopedId(prefix, 'roleCardFlip'));
  const toggleButton = $(getScopedId(prefix, 'toggleRoleBtn'));

  if (!roleBack || !roleGlyph || !roleName || !roleDesc || !flipCard || !toggleButton) return;

  roleBack.className = `role-card-back ${meta.className}`;
  roleGlyph.innerHTML = meta.glyph;
  roleName.textContent = meta.title;
  roleDesc.textContent = meta.description;
  if (roleGlyphFront) roleGlyphFront.textContent = '?';
  flipCard.classList.remove('flipped');
  toggleButton.textContent = 'Reveal Role';
}

function setRoleCardFlipped(forceValue, prefix = '') {
  const flipCard = $(getScopedId(prefix, 'roleCardFlip'));
  const toggleButton = $(getScopedId(prefix, 'toggleRoleBtn'));
  if (!flipCard || !toggleButton) return;

  const nextValue = typeof forceValue === 'boolean' ? forceValue : !flipCard.classList.contains('flipped');
  flipCard.classList.toggle('flipped', nextValue);
  toggleButton.textContent = nextValue ? 'Hide Role' : 'Reveal Role';
}

function bindRoleControls(prefix = '') {
  const flipCard = $(getScopedId(prefix, 'roleCardFlip'));
  const toggleButton = $(getScopedId(prefix, 'toggleRoleBtn'));
  if (!flipCard || !toggleButton || flipCard.dataset.bound === 'true') return;

  flipCard.dataset.bound = 'true';

  flipCard.addEventListener('click', () => {
    setRoleCardFlipped(undefined, prefix);
  });

  toggleButton.addEventListener('click', () => {
    setRoleCardFlipped(undefined, prefix);
  });
}

function setSeatPreviewStage(stage) {
  const stages = {
    waiting: $('seatPreviewWaitingStage'),
    role: $('seatPreviewRoleStage'),
    unavailable: $('seatPreviewUnavailableStage')
  };

  Object.entries(stages).forEach(([name, node]) => {
    if (!node) return;
    node.classList.toggle('hidden', name !== stage);
  });
}

function renderSeatPreviewUnavailable(title, message) {
  const overlay = $('seatPreviewOverlay');
  if (!overlay) return;

  overlay.classList.remove('hidden');
  $('seatPreviewTitle').textContent = 'Test Seat Preview';
  $('seatPreviewMessage').textContent = 'The selected mock seat is no longer available to inspect.';
  $('seatPreviewUnavailableTitle').textContent = title;
  $('seatPreviewUnavailableMessage').textContent = message;
  setSeatPreviewStage('unavailable');
}

function closeSeatPreview() {
  const overlay = $('seatPreviewOverlay');
  state.previewPlayerId = null;
  setRoleCardFlipped(false, 'seatPreview');
  setSeatPreviewStage('waiting');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

function syncSeatPreview() {
  const overlay = $('seatPreviewOverlay');
  if (!overlay || !state.previewPlayerId) return;

  const lobby = state.currentLobby;
  const player = findLobbyPlayer(state.previewPlayerId);

  if (!lobby || !player || !player.isTestPlayer) {
    renderSeatPreviewUnavailable(
      'This test seat is no longer active.',
      'Clear the overlay and choose another mock seat from the roster.'
    );
    return;
  }

  const connectedPlayers = typeof lobby.connectedPlayers === 'number'
    ? lobby.connectedPlayers
    : (lobby.players || []).filter((entry) => entry.connected).length;
  const assignment = findAssignment(player.id);

  overlay.classList.remove('hidden');
  $('seatPreviewTitle').textContent = `Viewing ${player.name}`;
  $('seatPreviewMessage').textContent = assignment && assignment.role
    ? `This mirrors ${player.name}'s test role reveal exactly as a mock player would see it.`
    : `This mirrors ${player.name}'s waiting-room view before the table is dealt roles.`;
  $('seatPreviewPlayerName').textContent = player.name;
  $('seatPreviewCode').textContent = lobby.code;
  $('seatPreviewPlayerCountSummary').textContent = `${connectedPlayers} connected / ${lobby.playerCount} total`;
  $('seatPreviewTableSummary').textContent = lobby.rolesAssigned
    ? 'Roles are locked for this mock table.'
    : connectedPlayers >= lobby.minimumPlayers
      ? 'The table is ready. Waiting for the storyteller to deal roles.'
      : `Waiting for ${Math.max(lobby.minimumPlayers - connectedPlayers, 0)} more connected player(s).`;
  $('seatPreviewRoster').innerHTML = renderRoster(lobby.players || [], false);
  setSignalPill(
    $('seatPreviewStorytellerStatus'),
    lobby.adminConnected ? 'Storyteller online' : 'Storyteller reconnecting',
    !lobby.adminConnected
  );

  if (assignment && assignment.role) {
    $('seatPreviewRoleTitle').textContent = `${player.name}'s role card`;
    updateRoleCard(assignment.role, 'seatPreview');
    setSeatPreviewStage('role');
    return;
  }

  setRoleCardFlipped(false, 'seatPreview');
  setSeatPreviewStage('waiting');
}

function openSeatPreview(playerId) {
  state.previewPlayerId = playerId;
  syncSeatPreview();
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
      const roleSummary = getRoleMixSummary(lobby.roleConfig || {}, lobby.playerCount);
      $('rosterHint').textContent = lobby.rolesAssigned
        ? 'Players can reconnect to their assigned roles.'
        : connectedPlayers < lobby.minimumPlayers
          ? `Need ${lobby.minimumPlayers} connected players to assign roles.`
        : roleSummary.villagerCount < 0
          ? `Reduce special roles or seat ${Math.abs(roleSummary.villagerCount)} more player(s) before assigning.`
        : 'Table is ready for role assignment.';
    }
    setSignalPill(
      $('hostStatusPill'),
      lobby.adminConnected ? 'Storyteller online' : 'Storyteller reconnecting',
      !lobby.adminConnected
    );

    const assignButton = $('assignRolesBtn');
    const clearTestGameButton = $('clearTestGameBtn');
    const resetButton = $('resetBtn');
    const roleSummary = getRoleMixSummary(lobby.roleConfig || {}, lobby.playerCount);
    if (assignButton) {
      assignButton.disabled =
        lobby.rolesAssigned ||
        connectedPlayers < lobby.minimumPlayers ||
        roleSummary.villagerCount < 0;
      assignButton.classList.toggle('hidden', lobby.rolesAssigned);
    }
    if (clearTestGameButton) {
      clearTestGameButton.classList.toggle('hidden', !hasTestSeats(lobby));
    }
    if (resetButton) {
      resetButton.classList.toggle('hidden', !lobby.rolesAssigned);
    }

    renderRoleConfigurator(lobby);
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

  syncSeatPreview();
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
  const clearTestGameButton = $('clearTestGameBtn');
  const assignButton = $('assignRolesBtn');
  const resetButton = $('resetBtn');
  const playerList = $('playerList');
  const closeSeatPreviewButton = $('closeSeatPreviewBtn');
  const roleConfigInputs = getRoleConfigInputIds()
    .map((id) => $(id))
    .filter(Boolean);

  state.requestedDemoMode = requestedDemo;
  bindRoleControls('seatPreview');

  if (closeSeatPreviewButton && closeSeatPreviewButton.dataset.bound !== 'true') {
    closeSeatPreviewButton.dataset.bound = 'true';
    closeSeatPreviewButton.addEventListener('click', () => {
      closeSeatPreview();
    });
  }

  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', () => copyText(state.currentLobbyCode, 'Lobby code copied.'));
  }

  if (copyUrlBtn) {
    copyUrlBtn.addEventListener('click', () => copyText(state.joinUrl, 'Invite link copied.'));
  }

  if (roleConfigInputs.length) {
    roleConfigInputs.forEach((input) => {
      if (input.dataset.bound === 'true') return;
      input.dataset.bound = 'true';
      input.addEventListener('input', () => {
        if (state.roleConfigSyncTimer) {
          clearTimeout(state.roleConfigSyncTimer);
        }
        state.roleConfigSyncTimer = setTimeout(() => {
          syncRoleConfigFromForm();
        }, 180);
      });
    });
  }

  function runTestGame({ suppressToast = false } = {}) {
    if (runTestGameButton) {
      setButtonBusy(runTestGameButton, true, 'Loading Demo...');
    }

    socket.emit('run-test-game', {
      code: state.currentLobbyCode,
      roleConfig: readRoleConfigForm()
    }, (data) => {
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

  if (clearTestGameButton) {
    clearTestGameButton.addEventListener('click', () => {
      setButtonBusy(clearTestGameButton, true, 'Clearing...');
      socket.emit('clear-test-game', { code: state.currentLobbyCode }, (data) => {
        setButtonBusy(clearTestGameButton, false, 'Clear Test Game');
        if (data.error) {
          showToast(data.error, 'error');
          return;
        }

        state.assignments = [];
        renderAssignments([]);
        if (data.lobby) {
          updateLobbyState(data.lobby);
        }
        showToast('Test game cleared from the table.', 'info');
      });
    });
  }

  if (assignButton) {
    assignButton.addEventListener('click', () => {
      setButtonBusy(assignButton, true, 'Assigning...');
      socket.emit('assign-roles', {
        code: state.currentLobbyCode,
        roleConfig: readRoleConfigForm()
      }, (data) => {
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
      const previewButton = event.target.closest('[data-preview-player]');
      if (previewButton) {
        openSeatPreview(previewButton.getAttribute('data-preview-player'));
        return;
      }

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

  if (eventType === 'player-kicked' && state.currentPage === 'lobby' && state.previewPlayerId) {
    syncSeatPreview();
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
