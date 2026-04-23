/* ==========================================
   Socket Client — Mafia Lobby Game
   ========================================== */

const socket = io();

// ---------- Toast Notifications ----------
function createToastContainer() {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
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
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        toast.style.transition = 'all 0.3s ease-out';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ---------- Admin: Create Lobby ----------
let currentLobbyCode = null;

function createLobby() {
    window.location.href = '/lobby.html';
}

// ---------- Admin: Lobby Page Init ----------
if (window.location.pathname === '/lobby.html') {
    initAdminLobby();
}

async function initAdminLobby() {
    // Create a new lobby using this socket connection
    socket.emit('create-lobby', async (data) => {
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        currentLobbyCode = data.code;

        // Update display
        const codeDisplay = document.getElementById('lobbyCodeDisplay');
        if (codeDisplay) codeDisplay.textContent = data.code;

        // Update URL without reload
        history.replaceState(null, '', `/lobby.html?code=${data.code}`);

        // Load QR code
        try {
            const resp = await fetch(`/api/qrcode/${data.code}`);
            const qrData = await resp.json();
            const qrContainer = document.getElementById('qrContainer');
            if (qrContainer) {
                qrContainer.innerHTML = `<img src="${qrData.qr}" alt="QR Code to join lobby" id="qrImage">`;
            }
            const urlDisplay = document.getElementById('joinUrlDisplay');
            if (urlDisplay) urlDisplay.textContent = qrData.url;
        } catch (err) {
            console.error('Failed to load QR code', err);
        }

        // Setup assign button
        const assignBtn = document.getElementById('assignRolesBtn');
        if (assignBtn) {
            assignBtn.addEventListener('click', () => assignRoles(data.code));
        }

        // Setup reset button
        const resetBtn = document.getElementById('resetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => resetLobby(data.code));
        }

        showToast('Lobby created! Share the QR code with players.', 'success');
    });
}

// ---------- Player: Join Lobby ----------
function joinLobby(code, name) {
    const errorDiv = document.getElementById('joinError');

    socket.emit('join-lobby', { code, name }, (data) => {
        if (data.error) {
            if (errorDiv) {
                errorDiv.textContent = data.error;
                errorDiv.classList.remove('hidden');
            }
            showToast(data.error, 'error');
            return;
        }

        // Hide join form, show waiting room
        document.querySelector('.join-page').classList.add('hidden');
        document.getElementById('waitingRoom').classList.remove('hidden');

        // Display name
        document.getElementById('myNameDisplay').textContent = name;

        // Update player list
        updatePlayerList(data.players, false);
        showToast(`Welcome to the game, ${name}!`, 'success');
    });
}

// ---------- Update Player List ----------
function updatePlayerList(players, isAdmin) {
    const list = document.getElementById('playerList');
    const count = document.getElementById('playerCount');
    if (!list) return;

    if (count) count.textContent = players.length;

    if (players.length === 0) {
        list.innerHTML = `
      <li class="empty-state">
        <span class="empty-icon">👻</span>
        <span>Waiting for players to join...</span>
      </li>`;
        return;
    }

    list.innerHTML = players.map((p, i) => {
        const initial = p.name.charAt(0).toUpperCase();
        const kickBtn = isAdmin
            ? `<button class="btn btn-danger kick-btn" data-id="${p.id}" title="Remove player">✕</button>`
            : '';
        return `
      <li>
        <span class="player-name">
          <span class="player-avatar">${initial}</span>
          <span>${escapeHtml(p.name)}</span>
        </span>
        ${kickBtn}
      </li>`;
    }).join('');

    // Attach kick handlers
    if (isAdmin) {
        list.querySelectorAll('.kick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const playerId = btn.dataset.id;
                socket.emit('kick-player', { code: currentLobbyCode, playerId }, (resp) => {
                    if (resp.error) showToast(resp.error, 'error');
                    else showToast('Player removed', 'info');
                });
            });
        });

        // Enable/disable assign button
        const assignBtn = document.getElementById('assignRolesBtn');
        if (assignBtn) {
            assignBtn.disabled = players.length < 4;
        }
    }
}

// ---------- Admin: Assign Roles ----------
function assignRoles(code) {
    const assignBtn = document.getElementById('assignRolesBtn');
    if (assignBtn) {
        assignBtn.disabled = true;
        assignBtn.innerHTML = '<span>⏳ Assigning...</span>';
    }

    socket.emit('assign-roles', { code }, (data) => {
        if (data.error) {
            showToast(data.error, 'error');
            if (assignBtn) {
                assignBtn.disabled = false;
                assignBtn.innerHTML = '<span>🎭 Assign Roles</span>';
            }
            return;
        }

        // Show roles table
        const rolesSection = document.getElementById('rolesSection');
        const rolesBody = document.getElementById('rolesTableBody');
        const resetBtn = document.getElementById('resetBtn');

        if (rolesSection) rolesSection.classList.remove('hidden');
        if (assignBtn) assignBtn.classList.add('hidden');
        if (resetBtn) resetBtn.classList.remove('hidden');

        if (rolesBody) {
            rolesBody.innerHTML = data.assignments.map((a, i) => {
                const roleClass = `tag-${a.role.toLowerCase()}`;
                const emoji = getRoleEmoji(a.role);
                return `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(a.name)}</td>
            <td><span class="role-tag ${roleClass}">${emoji} ${a.role}</span></td>
          </tr>`;
            }).join('');
        }

        // Summary
        const summary = document.getElementById('roleSummary');
        if (summary) {
            const counts = {};
            data.assignments.forEach(a => counts[a.role] = (counts[a.role] || 0) + 1);
            summary.innerHTML = Object.entries(counts).map(([role, c]) => {
                return `<span class="role-summary-item">${getRoleEmoji(role)} ${c} ${role}${c > 1 ? 's' : ''}</span>`;
            }).join('');
        }

        showToast('Roles assigned! All players can now see their roles.', 'success');
    });
}

