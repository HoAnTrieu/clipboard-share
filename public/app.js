/* MyClipboard - frontend */

const $ = (s) => document.querySelector(s);

const t = {
  defaultBoard: 'Clipboard',
  subtitle: 'shared clipboard',
  placeholder: 'Type or paste text here...',
  hint: 'Ctrl+Enter = send \u00a0|\u00a0 Ctrl+V = paste image',
  send: 'Send',
  dropHere: 'Drop image here',
  newTab: '+ New tab',
  deleteTab: 'Delete tab',
  confirmDelete: 'Delete this tab and all its entries?',
  tabNamePrompt: 'New tab name:',
  empty: 'No entries. Paste text or image above.',
  image: 'Image',
  text: 'Text',
  copy: 'Copy',
  download: 'Download',
  delete: 'Delete',
  copied: 'Copied!',
  copyFailed: 'Failed to copy',
  sendError: 'Send error: ',
  deleteError: 'Delete error',
  justNow: 'just now',
  minAgo: ' min ago',
  hrsAgo: ' hrs ago',
  daysAgo: ' days ago',
  connected: 'Connected',
  reconnecting: 'Disconnected \u2013 reconnecting...',
  file: 'File',
  attachFile: 'Attach file',
  uploading: 'Uploading...',
  payloadTooLarge: 'File is too large',
  payloadTooLargeWithLimit: 'File is too large (max %s)',
  pastedImage: 'Pasted image',
  dropHereFiles: 'Drop files here',
  newTabTitle: 'New tab',
  boardNameLabel: 'Name',
  expiresLabel: 'Expires after',
  expiresNever: 'Never',
  expires1h: '1 hour',
  expires24h: '24 hours',
  expires7d: '7 days',
  expires30d: '30 days',
  create: 'Create',
  cancel: 'Cancel',
  expiresIn: 'Expires ',
  notificationNewClip: 'New clip in %s',
  showMore: 'Show more',
  showLess: 'Show less',
  sure: 'Sure?',
  lock: 'Lock',
  unlock: 'Unlock',
  unlockTitle: 'Unlock tab',
  unlockPrompt: 'Type "%s" to unlock:',
  boardLocked: 'Board is locked',
  loginUsername: 'Username',
  loginPassword: 'Password',
  loginBtn: 'Login',
  loginError: 'Invalid username or password',
  logoutBtn: 'Logout',
  adminTitle: 'Admin Panel',
  usersTab: 'Users',
  settingsTab: 'Settings',
  usersListTitle: 'Users',
  addUser: '+ Add User',
  editUser: 'Edit User',
  addUserTitle: 'Add User',
  userRole: 'Role',
  roleUser: 'User',
  roleAdmin: 'Admin',
  save: 'Save',
  edit: 'Edit',
  resetDbTitle: 'Danger Zone',
  resetDbDesc: 'Reset database: delete all boards, clips, and uploaded files.',
  resetDbBtn: 'Reset Database',
  confirmResetDb: 'Are you sure you want to reset the database? This cannot be undone.',
  dbReset: 'Database has been reset',
  backupDb: 'Backup Database',
  clearDefaultBoard: 'Clear Clipboard',
  clearDefaultBoardConfirm: 'Clear all entries from the default Clipboard tab?',
  defaultBoardCleared: 'Clipboard has been cleared',
  tabPassword: 'Password (optional)',
  tabPasswordSet: 'Password protected',
  boardPassword: 'Board Password',
  boardPasswordPrompt: 'This board requires a password',
  enterPassword: 'Enter password',
  unlock: 'Unlock',
};

// --- Auth state ---

let currentUser = null;
let isLoggedIn = false;

// --- API helpers ---

async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  if (!res.ok) {
    let message = '';
    const contentType = res.headers.get('content-type') || '';
    try {
      if (contentType.includes('application/json')) {
        const data = await res.json();
        message = data.error || data.message || '';
      } else {
        message = (await res.text()).trim();
      }
    } catch {}
    if (res.status === 413) {
      const maxSize = message.match(/\(max ([^)]+)\)/i)?.[1];
      message = maxSize
        ? t.payloadTooLargeWithLimit.replace('%s', maxSize)
        : t.payloadTooLarge;
    }
    if (!message) message = res.statusText || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return res.json();
}

// --- Login ---

async function checkSession() {
  try {
    const data = await api('GET', '/auth/me');
    if (data.user) {
      currentUser = data.user;
      isLoggedIn = true;
      return true;
    }
  } catch {}
  return false;
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  if (currentUser && currentUser.role === 'admin') {
    $('#admin-btn').classList.remove('hidden');
  } else {
    $('#admin-btn').classList.add('hidden');
  }
  updateStaticTexts();
  connectWS();
  loadBoards().catch(() => { logout(); showToast('Session error. Please login again.'); });
  loadClips().catch(() => {});
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-username').focus();
}

async function login(username, password) {
  const data = await api('POST', '/auth/login', { username, password });
  currentUser = data.user;
  isLoggedIn = true;
  $('#login-error').classList.add('hidden');
  try {
    showApp();
  } catch (e) {
    console.error('showApp failed:', e);
    showToast('Login succeeded but app failed to load. Refresh the page.');
  }
}

