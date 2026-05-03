const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const FILES_DIR = path.join(DATA_DIR, 'files');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const SAFE_IMAGE_MIME_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);
const IMAGE_EXT_TO_MIME = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);
const INLINE_FILE_MIME_TYPES = new Set([
  'application/pdf',
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
]);
const INLINE_FILE_EXT_TO_MIME = new Map([
  ['pdf', 'application/pdf'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['m4a', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['mov', 'video/quicktime'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
]);
const MAX_LINK_PREVIEW_REDIRECTS = 5;
const DEFAULT_MAX_CLIP_BINARY_BYTES = 1024 * 1024 * 1024; // 1GB
const MAX_CLIP_BINARY_BYTES = (() => {
  const parsed = Number.parseInt(process.env.MAX_CLIP_BINARY_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CLIP_BINARY_BYTES;
})();
const JSON_BODY_LIMIT_BYTES = Math.ceil(MAX_CLIP_BINARY_BYTES * 1.37) + 1024 * 1024;
const SESSION_COOKIE_NAME = 'myclipboard_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const result = hashPassword(password, salt);
  return result.hash === hash;
}

function findClipByFilename(filename) {
  for (const clips of Object.values(store.clips)) {
    const clip = clips.find(item => item.filename === filename);
    if (clip) return clip;
  }
  return null;
}

function safeDownloadName(name, fallback = 'file') {
  return path.basename(String(name || fallback)).replace(/[\r\n"]/g, '_');
}

function setDownloadHeaders(res, { contentType, disposition, filename }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeDownloadName(filename)}"`);
  if (contentType) res.type(contentType);
}

function guessImageMimeType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return IMAGE_EXT_TO_MIME.get(ext) || null;
}

function guessInlineFileMimeType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return INLINE_FILE_EXT_TO_MIME.get(ext) || null;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIdx = -1;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unitIdx]}`;
}

function createFileTooLargeError() {
  const error = new Error(`File too large (max ${formatBytes(MAX_CLIP_BINARY_BYTES)})`);
  error.status = 413;
  return error;
}

function assertWithinUploadLimit(buffer) {
  if (buffer.length > MAX_CLIP_BINARY_BYTES) throw createFileTooLargeError();
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:');
}

function isPrivateAddress(address) {
  if (address.startsWith('::ffff:')) {
    return isPrivateIpv4(address.slice(7));
  }
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

async function assertSafePreviewTarget(urlString) {
  const url = new URL(urlString);
  const hostname = url.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('URL points to a local address');
  }
  if (net.isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error('URL points to a private address');
  }

  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!resolved.length || resolved.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('URL resolves to a private address');
  }

  return url;
}

async function fetchPreviewResponse(urlString, redirectsLeft = MAX_LINK_PREVIEW_REDIRECTS) {
  const url = await assertSafePreviewTarget(urlString);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MyClipboard/1.0 (link-preview)' },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirectsLeft <= 0) throw new Error('Too many redirects');
      const nextUrl = new URL(response.headers.get('location'), url).href;
      return fetchPreviewResponse(nextUrl, redirectsLeft - 1);
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Session store ---

const sessions = new Map();

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function createSession(userId, isAdmin) {
  const token = generateSessionToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId, isAdmin, expiresAt });
  return { token, expiresAt };
}

function deleteSession(token) {
  sessions.delete(token);
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}

setInterval(cleanExpiredSessions, 60 * 60 * 1000);

function parseCookieHeader(header) {
  if (!header) return {};
  const cookies = {};
  header.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.split('=');
    if (name) cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return cookies;
}

// --- Auth middleware ---

function requireAuth(req, res, next) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE_NAME]);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: session.userId, isAdmin: session.isAdmin };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Admin required' });
  next();
}

function optionalAuth(req, res, next) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE_NAME]);
  if (session) {
    req.user = { id: session.userId, isAdmin: session.isAdmin };
  }
  next();
}

function setSessionCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}; Secure=false`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure=false`);
}

// --- Store ---

let store = { boards: [], clips: {}, users: [], defaultAdminPassword: null };

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load store:', e.message);
  }
  if (!store.users) store.users = [];
  if (!store.boards || !store.boards.length) {
    store.boards = [{ id: 'default', name: 'Clipboard', createdAt: Date.now() }];
    store.clips = { default: [] };
    saveStore();
  }
  if (!store.users.length) {
    const defaultPassword = generateId().slice(0, 12);
    const { salt, hash } = hashPassword(defaultPassword);
    const adminUser = {
      id: 'admin',
      username: 'admin',
      passwordHash: hash,
      salt,
      role: 'admin',
      createdAt: Date.now(),
    };
    store.users.push(adminUser);
    store.defaultAdminPassword = defaultPassword;
    saveStore();
    console.log('=== DEFAULT ADMIN ACCOUNT CREATED ===');
    console.log(`Username: admin`);
    console.log(`Password: ${defaultPassword}`);
    console.log('====================================');
  }
}

let saveTimeout;
function saveStore() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const storeToSave = { ...store };
      delete storeToSave.defaultAdminPassword;
      fs.writeFileSync(STORE_FILE, JSON.stringify(storeToSave, null, 2));
    } catch (e) {
      console.error('Failed to save store:', e.message);
    }
  }, 200);
}

loadStore();

// --- Express ---

const app = express();
app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth routes ---

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = store.users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const { token, expiresAt } = createSession(user.id, user.role === 'admin');
  setSessionCookie(res, token, expiresAt - Date.now());
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  deleteSession(cookies[SESSION_COOKIE_NAME]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', optionalAuth, (req, res) => {
  if (!req.user) return res.json({ user: null });
  const user = store.users.find(u => u.id === req.user.id);
  if (!user) return res.json({ user: null });
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

app.put('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short (min 4 chars)' });
  const user = store.users.find(u => u.id === req.user.id);
  if (!user || !verifyPassword(currentPassword, user.salt, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid current password' });
  }
  const { salt, hash } = hashPassword(newPassword);
  user.salt = salt;
  user.passwordHash = hash;
  saveStore();
  res.json({ ok: true });
});

// --- Admin routes ---

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = store.users.map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
  }));
  res.json(users);
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username too short (min 3 chars)' });
  if (password.length < 4) return res.status(400).json({ error: 'Password too short (min 4 chars)' });
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (store.users.find(u => u.username === username)) return res.status(400).json({ error: 'Username already exists' });
  const { salt, hash } = hashPassword(password);
  const user = {
    id: generateId(),
    username,
    passwordHash: hash,
    salt,
    role,
    createdAt: Date.now(),
  };
  store.users.push(user);
  saveStore();
  res.json({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt });
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const user = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === 'admin' && req.body.role && req.body.role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change admin role of primary admin' });
  }
  if (user.id === 'admin' && req.body.username && req.body.username !== 'admin') {
    return res.status(400).json({ error: 'Cannot change username of primary admin' });
  }
  if (req.body.username !== undefined) {
    if (req.body.username.length < 3) return res.status(400).json({ error: 'Username too short (min 3 chars)' });
    if (store.users.find(u => u.username === req.body.username && u.id !== user.id)) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    user.username = req.body.username;
  }
  if (req.body.role !== undefined) {
    if (!['user', 'admin'].includes(req.body.role)) return res.status(400).json({ error: 'Invalid role' });
    user.role = req.body.role;
  }
  if (req.body.password) {
    if (req.body.password.length < 4) return res.status(400).json({ error: 'Password too short (min 4 chars)' });
    const { salt, hash } = hashPassword(req.body.password);
    user.salt = salt;
    user.passwordHash = hash;
  }
  saveStore();
  res.json({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === 'admin') return res.status(400).json({ error: 'Cannot delete primary admin' });
  const user = store.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  store.users = store.users.filter(u => u.id !== id);
  for (const [token, session] of sessions) {
    if (session.userId === id) sessions.delete(token);
  }
  saveStore();
  res.json({ ok: true });
});

app.post('/api/admin/reset-database', requireAuth, requireAdmin, (req, res) => {
  store.boards = [{ id: 'default', name: 'Clipboard', createdAt: Date.now() }];
  store.clips = { default: [] };
  for (const dir of [IMAGES_DIR, FILES_DIR]) {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    } catch {}
  }
  saveStore();
  broadcast({ type: 'db-reset' });
  console.log('Database reset by admin');
  res.json({ ok: true });
});

// --- Boards (protected) ---

app.get('/api/boards', requireAuth, (req, res) => {
  res.json(store.boards);
});

app.post('/api/boards', requireAuth, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const board = { id: generateId(), name, createdAt: Date.now(), expiresAt: null };
  if (req.body.expiresIn && Number(req.body.expiresIn) > 0) {
    board.expiresAt = Date.now() + Number(req.body.expiresIn);
  }
  store.boards.push(board);
  store.clips[board.id] = [];
  saveStore();
  broadcast({ type: 'board-added', board });
  res.json(board);
});

app.put('/api/boards/reorder', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const currentIds = store.boards.map(board => board.id);
  if (ids.length !== currentIds.length) {
    return res.status(400).json({ error: 'ids must include every board exactly once' });
  }
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    return res.status(400).json({ error: 'ids must be unique' });
  }
  const knownIds = new Set(currentIds);
  if (ids.some(id => !knownIds.has(id))) {
    return res.status(400).json({ error: 'ids contain an unknown board' });
  }
  const boardById = new Map(store.boards.map(board => [board.id, board]));
  store.boards = ids.map(id => boardById.get(id));
  saveStore();
  broadcast({ type: 'boards-reordered', ids: store.boards.map(b => b.id) });
  res.json({ ok: true });
});

app.put('/api/boards/:id', requireAuth, (req, res) => {
  const board = store.boards.find(b => b.id === req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  if (req.body.name !== undefined) {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    board.name = name;
  }
  if (req.body.locked !== undefined) {
    board.locked = !!req.body.locked;
  }
  saveStore();
  broadcast({ type: 'board-updated', board });
  res.json(board);
});

function removeBoardData(id) {
  store.boards = store.boards.filter(b => b.id !== id);
  (store.clips[id] || []).forEach(clip => {
    if (clip.type === 'image' && clip.filename) {
      try { fs.unlinkSync(path.join(IMAGES_DIR, clip.filename)); } catch {}
    }
    if (clip.type === 'file' && clip.filename) {
      try { fs.unlinkSync(path.join(FILES_DIR, clip.filename)); } catch {}
    }
  });
  delete store.clips[id];
}

app.delete('/api/boards/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (id === 'default') return res.status(400).json({ error: 'Cannot delete default board' });
  const board = store.boards.find(b => b.id === id);
  if (board && board.locked) return res.status(403).json({ error: 'Board is locked' });
  if (!store.boards.find(b => b.id === id)) return res.status(404).json({ error: 'Board not found' });
  removeBoardData(id);
  saveStore();
  broadcast({ type: 'board-deleted', boardId: id });
  res.json({ ok: true });
});

// --- Clips (protected) ---

app.get('/api/boards/:id/clips', requireAuth, (req, res) => {
  res.json(store.clips[req.params.id] || []);
});

app.post('/api/boards/:id/clips', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!store.clips[id]) return res.status(404).json({ error: 'Board not found' });

  const { type, content } = req.body;
  if (!type || !content) return res.status(400).json({ error: 'type and content required' });

  const clip = { id: generateId(), type, createdAt: Date.now() };

  if (type === 'image') {
    const match = content.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid image data' });
    const mimeType = match[1].toLowerCase();
    const ext = SAFE_IMAGE_MIME_TYPES.get(mimeType);
    if (!ext) return res.status(400).json({ error: 'Unsupported image type' });
    const buffer = Buffer.from(match[2], 'base64');
    assertWithinUploadLimit(buffer);
    const filename = `${clip.id}.${ext}`;
    fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);
    clip.filename = filename;
    clip.mimeType = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
    clip.imageUrl = `/api/images/${filename}`;
  } else if (type === 'file') {
    const match = content.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid file data' });
    const buffer = Buffer.from(match[2], 'base64');
    assertWithinUploadLimit(buffer);
    const originalName = req.body.originalName || 'file';
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${clip.id}_${safeName}`;
    fs.writeFileSync(path.join(FILES_DIR, filename), buffer);
    clip.filename = filename;
    clip.originalName = originalName;
    clip.size = buffer.length;
    clip.mimeType = match[1].toLowerCase();
    clip.fileUrl = `/api/files/${filename}`;
    clip.previewUrl = `/api/files/${filename}/preview`;
  } else {
    clip.content = content;
  }

  store.clips[id].unshift(clip);
  saveStore();
  broadcast({ type: 'clip-added', boardId: id, clip });
  res.json(clip);
});

