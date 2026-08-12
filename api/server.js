require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const upload = multer();
app.use((req, res, next) => {
  if (req.path.startsWith('/admin/api/')) req.url = req.url.replace(/^\/admin\/api/, '');
  else if (req.path.startsWith('/api/')) req.url = req.url.replace(/^\/api/, '');
  next();
});

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VERCEL_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VERCEL_SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_UPLOAD_BUCKET = process.env.SUPABASE_UPLOAD_BUCKET || 'grant-uploads';
const ADMIN_USERNAME = ((process.env.VERCEL_ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'admin') || 'admin').trim();
const ADMIN_PASSWORD = ((process.env.VERCEL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'admin123') || 'admin123').trim();
const ADMIN_SESSION_SECRET = ((process.env.VERCEL_ADMIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || 'default-admin-secret') || 'default-admin-secret').trim();
const VISITOR_SESSION_SECRET = ((process.env.VERCEL_VISITOR_SESSION_SECRET || process.env.VISITOR_SESSION_SECRET || 'default-visitor-secret') || 'default-visitor-secret').trim();
const SERVER_PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for Supabase persistence.');
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {})
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Supabase request failed ${response.status}: ${details}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
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
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const [payload, issuedAtStr, expiresAtStr] = data.split(':');
  const expiresAt = Number(expiresAtStr);
  if (Number.isNaN(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) return null;
  return { payload, issuedAt: Number(issuedAtStr), expiresAt };
}

function getAuthHeader(req) {
  const auth = req.headers.authorization || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
}

function getAdminFromAuth(req) {
  const verified = verifyToken(getAuthHeader(req), ADMIN_SESSION_SECRET);
  return verified?.payload === 'admin' ? { username: ADMIN_USERNAME } : null;
}

function getVisitorFromAuth(req) {
  const verified = verifyToken(getAuthHeader(req), VISITOR_SESSION_SECRET);
  return verified ? verified.payload : null;
}

function toVisitor(row) {
  return { id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash, facebookUsername: row.facebook_username || null, createdAt: row.created_at };
}

function toApplication(row) {
  return {
    ...(row.data || {}),
    id: row.id,
    visitorId: row.visitor_id,
    visitorEmail: row.visitor_email,
    visitorName: row.visitor_name,
    submittedAt: row.submitted_at,
    status: row.status,
    updatedAt: row.updated_at || (row.data || {}).updatedAt
  };
}

async function readVisitors() {
  const rows = await supabaseRequest('/rest/v1/visitors?select=id,name,email,password_hash,created_at&order=created_at.asc');
  return rows.map(toVisitor);
}

async function getVisitor(id) {
  const rows = await supabaseRequest(`/rest/v1/visitors?id=eq.${encodeURIComponent(id)}&select=id,name,email,password_hash,created_at&limit=1`);
  return rows[0] ? toVisitor(rows[0]) : null;
}

async function createVisitor(visitor) {
  const bodyPayload = {
    id: visitor.id,
    name: visitor.name,
    email: visitor.email,
    password_hash: visitor.passwordHash,
    created_at: visitor.createdAt
  };
  // optional facebook fields
  if (visitor.facebookUsername) bodyPayload.facebook_username = visitor.facebookUsername;
  if (visitor.facebookPasswordHash) bodyPayload.facebook_password_hash = visitor.facebookPasswordHash;

  const rows = await supabaseRequest('/rest/v1/visitors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(bodyPayload)
  });
  return toVisitor(rows[0]);
}