function logout() {
  api('POST', '/auth/logout').catch(() => {});
  currentUser = null;
  isLoggedIn = false;
  if (ws) {
    ws.close();
    ws = null;
  }
  boards = [];
  clips = [];
  renderedClipIds.clear();
  renderedBoardIds.clear();
  showLogin();
}

// --- Dark mode ---

let themeMode = localStorage.getItem('myclipboard-theme') || 'auto';

function applyTheme() {
  if (themeMode === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
  } else {
    document.documentElement.dataset.theme = themeMode;
  }
  updateThemeToggle();
  const isDark = document.documentElement.dataset.theme === 'dark';
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', isDark ? '#1e293b' : '#ffffff');
  });
}

function initTheme() {
  applyTheme();
}

function toggleTheme() {
  const order = ['auto', 'dark', 'light'];
  themeMode = order[(order.indexOf(themeMode) + 1) % 3];
  if (themeMode === 'auto') {
    localStorage.removeItem('myclipboard-theme');
  } else {
    localStorage.setItem('myclipboard-theme', themeMode);
  }
  applyTheme();
}

function updateThemeToggle() {
  const labels = { auto: 'Auto', dark: 'Dark', light: 'Light' };
  const loginToggle = $('#theme-toggle');
  const mainToggle = $('#theme-toggle-main');
  if (loginToggle) loginToggle.textContent = labels[themeMode];
  if (mainToggle) mainToggle.textContent = labels[themeMode];
}

function updateStaticTexts() {
  $('.subtitle').textContent = t.subtitle;
  $('#text-input').placeholder = t.placeholder;
  $('.hint').textContent = t.hint;
  $('#send-btn').textContent = t.send;
  $('.drop-overlay-content p').textContent = t.dropHereFiles;
  $('#file-btn').textContent = t.attachFile;
  $('#modal-title').textContent = t.newTabTitle;
  $('#modal-name-label').textContent = t.boardNameLabel;
  $('#modal-expires-label').textContent = t.expiresLabel;
  $('#modal-cancel').textContent = t.cancel;
  $('#modal-create').textContent = t.create;
  const sel = $('#modal-expires');
  sel.options[0].textContent = t.expiresNever;
  sel.options[1].textContent = t.expires1h;
  sel.options[2].textContent = t.expires24h;
  sel.options[3].textContent = t.expires7d;
  sel.options[4].textContent = t.expires30d;
  $('#logout-btn').title = t.logoutBtn;
  $('#login-subtitle').textContent = t.subtitle;
  $('#login-username-label').textContent = t.loginUsername;
  $('#login-password-label').textContent = t.loginPassword;
  $('#login-btn').textContent = t.loginBtn;
  $('#admin-title').textContent = t.adminTitle;
  const userTabBtn = document.querySelector('.admin-tab[data-tab="users"]');
  const settingsTabBtn = document.querySelector('.admin-tab[data-tab="settings"]');
  if (userTabBtn) userTabBtn.textContent = t.usersTab;
  if (settingsTabBtn) settingsTabBtn.textContent = t.settingsTab;
  $('#users-list-title').textContent = t.usersListTitle;
  $('#add-user-btn').textContent = t.addUser;
  $('#reset-db-title') && ($('#reset-db-title').textContent = t.resetDbTitle);
  $('#reset-db-desc').textContent = t.resetDbDesc;
  $('#reset-db-btn').textContent = t.resetDbBtn;
  $('#backup-db-btn').textContent = t.backupDb;
  $('#clear-default-btn').textContent = t.clearDefaultBoard;
}

// --- State ---

let boards = [];
let currentBoardId = 'default';
let clips = [];
let ws;
const unreadCounts = {};
let hiddenClipCount = 0;
let isDraggingTab = false;
let renderedClipIds = new Set();
let renderedBoardIds = new Set();
const linkPreviewCache = new Map();

// --- Data operations ---

async function loadBoards() {
  boards = await api('GET', '/boards');
  renderedBoardIds = new Set(boards.map(b => b.id));
  renderTabs();
}

async function loadClips() {
  try {
    clips = await api('GET', '/boards/' + currentBoardId + '/clips');
    renderedClipIds.clear();
    renderClips();
  } catch (e) {
    if (e.message.includes('password')) {
      openBoardPasswordModal(currentBoardId);
    }
    throw e;
  }
}

async function sendClip(type, content, originalName) {
  const ghostId = 'ghost-' + Date.now() + Math.random().toString(36).substr(2, 5);
  if (type !== 'text') {
    showGhost(ghostId, originalName || (type === 'image' ? t.image : t.file));
  }
  try {
    const body = { type, content };
    if (originalName) body.originalName = originalName;
    const clip = await api('POST', '/boards/' + currentBoardId + '/clips', body);
    removeGhost(ghostId);
    if (!clips.find(c => c.id === clip.id)) {
      clips.unshift(clip);
      insertClipAnimated(clip);
    }
  } catch (e) {
    removeGhost(ghostId);
    showToast(t.sendError + e.message);
  }
}

function showGhost(ghostId, label) {
  const container = $('#uploading');
  const el = document.createElement('div');
  el.className = 'clip clip-uploading';
  el.id = ghostId;
  const header = document.createElement('div');
  header.className = 'clip-header';
  const name = document.createElement('span');
  name.textContent = label;
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  header.appendChild(name);
  header.appendChild(spinner);
  el.appendChild(header);
  const body = document.createElement('div');
  body.className = 'clip-content uploading-label';
  body.textContent = t.uploading;
  el.appendChild(body);
  container.appendChild(el);
}