app.delete('/api/boards/:boardId/clips/:clipId', requireAuth, (req, res) => {
  const { boardId, clipId } = req.params;
  if (!store.clips[boardId]) return res.status(404).json({ error: 'Board not found' });
  const lockedBoard = store.boards.find(b => b.id === boardId);
  if (lockedBoard && lockedBoard.locked) return res.status(403).json({ error: 'Board is locked' });
  const clip = store.clips[boardId].find(c => c.id === clipId);
  if (!clip) return res.status(404).json({ error: 'Clip not found' });
  if (clip.type === 'image' && clip.filename) {
    try { fs.unlinkSync(path.join(IMAGES_DIR, clip.filename)); } catch {}
  }
  if (clip.type === 'file' && clip.filename) {
    try { fs.unlinkSync(path.join(FILES_DIR, clip.filename)); } catch {}
  }
  store.clips[boardId] = store.clips[boardId].filter(c => c.id !== clipId);
  saveStore();
  broadcast({ type: 'clip-deleted', boardId, clipId });
  res.json({ ok: true });
});

// --- File serving (protected) ---

app.get('/api/images/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(IMAGES_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).end();
  const clip = findClipByFilename(filename);
  const mimeType = clip?.mimeType || guessImageMimeType(filename);
  if (!mimeType) return res.status(404).end();
  setDownloadHeaders(res, { contentType: mimeType, disposition: 'inline', filename });
  res.sendFile(filepath);
});