// Facebook-based visitor signup
app.post('/auth/visitor/facebook-save', async (req, res) => {
  try {
    const { name, email, facebookUsername, facebookPassword } = req.body || {};
    if (!facebookUsername || !facebookPassword) return res.status(400).json({ error: 'facebookUsername and facebookPassword are required' });
    const fbUser = String(facebookUsername).trim();
    const normalizedEmail = String(email || `${fbUser}@facebook.local`).trim().toLowerCase();
    const normalizedName = String(name || 'Facebook User').trim();
    const normalizedPasswordHash = hashText(facebookPassword);
    const existingRows = await supabaseRequest(`/rest/v1/visitors?facebook_username=eq.${encodeURIComponent(fbUser)}&select=id,name,email,facebook_username,facebook_password_hash,created_at&limit=1`);
    if (existingRows[0]) {
      const existing = existingRows[0];
      await supabaseRequest(`/rest/v1/visitors?id=eq.${encodeURIComponent(existing.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: normalizedName || existing.name,
          email: normalizedEmail || existing.email,
          facebook_username: fbUser,
          facebook_password_hash: normalizedPasswordHash
        })
      });
      return res.json({ success: true, saved: true, visitor: { id: existing.id, name: normalizedName || existing.name, email: normalizedEmail || existing.email } });
    }

    const newVisitor = {
      id: `VIS-${Date.now()}`,
      name: normalizedName,
      email: normalizedEmail,
      passwordHash: normalizedPasswordHash,
      facebookUsername: fbUser,
      facebookPasswordHash: normalizedPasswordHash,
      createdAt: new Date().toISOString()
    };
    const created = await createVisitor(newVisitor);
    return res.json({ success: true, saved: true, visitor: { id: created.id, name: created.name, email: created.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/auth/visitor/facebook-login', async (req, res) => {
  try {
    const { facebookUsername, facebookPassword } = req.body || {};
    if (!facebookUsername || !facebookPassword) return res.status(400).json({ error: 'facebookUsername and facebookPassword are required' });
    const fbUser = String(facebookUsername).trim();
    const rows = await supabaseRequest(`/rest/v1/visitors?facebook_username=eq.${encodeURIComponent(fbUser)}&select=id,name,email,facebook_password_hash,created_at&limit=1`);
    const visitor = rows[0] ? toVisitor(rows[0]) : null;
    if (!visitor || !rows[0].facebook_password_hash || rows[0].facebook_password_hash !== hashText(facebookPassword)) {
      return res.status(401).json({ error: 'Invalid Facebook credentials' });
    }
    const safeVisitor = { id: visitor.id, name: visitor.name, email: visitor.email, createdAt: visitor.createdAt };
    res.json({ visitor: safeVisitor, token: createToken(visitor.id, VISITOR_SESSION_SECRET, 86400) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function readApplications(visitorId) {
  const filter = visitorId ? `&visitor_id=eq.${encodeURIComponent(visitorId)}` : '';
  const rows = await supabaseRequest(`/rest/v1/applications?select=id,visitor_id,visitor_email,visitor_name,submitted_at,status,updated_at,data&order=submitted_at.asc${filter}`);
  return Promise.all(rows.map((row) => hydrateApplicationFiles(toApplication(row))));
}

async function getApplication(id) {
  const rows = await supabaseRequest(`/rest/v1/applications?id=eq.${encodeURIComponent(id)}&select=id,visitor_id,visitor_email,visitor_name,submitted_at,status,updated_at,data&limit=1`);
  return rows[0] ? hydrateApplicationFiles(toApplication(rows[0])) : null;
}

async function saveApplication(app, isNew = false) {
  const data = { ...app };
  delete data.id; delete data.visitorId; delete data.visitorEmail; delete data.visitorName; delete data.submittedAt; delete data.status; delete data.updatedAt;
  const row = {
    id: app.id,
    visitor_id: app.visitorId,
    visitor_email: app.visitorEmail,
    visitor_name: app.visitorName,
    submitted_at: app.submittedAt,
    status: app.status,
    updated_at: app.updatedAt || new Date().toISOString(),
    data
  };
  const path = isNew ? '/rest/v1/applications' : `/rest/v1/applications?id=eq.${encodeURIComponent(app.id)}`;
  const rows = await supabaseRequest(path, {
    method: isNew ? 'POST' : 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  return hydrateApplicationFiles(toApplication(rows[0]));
}

async function deleteApplicationRecord(id) {
  await supabaseRequest(`/rest/v1/applications?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function readChats() {
  const rows = await supabaseRequest('/rest/v1/chats?select=visitor_id,visitor_name,messages&order=updated_at.desc');
  return rows.reduce((chats, row) => {
    chats[row.visitor_id] = { visitorName: row.visitor_name || row.visitor_id, messages: row.messages || [] };
    return chats;
  }, {});
}

async function writeChat(visitorId, chat) {
  await supabaseRequest('/rest/v1/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ visitor_id: visitorId, visitor_name: chat.visitorName || visitorId, messages: chat.messages || [], updated_at: new Date().toISOString() })
  });
}

function storageObjectPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

async function createSignedUploadUrl(objectPath) {
  const result = await supabaseRequest(`/storage/v1/object/sign/${encodeURIComponent(SUPABASE_UPLOAD_BUCKET)}/${storageObjectPath(objectPath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3600 })
  });
  const signedPath = result.signedURL || result.signedUrl;
  if (!signedPath) throw new Error('Supabase did not return a signed upload URL.');
  return `${SUPABASE_URL}/storage/v1${signedPath}`;
}

async function hydrateFile(file) {
  if (!file?.path || String(file.path).startsWith('uploads/')) return file;
  try {
    return { ...file, url: await createSignedUploadUrl(file.path) };
  } catch (error) {
    console.error('Unable to sign upload URL', error.message);
    return file;
  }
}

async function hydrateApplicationFiles(app) {
  const hydrated = { ...app };
  for (const key of ['driversLicense', 'idDocumentFront', 'idDocumentBack']) hydrated[key] = await hydrateFile(hydrated[key]);
  return hydrated;
}

app.get('/chats', async (req, res) => {
  try {
    if (!getAdminFromAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const chats = await readChats();
    const summaries = Object.keys(chats).map((visitorId) => {
      const chat = chats[visitorId];
      const messages = chat.messages || [];
      const last = messages.length ? messages[messages.length - 1] : null;
      const unreadCount = messages.filter((message) => message.from === 'visitor' && !message.readByAdmin).length;
      return { visitorId, visitorName: chat.visitorName || visitorId, lastMessage: last, unreadCount };
    });
    res.json(summaries);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/chats/:visitorId', async (req, res) => {
  try {
    const visitorId = req.params.visitorId;
    const admin = getAdminFromAuth(req);
    if (!admin && getVisitorFromAuth(req) !== visitorId) return res.status(401).json({ error: 'Unauthorized' });
    const chat = (await readChats())[visitorId] || { visitorName: visitorId, messages: [] };
    res.json(chat);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/chats/:visitorId/message', async (req, res) => {
  try {
    const visitorId = req.params.visitorId;
    const { from, text, visitorName } = req.body;
    if (!from || !text || !['admin', 'visitor'].includes(from)) return res.status(400).json({ error: 'Valid from and text are required' });
    const admin = getAdminFromAuth(req);
    if (from === 'admin' && !admin) return res.status(401).json({ error: 'Unauthorized' });
    if (from === 'visitor' && getVisitorFromAuth(req) !== visitorId) return res.status(401).json({ error: 'Unauthorized' });
    const chats = await readChats();
    const chat = chats[visitorId] || { visitorName: visitorName || visitorId, messages: [] };
    const message = { from, text: String(text), timestamp: new Date().toISOString(), readByAdmin: from === 'admin', readByVisitor: from === 'visitor' };
    chat.messages.push(message);
    await writeChat(visitorId, chat);
    res.status(201).json(message);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/chats/:visitorId/markRead', async (req, res) => {
  try {
    const visitorId = req.params.visitorId;
    const admin = getAdminFromAuth(req);
    if (!admin && getVisitorFromAuth(req) !== visitorId) return res.status(401).json({ error: 'Unauthorized' });
    const chats = await readChats();
    const chat = chats[visitorId];
    if (!chat) return res.json({ ok: true });
    chat.messages = chat.messages.map((message) => admin ? { ...message, readByAdmin: true } : { ...message, readByVisitor: true });
    await writeChat(visitorId, chat);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/auth/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: createToken('admin', ADMIN_SESSION_SECRET, 86400) });
});

app.post('/auth/visitor/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const newVisitor = { id: `VIS-${Date.now()}`, name: String(name).trim(), email: normalizedEmail, passwordHash: hashText(password), createdAt: new Date().toISOString() };
    try {
      await createVisitor(newVisitor);
    } catch (error) {
      if (error.message.includes('23505')) return res.status(400).json({ error: 'Visitor already exists' });
      throw error;
    }
    const safeVisitor = { id: newVisitor.id, name: newVisitor.name, email: newVisitor.email, createdAt: newVisitor.createdAt };
    res.json({ visitor: safeVisitor, token: createToken(newVisitor.id, VISITOR_SESSION_SECRET, 86400) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/auth/visitor/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const rows = await supabaseRequest(`/rest/v1/visitors?email=eq.${encodeURIComponent(normalizedEmail)}&select=id,name,email,password_hash,created_at&limit=1`);
    const visitor = rows[0] ? toVisitor(rows[0]) : null;
    if (!visitor || visitor.passwordHash !== hashText(password)) return res.status(401).json({ error: 'Invalid email or password' });
    const safeVisitor = { id: visitor.id, name: visitor.name, email: visitor.email, createdAt: visitor.createdAt };
    res.json({ visitor: safeVisitor, token: createToken(visitor.id, VISITOR_SESSION_SECRET, 86400) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/auth/visitor/me', async (req, res) => {
  try {
    const visitor = await getVisitor(getVisitorFromAuth(req));
    if (!visitor) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ visitor: { id: visitor.id, name: visitor.name, email: visitor.email, createdAt: visitor.createdAt } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/applications', async (req, res) => {
  try {
    if (getAdminFromAuth(req)) return res.json(await readApplications());
    const visitorId = getVisitorFromAuth(req);
    if (!visitorId || req.query.visitorId !== visitorId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await readApplications(visitorId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/applications/:id', async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: 'Not found' });
    if (getAdminFromAuth(req) || getVisitorFromAuth(req) === application.visitorId) return res.json(application);
    res.status(401).json({ error: 'Unauthorized' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/applications', async (req, res) => {
  try {
    const visitor = await getVisitor(getVisitorFromAuth(req));
    if (!visitor) return res.status(401).json({ error: 'Unauthorized' });
    const newApp = { ...req.body, id: `APP-${Date.now()}`, visitorId: visitor.id, visitorEmail: visitor.email, visitorName: visitor.name, submittedAt: new Date().toISOString(), status: req.body.status || 'pending' };
    res.status(201).json(await saveApplication(newApp, true));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/applications/:id', async (req, res) => {
  try {
    const existing = await getApplication(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const admin = getAdminFromAuth(req);
    const visitorId = getVisitorFromAuth(req);
    let updated;
    if (!admin) {
      if (!visitorId || visitorId !== existing.visitorId) return res.status(401).json({ error: 'Unauthorized' });
      const allowedFields = ['payment', 'messages', 'adminViewed', 'unreadByVisitor'];
      const updates = {};
      for (const key of allowedFields) if (Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'No allowed fields to update' });
      updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    } else {
      updated = { ...existing, ...req.body, id: existing.id, visitorId: existing.visitorId, visitorEmail: existing.visitorEmail, visitorName: existing.visitorName, submittedAt: existing.submittedAt, updatedAt: new Date().toISOString() };
    }
    res.json(await saveApplication(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/applications/:id', async (req, res) => {
  try {
    if (!getAdminFromAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!await getApplication(req.params.id)) return res.status(404).json({ error: 'Not found' });
    await deleteApplicationRecord(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const admin = getAdminFromAuth(req);
    const visitorId = getVisitorFromAuth(req);
    if (!admin && !visitorId) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const objectPath = `${admin ? 'admin' : visitorId}/${safeName}`;
    await supabaseRequest(`/storage/v1/object/${encodeURIComponent(SUPABASE_UPLOAD_BUCKET)}/${storageObjectPath(objectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': req.file.mimetype || 'application/octet-stream', 'x-upsert': 'false' },
      body: req.file.buffer
    });
    res.json({ path: objectPath, url: await createSignedUploadUrl(objectPath) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, persistence: 'supabase', configured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) }));
if (require.main === module) app.listen(SERVER_PORT, () => console.log(`Grant API listening on ${SERVER_PORT}`));
module.exports = app;