function removeGhost(ghostId) {
  const el = document.getElementById(ghostId);
  if (el) el.remove();
}

function animateClipOut(el, callback) {
  el.classList.add('clip-exit');
  el.addEventListener('animationend', callback, { once: true });
}

async function deleteClip(clipId) {
  try {
    await api('DELETE', '/boards/' + currentBoardId + '/clips/' + clipId);
    const el = document.querySelector(`.clip[data-id="${clipId}"]`);
    clips = clips.filter(c => c.id !== clipId);
    if (el) {
      animateClipOut(el, () => {
        renderedClipIds.delete(clipId);
        renderClips();
      });
    } else {
      renderedClipIds.delete(clipId);
      renderClips();
    }
  } catch (e) {
    showToast(t.deleteError);
  }
}

async function createBoard(name, expiresIn, password) {
  const body = { name };
  if (expiresIn) body.expiresIn = Number(expiresIn);
  if (password) body.password = password;
  await api('POST', '/boards', body);
}

function animateTabOut(boardId, callback) {
  callback();
}

async function deleteBoard(boardId) {
  if (!confirm(t.confirmDelete)) return;
  await api('DELETE', '/boards/' + boardId);
}

async function reorderBoard(draggedId, targetId) {
  const fromIdx = boards.findIndex(b => b.id === draggedId);
  const toIdx = boards.findIndex(b => b.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [moved] = boards.splice(fromIdx, 1);
  boards.splice(toIdx, 0, moved);
  renderTabs();
  try {
    await api('PUT', '/boards/reorder', { ids: boards.map(b => b.id) });
  } catch {
    await loadBoards();
  }
}

// --- Link preview ---

async function fetchLinkPreview(url) {
  if (linkPreviewCache.has(url)) return linkPreviewCache.get(url);
  try {
    const res = await fetch('/api/link-preview?url=' + encodeURIComponent(url), { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.title && !data.description) return null;
    linkPreviewCache.set(url, data);
    return data;
  } catch {
    return null;
  }
}

function renderLinkPreviews(content, text) {
  const urls = (text.match(/https?:\/\/[^\s]+/g) || []).slice(0, 3);
  urls.forEach(url => {
    fetchLinkPreview(url).then(preview => {
      if (!preview || !preview.title) return;
      if (content.querySelector(`.link-preview[href="${CSS.escape(url)}"]`)) return;
      const card = document.createElement('a');
      card.className = 'link-preview';
      card.href = url;
      card.target = '_blank';
      card.rel = 'noopener';
      if (preview.image) {
        const img = document.createElement('img');
        img.src = preview.image;
        img.onerror = () => img.remove();
        card.appendChild(img);
      }
      const info = document.createElement('div');
      info.className = 'link-preview-info';
      const title = document.createElement('div');
      title.className = 'link-preview-title';
      title.textContent = preview.title;
      info.appendChild(title);
      if (preview.description) {
        const desc = document.createElement('div');
        desc.className = 'link-preview-desc';
        desc.textContent = preview.description;
        info.appendChild(desc);
      }
      try {
        const domain = document.createElement('div');
        domain.className = 'link-preview-domain';
        domain.textContent = new URL(url).hostname;
        info.appendChild(domain);
      } catch {}
      card.appendChild(info);
      content.appendChild(card);
    });
  });
}

// --- WebSocket ---

let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT_DELAY = 30000;

function connectWS() {
  if (ws) {
    ws.close();
    ws = null;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);

  ws.onopen = () => {
    wsReconnectDelay = 1000;
    $('#status').className = 'status online';
    $('#status').title = t.connected;
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'auth-required':
        logout();
        break;
      case 'db-reset':
        boards = [];
        clips = [];
        renderedClipIds.clear();
        renderedBoardIds.clear();
        loadBoards().then(() => loadClips());
        break;
      case 'clip-added':
        if (msg.boardId === currentBoardId && !clips.find(c => c.id === msg.clip.id)) {
          clips.unshift(msg.clip);
          insertClipAnimated(msg.clip);
        }
        if (msg.boardId !== currentBoardId) {
          unreadCounts[msg.boardId] = (unreadCounts[msg.boardId] || 0) + 1;
          renderTabs();
        }
        if (document.hidden) {
          hiddenClipCount++;
        }
        updateTitle();
        if (document.hidden && Notification.permission === 'granted') {
          const board = boards.find(b => b.id === msg.boardId);
          const boardName = board ? (board.id === 'default' ? t.defaultBoard : board.name) : '';
          const body = t.notificationNewClip.replace('%s', boardName);
          const n = new Notification('MyClipboard', { body, tag: 'myclipboard-' + msg.boardId });
          n.onclick = () => {
            window.focus();
            if (currentBoardId !== msg.boardId) {
              currentBoardId = msg.boardId;
              unreadCounts[msg.boardId] = 0;
              updateTitle();
              renderTabs();
              loadClips();
            }
            n.close();
          };
        }
        break;
      case 'clip-deleted':
        if (msg.boardId === currentBoardId) {
          const clipEl = document.querySelector(`.clip[data-id="${msg.clipId}"]`);
          clips = clips.filter(c => c.id !== msg.clipId);
          if (clipEl) {
            animateClipOut(clipEl, () => {
              renderedClipIds.delete(msg.clipId);
              renderClips();
            });
          } else {
            renderedClipIds.delete(msg.clipId);
            renderClips();
          }
        }
        break;
      case 'board-added':
        if (!boards.find(b => b.id === msg.board.id)) {
          boards.push(msg.board);
          renderTabs();
        }
        break;
      case 'board-updated': {
        const idx = boards.findIndex(b => b.id === msg.board.id);
        if (idx !== -1) boards[idx] = msg.board;
        renderTabs();
        if (msg.board.id === currentBoardId) renderClips();
        break;
      }
      case 'board-deleted':
        animateTabOut(msg.boardId, () => {
          boards = boards.filter(b => b.id !== msg.boardId);
          if (currentBoardId === msg.boardId) {
            currentBoardId = 'default';
            loadClips();
          }
          renderTabs();
        });
        break;
      case 'boards-reordered':
        boards.sort((a, b) => msg.ids.indexOf(a.id) - msg.ids.indexOf(b.id));
        renderTabs();
        break;
    }
  };

  ws.onclose = () => {
    $('#status').className = 'status offline';
    $('#status').title = t.reconnecting;
    setTimeout(() => {
      wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_MAX_RECONNECT_DELAY);
      connectWS();
    }, wsReconnectDelay);
  };

  ws.onerror = () => ws.close();
}