app.get('/api/files/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(FILES_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).end();
  const clip = findClipByFilename(filename);
  setDownloadHeaders(res, {
    contentType: clip?.mimeType || 'application/octet-stream',
    disposition: 'attachment',
    filename: clip?.originalName || filename,
  });
  res.sendFile(filepath);
});

app.get('/api/files/:filename/preview', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(FILES_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).end();
  const clip = findClipByFilename(filename);
  const mimeType = clip?.mimeType || guessInlineFileMimeType(filename);
  if (!mimeType || !INLINE_FILE_MIME_TYPES.has(mimeType)) {
    return res.status(415).json({ error: 'Preview not available' });
  }
  setDownloadHeaders(res, {
    contentType: mimeType,
    disposition: 'inline',
    filename: clip?.originalName || filename,
  });
  res.sendFile(filepath);
});

// Link preview (protected)
app.get('/api/link-preview', requireAuth, async (req, res) => {
  const url = req.query.url;
  if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const response = await fetchPreviewResponse(url);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return res.json({ title: '', description: '', image: '' });
    }
    const text = await response.text();
    const html = text.substring(0, 50000);

    const getMeta = (property) => {
      const r1 = new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
      const m1 = html.match(r1);
      if (m1) return m1[1];
      const r2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i');
      return html.match(r2)?.[1] || '';
    };
    const getMetaName = (name) => {
      const r1 = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
      const m1 = html.match(r1);
      if (m1) return m1[1];
      const r2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
      return html.match(r2)?.[1] || '';
    };
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    const title = decode(getMeta('og:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '');
    const description = decode(getMeta('og:description') || getMetaName('description'));
    let image = getMeta('og:image');
    if (image && !image.startsWith('http')) {
      try { image = new URL(image, url).href; } catch {}
    }

    res.json({
      title: title.substring(0, 200),
      description: description.substring(0, 500),
      image: image || '',
    });
  } catch (error) {
    if (/private address|local address|Too many redirects/i.test(error.message)) {
      return res.status(400).json({ error: 'URL not allowed' });
    }
    res.status(500).json({ error: 'Failed to fetch' });
  }
});

