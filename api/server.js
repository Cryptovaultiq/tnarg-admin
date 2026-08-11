require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const bodyParser = require('body-parser');
const path = require('path');

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
const SERVER_PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.warn('GITHUB_TOKEN and GITHUB_REPO should be set in env to enable persistent storage. Falling back will not persist.');
}

function githubHeaders() {
  return {
    Authorization: `token ${GITHUB_TOKEN}`,
    'User-Agent': 'grant-api'
  };
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
    const chats = await readChats();
    // chats is object keyed by visitorId => { visitorName, messages: [] }
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

app.get('/applications', async (req, res) => {
  try {
    const apps = await readApplications();
    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/applications/:id', async (req, res) => {
  try {
    const apps = await readApplications();
    const appObj = apps.find(a => a.id === req.params.id);
    if (!appObj) return res.status(404).json({ error: 'Not found' });
    res.json(appObj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new application
app.post('/applications', async (req, res) => {
  try {
    const apps = await readApplications();
    const newApp = req.body;
    if (!newApp.id) newApp.id = 'APP-' + Date.now();
    newApp.submittedAt = newApp.submittedAt || new Date().toISOString();
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
    const apps = await readApplications();
    const idx = apps.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const updated = { ...apps[idx], ...req.body, updatedAt: new Date().toISOString() };
    apps[idx] = updated;
    await writeApplications(apps, `Update application ${updated.id}`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/applications/:id', async (req, res) => {
  try {
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

app.listen(SERVER_PORT, () => console.log(`Grant API listening on ${SERVER_PORT}`));