// --- Rendering ---

function renderTabs() {
  const nav = $('#tabs');
  nav.innerHTML = '';

  boards.forEach(board => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (board.id === currentBoardId ? ' active' : '');
    btn.dataset.boardId = board.id;
    btn.draggable = true;

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = board.id === 'default' ? t.defaultBoard : board.name;
    btn.appendChild(label);

    if (board.id !== 'default') {
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (board.locked) return;
        const input = document.createElement('input');
        input.className = 'tab-rename-input';
        input.value = board.name;
        input.size = Math.max(board.name.length, 5);
        btn.replaceChild(input, label);
        input.focus();
        input.select();
        const commit = () => {
          const newName = input.value.trim();
          if (newName && newName !== board.name) {
            api('PUT', '/boards/' + board.id, { name: newName });
          }
          label.textContent = newName || board.name;
          if (input.parentNode === btn) btn.replaceChild(label, input);
        };
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { if (input.parentNode === btn) btn.replaceChild(label, input); }
          ev.stopPropagation();
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', (ev) => ev.stopPropagation());
      });
    }

    if (unreadCounts[board.id] > 0) {
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = unreadCounts[board.id];
      btn.appendChild(badge);
    }

    if (board.passwordHash && !board.unlocked) {
      const lock = document.createElement('span');
      lock.className = 'lock-board';
      lock.textContent = '\uD83D\uDD12';
      lock.title = t.tabPasswordSet;
      btn.appendChild(lock);
    }

    if (board.expiresAt) {
      const tip = boardTooltip(board);
      if (tip) btn.title = tip;
    }

    if (board.id !== 'default') {
      const lock = document.createElement('span');
      lock.className = 'lock-board' + (board.locked ? ' locked' : '');
      lock.textContent = board.locked ? '\uD83D\uDD12' : '\uD83D\uDD13';
      lock.title = board.locked ? t.unlock : t.lock;
      lock.addEventListener('click', (e) => {
        e.stopPropagation();
        if (board.locked) {
          openUnlockModal(board);
        } else {
          api('PUT', '/boards/' + board.id, { locked: true });
        }
      });
      btn.appendChild(lock);
    }

    if (board.id !== 'default' && !board.locked) {
      const del = document.createElement('span');
      del.className = 'delete-board';
      del.textContent = '\u00d7';
      del.title = t.deleteTab;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteBoard(board.id);
      });
      btn.appendChild(del);
    }

    btn.addEventListener('dragstart', (e) => {
      isDraggingTab = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', board.id);
      btn.classList.add('tab-dragging');
    });

    btn.addEventListener('dragend', () => {
      isDraggingTab = false;
      btn.classList.remove('tab-dragging');
      nav.querySelectorAll('.tab-drag-over').forEach(t => t.classList.remove('tab-drag-over'));
    });

    btn.addEventListener('dragover', (e) => {
      if (!isDraggingTab) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      btn.classList.add('tab-drag-over');
    });

    btn.addEventListener('dragleave', () => {
      btn.classList.remove('tab-drag-over');
    });

    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove('tab-drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (!draggedId || draggedId === board.id) return;
      reorderBoard(draggedId, board.id);
    });

    btn.addEventListener('click', () => {
      if (currentBoardId === board.id) return;
      currentBoardId = board.id;
      unreadCounts[board.id] = 0;
      updateTitle();
      renderTabs();
      loadClips();
    });

    nav.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'tab add-tab';
  addBtn.textContent = t.newTab;
  addBtn.addEventListener('click', openNewBoardModal);
  nav.appendChild(addBtn);

  const newBoardIds = new Set(boards.map(b => b.id));
  boards.forEach(board => {
    if (!renderedBoardIds.has(board.id)) {
      const tab = nav.querySelector(`.tab[data-board-id="${board.id}"]`);
      if (tab) tab.classList.add('tab-enter');
    }
  });
  renderedBoardIds = newBoardIds;
}

function expiryLabel(ms) {
  if (ms < 3600000) return Math.round(ms / 60000) + ' min';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h';
  return Math.round(ms / 86400000) + 'd';
}

