require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// CORS support for local frontend testing
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const upload = multer();

// Allow mounting under /admin/api or /api by stripping known prefixes
app.use((req, res, next) => {
  if (req.path.startsWith('/admin/api/')) {
    req.url = req.url.replace(/^\/admin\/api/, '');
  } else if (req.path.startsWith('/api/')) {
    req.url = req.url.replace(/^\/api/, '');
  }
  next();
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // owner/repo
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_COMMITTER_NAME = process.env.GITHUB_COMMITTER_NAME || 'ci-bot';
const GITHUB_COMMITTER_EMAIL = process.env.GITHUB_COMMITTER_EMAIL || 'ci-bot@example.com';
const ADMIN_USERNAME = process.env.VERCEL_ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.VERCEL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_SESSION_SECRET = process.env.VERCEL_ADMIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || 'default-admin-secret';
const VISITOR_SESSION_SECRET = process.env.VERCEL_VISITOR_SESSION_SECRET || process.env.VISITOR_SESSION_SECRET || 'default-visitor-secret';
const SERVER_PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.warn('GITHUB_TOKEN and GITHUB_REPO should be set in env to enable persistent storage. Requests will fail without GitHub storage.');
}

function githubHeaders() {
  return {
    Authorization: `token ${GITHUB_TOKEN}`,
    'User-Agent': 'grant-api'
  };
}

function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function createToken(payload, secret, ttlSeconds = 86400) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const data = `${payload}:${issuedAt}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${Buffer.from(data).toString('base64')}.${signature}`;
}

function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const data = Buffer.from(parts[0], 'base64').toString('utf8');
  const signature = parts[1];
  const expected = crypto.createHmac('sha256', secret).update(data).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const [payload, issuedAtStr, expiresAtStr] = data.split(':');
  const expiresAt = Number(expiresAtStr);
  if (Number.isNaN(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) return null;
  return { payload, issuedAt: Number(issuedAtStr), expiresAt };
}

function getAuthHeader(req) {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  return auth.slice(7).trim();
}

function getAdminFromAuth(req) {
  const token = getAuthHeader(req);
  const verified = verifyToken(token, ADMIN_SESSION_SECRET);
  if (!verified) return null;
  return verified.payload === `${ADMIN_USERNAME}:${ADMIN_PASSWORD}` ? { username: ADMIN_USERNAME } : null;
}

function getVisitorFromAuth(req) {
  const token = getAuthHeader(req);
  const verified = verifyToken(token, VISITOR_SESSION_SECRET);
  if (!verified) return null;
  const visitorId = verified.payload;
  return visitorId;
}