// ---------- Admin: Reset Lobby ----------
function resetLobby(code) {
    socket.emit('reset-lobby', { code }, (data) => {
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        const rolesSection = document.getElementById('rolesSection');
        const assignBtn = document.getElementById('assignRolesBtn');
        const resetBtn = document.getElementById('resetBtn');

        if (rolesSection) rolesSection.classList.add('hidden');
        if (assignBtn) {
            assignBtn.classList.remove('hidden');
            assignBtn.disabled = false;
            assignBtn.innerHTML = '<span>🎭 Assign Roles</span>';
        }
        if (resetBtn) resetBtn.classList.add('hidden');

        showToast('Lobby reset! You can assign new roles.', 'info');
    });
}

// ---------- Socket Event Listeners ----------

// Player joined - update list everywhere
socket.on('player-joined', (data) => {
    const isAdmin = window.location.pathname === '/lobby.html';
    updatePlayerList(data.players, isAdmin);
    if (data.newPlayer) {
        showToast(`${data.newPlayer} joined the game`, 'info');
    }
});

// Role assigned (player view)
socket.on('role-assigned', (data) => {
    const rolePage = document.getElementById('rolePage');
    const waitingRoom = document.getElementById('waitingRoom');

    if (waitingRoom) waitingRoom.classList.add('hidden');
    if (rolePage) rolePage.classList.remove('hidden');

    // Set role card content
    const roleCardBack = document.getElementById('roleCardBack');
    const roleName = document.getElementById('roleName');
    const roleEmoji = document.getElementById('roleEmoji');
    const roleDesc = document.getElementById('roleDesc');

    if (roleName) roleName.textContent = data.role;
    if (roleEmoji) roleEmoji.textContent = getRoleEmoji(data.role);
    if (roleDesc) roleDesc.textContent = getRoleDescription(data.role);

    // Apply role-specific styling
    if (roleCardBack) {
        roleCardBack.className = `role-card-back role-${data.role.toLowerCase()}-card`;
    }

    // Card flip interaction
    const flipCard = document.getElementById('roleCardFlip');
    const toggleBtn = document.getElementById('toggleRoleBtn');

    if (flipCard) {
        flipCard.addEventListener('click', () => {
            flipCard.classList.toggle('flipped');
            if (toggleBtn) {
                toggleBtn.textContent = flipCard.classList.contains('flipped') ? 'Hide Role' : 'Show Role';
            }
        });
    }

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            if (flipCard) {
                flipCard.classList.toggle('flipped');
                toggleBtn.textContent = flipCard.classList.contains('flipped') ? 'Hide Role' : 'Show Role';
            }
        });
    }
});

// Roles revealed (generic notification)
socket.on('roles-revealed', () => {
    // Handled by role-assigned for players
});

// Lobby reset
socket.on('lobby-reset', (data) => {
    // For players: go back to waiting room
    const rolePage = document.getElementById('rolePage');
    const waitingRoom = document.getElementById('waitingRoom');

    if (rolePage && !rolePage.classList.contains('hidden')) {
        rolePage.classList.add('hidden');
        if (waitingRoom) waitingRoom.classList.remove('hidden');
        showToast('The storyteller is reassigning roles...', 'info');
    }

    // Update player list
    const isAdmin = window.location.pathname === '/lobby.html';
    updatePlayerList(data.players, isAdmin);
});

// Kicked
socket.on('kicked', (data) => {
    const overlay = document.getElementById('kickedOverlay');
    if (overlay) {
        const msg = document.getElementById('kickedMsg');
        if (msg) msg.textContent = data.message;
        overlay.classList.remove('hidden');
    }
    showToast('You have been removed from the lobby', 'error');
});

// Lobby closed
socket.on('lobby-closed', (data) => {
    const overlay = document.getElementById('closedOverlay');
    if (overlay) overlay.classList.remove('hidden');
    showToast('Lobby closed by admin', 'error');
});

// ---------- Helpers ----------
function getRoleEmoji(role) {
    const emojis = { Killer: '🔪', Doctor: '💉', Villager: '🏘️' };
    return emojis[role] || '❓';
}

function getRoleDescription(role) {
    const descs = {
        Killer: 'Eliminate the villagers one by one without getting caught.',
        Doctor: 'Save lives by protecting a player each night.',
        Villager: 'Work together to identify and vote out the killers.'
    };
    return descs[role] || '';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