function boardTooltip(board) {
  if (!board.expiresAt) return '';
  const remaining = board.expiresAt - Date.now();
  if (remaining <= 0) return t.expiresIn + t.justNow;
  return t.expiresIn + expiryLabel(remaining);
}

function createClipElement(clip) {
  const el = document.createElement('div');
  el.className = 'clip';
  el.dataset.id = clip.id;

  const header = document.createElement('div');
  header.className = 'clip-header';
  const typeLabel = document.createElement('span');
  const typeLabels = { image: t.image, file: t.file, text: t.text };
  typeLabel.textContent = typeLabels[clip.type] || clip.type;
  const time = document.createElement('span');
  time.textContent = timeAgo(clip.createdAt);
  time.dataset.ts = clip.createdAt;
  header.appendChild(typeLabel);
  header.appendChild(time);
  el.appendChild(header);

  const content = document.createElement('div');
  content.className = 'clip-content';
  if (clip.type === 'image') {
    const img = document.createElement('img');
    img.src = clip.imageUrl;
    img.alt = t.pastedImage;
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(clip.imageUrl, '_blank'));
    content.appendChild(img);
  } else if (clip.type === 'file') {
    const previewUrl = clip.previewUrl || `${clip.fileUrl}/preview`;
    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = fileIcon(clip.originalName);
    fileInfo.appendChild(icon);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = clip.originalName || 'file';
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'file-size';
    sizeSpan.textContent = formatSize(clip.size);
    fileInfo.appendChild(nameSpan);
    fileInfo.appendChild(sizeSpan);
    content.appendChild(fileInfo);
    const ext = (clip.originalName || '').toLowerCase().split('.').pop();
    if (ext === 'pdf') {
      const embed = document.createElement('embed');
      embed.src = previewUrl;
      embed.type = 'application/pdf';
      embed.className = 'pdf-preview';
      content.appendChild(embed);
    } else if (['mp4', 'webm', 'mov', 'ogg'].includes(ext)) {
      const video = document.createElement('video');
      video.src = previewUrl;
      video.controls = true;
      video.className = 'media-preview';
      content.appendChild(video);
    } else if (['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'].includes(ext)) {
      const audio = document.createElement('audio');
      audio.src = previewUrl;
      audio.controls = true;
      audio.className = 'audio-preview';
      content.appendChild(audio);
    }
  } else {
    const pre = document.createElement('pre');
    pre.innerHTML = linkify(clip.content);
    content.appendChild(pre);
    requestAnimationFrame(() => {
      if (pre.scrollHeight > 400) {
        pre.classList.add('collapsible', 'collapsed');
        const fullHeight = pre.scrollHeight;
        const btn = document.createElement('button');
        btn.className = 'expand-btn';
        btn.textContent = t.showMore;
        btn.addEventListener('click', () => {
          const isCollapsed = pre.classList.contains('collapsed');
          if (isCollapsed) {
            pre.style.maxHeight = fullHeight + 'px';
            pre.classList.remove('collapsed');
            pre.classList.add('expanded');
          } else {
            pre.style.maxHeight = '400px';
            pre.classList.add('collapsed');
            pre.classList.remove('expanded');
          }
          btn.textContent = isCollapsed ? t.showLess : t.showMore;
        });
        content.appendChild(btn);
      }
    });
    renderLinkPreviews(content, clip.content);
  }
  el.appendChild(content);

  const actions = document.createElement('div');
  actions.className = 'clip-actions';

  if (clip.type !== 'file') {
    const copyBtn = document.createElement('button');
    copyBtn.textContent = t.copy;
    copyBtn.addEventListener('click', () => copyClip(clip, copyBtn));
    actions.appendChild(copyBtn);
  }

  if (clip.type === 'image' || clip.type === 'file') {
    const dlBtn = document.createElement('button');
    dlBtn.textContent = t.download;
    dlBtn.addEventListener('click', () => downloadClip(clip));
    actions.appendChild(dlBtn);
  }

  const currentBoard = boards.find(b => b.id === currentBoardId);
  if (!currentBoard || !currentBoard.locked) {
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete';
    delBtn.textContent = t.delete;
    let deleteConfirmTimeout;
    delBtn.addEventListener('click', () => {
      if (delBtn.dataset.confirm) {
        clearTimeout(deleteConfirmTimeout);
        deleteClip(clip.id);
        return;
      }
      delBtn.dataset.confirm = '1';
      delBtn.textContent = t.sure;
      delBtn.classList.add('btn-confirm-active');
      deleteConfirmTimeout = setTimeout(() => {
        delete delBtn.dataset.confirm;
        delBtn.textContent = t.delete;
        delBtn.classList.remove('btn-confirm-active');
      }, 3000);
    });
    actions.appendChild(delBtn);
  }

  el.appendChild(actions);
  return el;
}

function renderClips() {
  const container = $('#clips');

  if (!clips.length) {
    renderedClipIds.clear();
    container.innerHTML = '<div class="empty-state">' + escapeHtml(t.empty) + '</div>';
    return;
  }

  container.innerHTML = '';
  clips.forEach(clip => {
    container.appendChild(createClipElement(clip));
  });
  renderedClipIds = new Set(clips.map(c => c.id));
}