async function getFile(pathInRepo) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return null;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(pathInRepo)}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub getFile failed: ${res.status}`);
  const json = await res.json();
  return json;
}

async function putFile(pathInRepo, contentBuffer, message, sha) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) throw new Error('GITHUB_TOKEN or GITHUB_REPO not set');
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(pathInRepo)}`;
  const body = {
    message: message || `Update ${pathInRepo}`,
    content: contentBuffer.toString('base64'),
    branch: GITHUB_BRANCH,
    committer: { name: GITHUB_COMMITTER_NAME, email: GITHUB_COMMITTER_EMAIL }
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, { method: 'PUT', headers: { ...githubHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub putFile failed ${res.status}: ${txt}`);
  }
  return await res.json();
}

// Helper to read applications.json (path: data/applications.json)
async function readApplications() {
  try {
    const f = await getFile('data/applications.json');
    if (!f) return [];
    const content = Buffer.from(f.content, 'base64').toString('utf8');
    return JSON.parse(content || '[]');
  } catch (err) {
    console.error('readApplications error', err.message);
    return [];
  }
}

// Chat storage helpers (data/chats.json)
async function readChats() {
  try {
    const f = await getFile('data/chats.json');
    if (!f) return {};
    const content = Buffer.from(f.content, 'base64').toString('utf8');
    return JSON.parse(content || '{}');
  } catch (err) {
    console.error('readChats error', err.message);
    return {};
  }
}

async function readVisitors() {
  try {
    const f = await getFile('data/visitors.json');
    if (!f) return [];
    const content = Buffer.from(f.content, 'base64').toString('utf8');
    return JSON.parse(content || '[]');
  } catch (err) {
    console.error('readVisitors error', err.message);
    return [];
  }
}

async function writeVisitors(visitors, message) {
  const pathInRepo = 'data/visitors.json';
  const existing = await getFile(pathInRepo);
  const sha = existing ? existing.sha : undefined;
  const buffer = Buffer.from(JSON.stringify(visitors, null, 2), 'utf8');
  return await putFile(pathInRepo, buffer, message || 'Update visitors', sha);
}

async function writeChats(chats, message) {
  const pathInRepo = 'data/chats.json';
  const existing = await getFile(pathInRepo);
  const sha = existing ? existing.sha : undefined;
  const buffer = Buffer.from(JSON.stringify(chats, null, 2), 'utf8');
  return await putFile(pathInRepo, buffer, message || 'Update chats', sha);
}

// List all chats summary
app.get('/chats', async (req, res) => {
  try {
    const admin = getAdminFromAuth(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    const chats = await readChats();
    const summaries = Object.keys(chats).map(visitorId => {
      const chat = chats[visitorId];
      const messages = chat.messages || [];
      const last = messages.length ? messages[messages.length - 1] : null;
      const unreadCount = messages.filter(m => m.from === 'visitor' && !m.readByAdmin).length;
      return { visitorId, visitorName: chat.visitorName || visitorId, lastMessage: last, unreadCount };
    });
    res.json(summaries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/chats/:visitorId', async (req, res) => {
  try {
    const visitorId = req.params.visitorId;
    const admin = getAdminFromAuth(req);
    const visitorAuthId = getVisitorFromAuth(req);
    if (!admin && visitorAuthId !== visitorId) return res.status(401).json({ error: 'Unauthorized' });
    const chats = await readChats();
    const chat = chats[visitorId] || { visitorName: visitorId, messages: [] };
    res.json(chat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/chats/:visitorId/message', async (req, res) => {
  try {
    const visitorId = req.params.visitorId;
    const { from, text, visitorName } = req.body;
    if (!from || !text) return res.status(400).json({ error: 'from and text required' });
    const visitorAuthId = getVisitorFromAuth(req);
    const admin = getAdminFromAuth(req);
    if (from === 'admin' && !admin) return res.status(401).json({ error: 'Unauthorized' });
    if (from === 'visitor' && visitorAuthId !== visitorId) return res.status(401).json({ error: 'Unauthorized' });
    const chats = await readChats();
    const chat = chats[visitorId] || { visitorName: visitorName || visitorId, messages: [] };
    const message = { from, text, timestamp: new Date().toISOString() };
    if (from === 'visitor') {
      message.readByAdmin = false;
      message.readByVisitor = true;
    } else {
      message.readByAdmin = true;
      message.readByVisitor = false;
    }
    chat.messages.push(message);
    chats[visitorId] = chat;
    await writeChats(chats, `Add chat message for ${visitorId}`);
    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/chats/:visitorId/markRead', async (req, res) => {
  try {
    const visitorId = req.params.visitorId;
    const visitorAuthId = getVisitorFromAuth(req);
    const admin = getAdminFromAuth(req);
    if (!admin && visitorAuthId !== visitorId) return res.status(401).json({ error: 'Unauthorized' });
    const chats = await readChats();
    const chat = chats[visitorId];
    if (!chat) return res.json({ ok: true });
    chat.messages = (chat.messages || []).map(m => ({ ...m, readByAdmin: true }));
    chats[visitorId] = chat;
    await writeChats(chats, `Mark read chat ${visitorId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function writeApplications(apps, message) {
  const pathInRepo = 'data/applications.json';
  const existing = await getFile(pathInRepo);
  const sha = existing ? existing.sha : undefined;
  const buffer = Buffer.from(JSON.stringify(apps, null, 2), 'utf8');
  return await putFile(pathInRepo, buffer, message || 'Update applications', sha);
}

app.post('/auth/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = createToken(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`, ADMIN_SESSION_SECRET, 86400);
  res.json({ token });
});

app.post('/auth/visitor/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const visitors = await readVisitors();
  if (visitors.some(v => v.email === normalizedEmail)) {
    return res.status(400).json({ error: 'Visitor already exists' });
  }
  const newVisitor = {
    id: `VIS-${Date.now()}`,
    name: String(name).trim(),
    email: normalizedEmail,
    passwordHash: hashText(password),
    createdAt: new Date().toISOString()
  };
  visitors.push(newVisitor);
  await writeVisitors(visitors, `Create visitor ${newVisitor.id}`);
  const token = createToken(newVisitor.id, VISITOR_SESSION_SECRET, 86400);
  const safeVisitor = { id: newVisitor.id, name: newVisitor.name, email: newVisitor.email, createdAt: newVisitor.createdAt };
  res.json({ visitor: safeVisitor, token });
});

app.post('/auth/visitor/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const visitors = await readVisitors();
  const visitor = visitors.find(v => v.email === normalizedEmail && v.passwordHash === hashText(password));
  if (!visitor) return res.status(401).json({ error: 'Invalid email or password' });
  const token = createToken(visitor.id, VISITOR_SESSION_SECRET, 86400);
  const safeVisitor = { id: visitor.id, name: visitor.name, email: visitor.email, createdAt: visitor.createdAt };
  res.json({ visitor: safeVisitor, token });
});

app.get('/auth/visitor/me', async (req, res) => {
  const visitorId = getVisitorFromAuth(req);
  if (!visitorId) return res.status(401).json({ error: 'Unauthorized' });
  const visitors = await readVisitors();
  const visitor = visitors.find(v => v.id === visitorId);
  if (!visitor) return res.status(401).json({ error: 'Unauthorized' });
  const safeVisitor = { id: visitor.id, name: visitor.name, email: visitor.email, createdAt: visitor.createdAt };
  res.json({ visitor: safeVisitor });
});

app.get('/applications', async (req, res) => {
  try {
    const apps = await readApplications();
    const admin = getAdminFromAuth(req);
    const visitorId = getVisitorFromAuth(req);
    const requestedVisitorId = req.query.visitorId;
    if (admin) {
      return res.json(apps);
    }
    if (!visitorId || requestedVisitorId !== visitorId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.json(apps.filter(a => a.visitorId === visitorId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/applications/:id', async (req, res) => {
  try {
    const apps = await readApplications();
    const appObj = apps.find(a => a.id === req.params.id);
    if (!appObj) return res.status(404).json({ error: 'Not found' });
    const admin = getAdminFromAuth(req);
    const visitorId = getVisitorFromAuth(req);
    if (admin || visitorId === appObj.visitorId) {
      return res.json(appObj);
    }
    return res.status(401).json({ error: 'Unauthorized' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new application
app.post('/applications', async (req, res) => {
  try {
    const visitorId = getVisitorFromAuth(req);
    if (!visitorId) return res.status(401).json({ error: 'Unauthorized' });
    const visitors = await readVisitors();
    const visitor = visitors.find(v => v.id === visitorId);
    if (!visitor) return res.status(401).json({ error: 'Unauthorized' });
    const apps = await readApplications();
    const newApp = req.body;
    newApp.id = `APP-${Date.now()}`;
    newApp.visitorId = visitor.id;
    newApp.visitorEmail = visitor.email;
    newApp.visitorName = visitor.name;
    newApp.submittedAt = new Date().toISOString();
    newApp.status = newApp.status || 'pending';
    apps.push(newApp);
    await writeApplications(apps, `Add application ${newApp.id}`);
    res.status(201).json(newApp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update application
app.put('/applications/:id', async (req, res) => {
  try {
    const admin = getAdminFromAuth(req);
    const visitorId = getVisitorFromAuth(req);
    const apps = await readApplications();
    const idx = apps.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const existingApp = apps[idx];

    if (!admin) {
      if (!visitorId || visitorId !== existingApp.visitorId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const allowedFields = ['payment', 'messages', 'adminViewed', 'unreadByVisitor'];
      const updatedFields = {};
      for (const key of allowedFields) {
        if (req.body.hasOwnProperty(key)) {
          updatedFields[key] = req.body[key];
        }
      }
      if (!Object.keys(updatedFields).length) {
        return res.status(400).json({ error: 'No allowed fields to update' });
      }
      const updated = { ...existingApp, ...updatedFields, updatedAt: new Date().toISOString() };
      apps[idx] = updated;
      await writeApplications(apps, `Visitor update ${updated.id}`);
      return res.json(updated);
    }

    const updated = { ...existingApp, ...req.body, updatedAt: new Date().toISOString() };
    apps[idx] = updated;
    await writeApplications(apps, `Update application ${updated.id}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/applications/:id', async (req, res) => {
  try {
    const admin = getAdminFromAuth(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    const apps = await readApplications();
    const idx = apps.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    apps.splice(idx, 1);
    await writeApplications(apps, `Delete application ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload raw file to repo/uploads/
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const admin = getAdminFromAuth(req);
    const visitorId = getVisitorFromAuth(req);
    if (!admin && !visitorId) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const originalName = req.file.originalname;
    const safeName = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const pathInRepo = `uploads/${safeName}`;
    await putFile(pathInRepo, req.file.buffer, `Upload ${safeName}`);
    // Raw URL
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${pathInRepo}`;
    res.json({ path: pathInRepo, url: rawUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// simple health
app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(SERVER_PORT, () => console.log(`Grant API listening on ${SERVER_PORT}`));
}

module.exports = app;