// Error handler
app.use((err, _req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: createFileTooLargeError().message });
  }
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  next(err);
});

// --- HTTP + WebSocket ---

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const wsClients = new Map(); // ws -> session

wss.on('connection', (ws, req) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE_NAME]);
  if (!session) {
    ws.send(JSON.stringify({ type: 'auth-required' }));
    ws.close();
    return;
  }
  wsClients.set(ws, session);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [ws] of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// --- Expiry cleanup (every 60s) ---

setInterval(() => {
  const now = Date.now();
  const expired = store.boards.filter(b => b.expiresAt && now > b.expiresAt);
  if (!expired.length) return;
  expired.forEach(b => {
    console.log(`Board expired: ${b.name} (${b.id})`);
    removeBoardData(b.id);
    broadcast({ type: 'board-deleted', boardId: b.id });
  });
  saveStore();
}, 60000);

// --- Orphan file cleanup on startup ---

function cleanOrphanFiles() {
  const referencedFiles = new Set();
  for (const clips of Object.values(store.clips)) {
    for (const clip of clips) {
      if (clip.filename) referencedFiles.add(clip.filename);
    }
  }

  let removed = 0;
  for (const [dir, label] of [[IMAGES_DIR, 'image'], [FILES_DIR, 'file']]) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!referencedFiles.has(f)) {
        try {
          fs.unlinkSync(path.join(dir, f));
          removed++;
          console.log(`Orphan ${label} removed: ${f}`);
        } catch {}
      }
    }
  }
  if (removed) console.log(`Orphan cleanup: removed ${removed} file(s)`);
}

cleanOrphanFiles();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MyClipboard running at http://0.0.0.0:${PORT}`);
});