function insertClipAnimated(clip) {
  const container = $('#clips');
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const el = createClipElement(clip);
  el.classList.add('clip-enter');
  container.prepend(el);
  renderedClipIds.add(clip.id);
}

// --- Clip actions ---

async function copyClip(clip, btn) {
  try {
    if (clip.type === 'text') {
      await navigator.clipboard.writeText(clip.content);
    } else {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': fetch(clip.imageUrl, { credentials: 'include' })
            .then(r => r.blob())
            .then(blob => {
              if (blob.type === 'image/png') return blob;
              return createImageBitmap(blob).then(bmp => {
                const c = document.createElement('canvas');
                c.width = bmp.width;
                c.height = bmp.height;
                c.getContext('2d').drawImage(bmp, 0, 0);
                return new Promise(r => c.toBlob(r, 'image/png'));
              });
            })
        })
      ]);
    }
    if (btn) {
      clearTimeout(btn._copyTimeout);
      btn.textContent = '\u2713';
      btn.classList.add('copy-success');
      btn._copyTimeout = setTimeout(() => {
        btn.textContent = t.copy;
        btn.classList.remove('copy-success');
      }, 1500);
    }
  } catch {
    if (clip.type === 'image') {
      window.open(clip.imageUrl, '_blank');
    }
    showToast(t.copyFailed);
  }
}

function downloadClip(clip) {
  const a = document.createElement('a');
  a.href = clip.fileUrl || clip.imageUrl;
  a.download = clip.originalName || clip.filename || 'file';
  a.click();
}

// --- Event handlers ---

document.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData.items);
  const imageItem = items.find(i => i.type.startsWith('image/'));

  if (imageItem) {
    e.preventDefault();
    const blob = imageItem.getAsFile();
    const reader = new FileReader();
    reader.onload = () => sendClip('image', reader.result);
    reader.readAsDataURL(blob);
  }
});

let dragCounter = 0;

function isFileDrag(e) {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

document.addEventListener('dragenter', (e) => {
  if (isDraggingTab || !isFileDrag(e)) return;
  e.preventDefault();
  dragCounter++;
  $('#drop-overlay').classList.add('visible');
});

document.addEventListener('dragleave', (e) => {
  if (isDraggingTab || !isFileDrag(e)) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    $('#drop-overlay').classList.remove('visible');
  }
});

document.addEventListener('dragover', (e) => {
  if (isDraggingTab || !isFileDrag(e)) return;
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  if (isDraggingTab || !isFileDrag(e)) return;
  e.preventDefault();
  dragCounter = 0;
  $('#drop-overlay').classList.remove('visible');

  const files = Array.from(e.dataTransfer.files);
  files.forEach(file => {
    const reader = new FileReader();
    if (file.type.startsWith('image/')) {
      reader.onload = () => sendClip('image', reader.result);
    } else {
      reader.onload = () => sendClip('file', reader.result, file.name);
    }
    reader.readAsDataURL(file);
  });
});

function sendText() {
  const textarea = $('#text-input');
  const text = textarea.value.trim();
  if (!text) return;
  sendClip('text', text);
  textarea.value = '';
  textarea.style.height = 'auto';
}

$('#text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendText();
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + '\t' + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + 1;
  }
});

$('#send-btn').addEventListener('click', sendText);

$('#file-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  files.forEach(file => {
    const reader = new FileReader();
    if (file.type.startsWith('image/')) {
      reader.onload = () => sendClip('image', reader.result);
    } else {
      reader.onload = () => sendClip('file', reader.result, file.name);
    }
    reader.readAsDataURL(file);
  });
  e.target.value = '';
});

$('#text-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 300) + 'px';
});

// --- Utilities ---

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function linkify(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function fileIcon(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  const icons = {
    pdf: '\uD83D\uDCC4', doc: '\uD83D\uDCC4', docx: '\uD83D\uDCC4', odt: '\uD83D\uDCC4',
    xls: '\uD83D\uDCCA', xlsx: '\uD83D\uDCCA', csv: '\uD83D\uDCCA',
    zip: '\uD83D\uDCE6', rar: '\uD83D\uDCE6', '7z': '\uD83D\uDCE6', tar: '\uD83D\uDCE6', gz: '\uD83D\uDCE6',
    mp3: '\uD83C\uDFB5', wav: '\uD83C\uDFB5', ogg: '\uD83C\uDFB5', flac: '\uD83C\uDFB5', aac: '\uD83C\uDFB5', m4a: '\uD83C\uDFB5',
    mp4: '\uD83C\uDFAC', webm: '\uD83C\uDFAC', mov: '\uD83C\uDFAC', avi: '\uD83C\uDFAC',
    png: '\uD83D\uDDBC\uFE0F', jpg: '\uD83D\uDDBC\uFE0F', jpeg: '\uD83D\uDDBC\uFE0F', gif: '\uD83D\uDDBC\uFE0F', svg: '\uD83D\uDDBC\uFE0F', webp: '\uD83D\uDDBC\uFE0F',
    txt: '\uD83D\uDCC3', md: '\uD83D\uDCC3', log: '\uD83D\uDCC3',
    js: '\uD83D\uDCBB', ts: '\uD83D\uDCBB', py: '\uD83D\uDCBB', rb: '\uD83D\uDCBB', go: '\uD83D\uDCBB', rs: '\uD83D\uDCBB', java: '\uD83D\uDCBB', c: '\uD83D\uDCBB', cpp: '\uD83D\uDCBB', h: '\uD83D\uDCBB',
    json: '\uD83D\uDCBB', xml: '\uD83D\uDCBB', yaml: '\uD83D\uDCBB', yml: '\uD83D\uDCBB', toml: '\uD83D\uDCBB',
  };
  return icons[ext] || '\uD83D\uDCC1';
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return t.justNow;
  const min = Math.floor(sec / 60);
  if (min < 60) return min + t.minAgo;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + t.hrsAgo;
  const days = Math.floor(hrs / 24);
  return days + t.daysAgo;
}

function updateTitle() {
  const boardUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
  const total = Math.max(boardUnread, hiddenClipCount);
  document.title = total > 0 ? `(${total}) MyClipboard` : 'MyClipboard';
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// --- New board modal ---

function openNewBoardModal() {
  $('#modal-name').value = '';
  $('#modal-expires').value = '';
  $('#modal-password').value = '';
  $('#modal-password-label').classList.add('hidden');
  $('#new-board-modal').classList.add('visible');
  setTimeout(() => $('#modal-name').focus(), 50);
}

$('#modal-expires').addEventListener('change', () => {
  const isNever = $('#modal-expires').value === '';
  $('#modal-password-label').classList.toggle('hidden', !isNever);
  if (!isNever) $('#modal-password').value = '';
});

function closeNewBoardModal() {
  $('#new-board-modal').classList.remove('visible');
}

$('#modal-cancel').addEventListener('click', closeNewBoardModal);

$('#new-board-modal').addEventListener('click', (e) => {
  if (e.target === $('#new-board-modal')) closeNewBoardModal();
});

$('#modal-create').addEventListener('click', () => {
  const name = $('#modal-name').value.trim();
  if (!name) return;
  const expiresIn = $('#modal-expires').value;
  const password = $('#modal-password').value;
  createBoard(name, expiresIn || null, password || null);
  closeNewBoardModal();
});

$('#modal-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#modal-create').click();
  }
  if (e.key === 'Escape') closeNewBoardModal();
});

// --- Board password modal ---

let boardPasswordBoardId = null;

function openBoardPasswordModal(boardId) {
  boardPasswordBoardId = boardId;
  $('#board-password-title').textContent = t.boardPassword;
  $('#board-password-desc').textContent = t.boardPasswordPrompt;
  $('#board-password-input').value = '';
  $('#board-password-error').classList.add('hidden');
  $('#board-password-modal').classList.add('visible');
  setTimeout(() => $('#board-password-input').focus(), 50);
}

function closeBoardPasswordModal() {
  $('#board-password-modal').classList.remove('visible');
  boardPasswordBoardId = null;
}

$('#board-password-cancel').addEventListener('click', closeBoardPasswordModal);

$('#board-password-modal').addEventListener('click', (e) => {
  if (e.target === $('#board-password-modal')) closeBoardPasswordModal();
});

$('#board-password-submit').addEventListener('click', async () => {
  if (!boardPasswordBoardId) return;
  const password = $('#board-password-input').value;
  if (!password) return;
  $('#board-password-error').classList.add('hidden');
  try {
    await api('PUT', '/boards/' + boardPasswordBoardId, { unlock: true, password });
    closeBoardPasswordModal();
    loadClips().catch(() => {});
  } catch (e) {
    $('#board-password-error').textContent = e.message || 'Invalid password';
    $('#board-password-error').classList.remove('hidden');
    $('#board-password-input').value = '';
    $('#board-password-input').focus();
  }
});

$('#board-password-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#board-password-submit').click();
  }
  if (e.key === 'Escape') closeBoardPasswordModal();
});

// --- Unlock modal ---

let unlockBoardId = null;

function openUnlockModal(board) {
  unlockBoardId = board.id;
  $('#unlock-title').textContent = t.unlockTitle;
  $('#unlock-prompt').textContent = t.unlockPrompt.replace('%s', board.name);
  $('#unlock-input').value = '';
  $('#unlock-input').dataset.expected = board.name;
  $('#unlock-confirm').disabled = true;
  $('#unlock-confirm').textContent = t.unlock;
  $('#unlock-cancel').textContent = t.cancel;
  $('#unlock-modal').classList.add('visible');
  setTimeout(() => $('#unlock-input').focus(), 50);
}

function closeUnlockModal() {
  $('#unlock-modal').classList.remove('visible');
  unlockBoardId = null;
}

$('#unlock-cancel').addEventListener('click', closeUnlockModal);

$('#unlock-modal').addEventListener('click', (e) => {
  if (e.target === $('#unlock-modal')) closeUnlockModal();
});

$('#unlock-input').addEventListener('input', () => {
  $('#unlock-confirm').disabled = $('#unlock-input').value !== $('#unlock-input').dataset.expected;
});

$('#unlock-confirm').addEventListener('click', () => {
  if (!unlockBoardId || $('#unlock-confirm').disabled) return;
  api('PUT', '/boards/' + unlockBoardId, { locked: false });
  closeUnlockModal();
});

$('#unlock-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#unlock-confirm').disabled) {
    e.preventDefault();
    $('#unlock-confirm').click();
  }
  if (e.key === 'Escape') closeUnlockModal();
});

// --- Admin panel ---

let adminUsers = [];

function openAdminModal() {
  $('#admin-modal').classList.add('visible');
  switchAdminTab('users');
  loadAdminUsers();
}

function closeAdminModal() {
  $('#admin-modal').classList.remove('visible');
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.admin-tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `admin-${tab}-tab`);
  });
}

async function loadAdminUsers() {
  try {
    adminUsers = await api('GET', '/admin/users');
    renderAdminUsers();
  } catch (e) {
    showToast('Failed to load users');
  }
}

function renderAdminUsers() {
  const container = $('#users-list');
  if (!adminUsers.length) {
    container.innerHTML = '<div class="empty-state" style="padding:24px">No users</div>';
    return;
  }
  container.innerHTML = '';
  adminUsers.forEach(user => {
    const item = document.createElement('div');
    item.className = 'user-item';
    const info = document.createElement('div');
    info.className = 'user-info';
    const username = document.createElement('span');
    username.className = 'username';
    username.textContent = user.username;
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = user.role === 'admin' ? t.roleAdmin : t.roleUser;
    info.appendChild(username);
    info.appendChild(role);
    const actions = document.createElement('div');
    actions.className = 'user-actions';
    if (user.id !== 'admin') {
      const editBtn = document.createElement('button');
      editBtn.textContent = t.edit;
      editBtn.addEventListener('click', () => openUserModal(user));
      actions.appendChild(editBtn);
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-delete-user';
      delBtn.textContent = t.delete;
      delBtn.addEventListener('click', () => deleteUser(user.id));
      actions.appendChild(delBtn);
    }
    item.appendChild(info);
    item.appendChild(actions);
    container.appendChild(item);
  });
}

function openUserModal(user) {
  const isEdit = !!user;
  $('#user-modal-title').textContent = isEdit ? t.editUser : t.addUserTitle;
  $('#user-modal-id').value = user ? user.id : '';
  $('#user-modal-username').value = user ? user.username : '';
  $('#user-modal-password').value = '';
  $('#user-modal-password').placeholder = isEdit ? 'Leave empty to keep current' : '';
  $('#user-modal-role').value = user ? user.role : 'user';
  $('#user-modal-password-label').textContent = isEdit ? 'New Password (optional)' : t.loginPassword;
  $('#user-modal').classList.add('visible');
  setTimeout(() => $('#user-modal-username').focus(), 50);
}

function closeUserModal() {
  $('#user-modal').classList.remove('visible');
}

async function saveUser() {
  const id = $('#user-modal-id').value;
  const username = $('#user-modal-username').value.trim();
  const password = $('#user-modal-password').value;
  const role = $('#user-modal-role').value;
  if (!username) return;
  try {
    const body = { username, role };
    if (password) body.password = password;
    if (id) {
      await api('PUT', '/admin/users/' + id, body);
    } else {
      if (!password) return showToast('Password required');
      await api('POST', '/admin/users', body);
    }
    closeUserModal();
    loadAdminUsers();
  } catch (e) {
    showToast(e.message);
  }
}

async function deleteUser(userId) {
  if (!confirm('Delete this user?')) return;
  try {
    await api('DELETE', '/admin/users/' + userId);
    loadAdminUsers();
  } catch (e) {
    showToast(e.message);
  }
}

async function resetDatabase() {
  if (!confirm(t.confirmResetDb)) return;
  try {
    await api('POST', '/admin/reset-database');
    showToast(t.dbReset);
  } catch (e) {
    showToast(e.message);
  }
}

$('#admin-btn').addEventListener('click', openAdminModal);
$('#admin-close').addEventListener('click', closeAdminModal);
$('#admin-modal').addEventListener('click', (e) => {
  if (e.target === $('#admin-modal')) closeAdminModal();
});
document.querySelectorAll('.admin-tab').forEach(btn => {
  btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab));
});
$('#add-user-btn').addEventListener('click', () => openUserModal(null));
$('#user-modal-cancel').addEventListener('click', closeUserModal);
$('#user-modal').addEventListener('click', (e) => {
  if (e.target === $('#user-modal')) closeUserModal();
});
$('#user-modal-save').addEventListener('click', saveUser);
$('#user-modal-username').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveUser(); }
  if (e.key === 'Escape') closeUserModal();
});
$('#reset-db-btn').addEventListener('click', resetDatabase);

$('#backup-db-btn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/admin/backup';
  a.download = 'clipboard-backup.json';
  a.click();
});

$('#clear-default-btn').addEventListener('click', async () => {
  if (!confirm(t.clearDefaultBoardConfirm)) return;
  try {
    await api('POST', '/admin/clear-default-board');
    showToast(t.defaultBoardCleared);
    loadClips();
  } catch (e) {
    showToast(e.message);
  }
});

// --- Login form ---

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  if (!username || !password) return;
  try {
    await login(username, password);
  } catch {}
});

$('#logout-btn').addEventListener('click', logout);

$('#theme-toggle').addEventListener('click', toggleTheme);

// --- Init ---

initTheme();
updateStaticTexts();

async function init() {
  const loggedIn = await checkSession();
  if (loggedIn) {
    showApp();
  } else {
    showLogin();
  }
}

init();

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    hiddenClipCount = 0;
    updateTitle();
  }
});

setInterval(() => {
  document.querySelectorAll('[data-ts]').forEach(el => {
    el.textContent = timeAgo(Number(el.dataset.ts));
  });
}, 30000);

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeMode === 'auto') applyTheme();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
