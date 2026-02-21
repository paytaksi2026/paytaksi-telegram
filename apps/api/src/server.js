require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const { openDb, runSchema, exec, get, all } = require('./db');
const { authRequired, roleRequired, adminAuthRequired } = require('./auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_WEBAPP = process.env.PUBLIC_WEBAPP || path.join(__dirname, '..', '..', 'webapp', 'public');
const PUBLIC_ADMIN = process.env.PUBLIC_ADMIN || path.join(__dirname, '..', '..', 'admin', 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'uploads');

if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET in env');
  process.exit(1);
}
if (!process.env.ADMIN_JWT_SECRET) {
  console.error('Missing ADMIN_JWT_SECRET in env');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = openDb();
runSchema(db).then(() => ensureDefaultAdmin()).catch((e) => {
  console.error('DB schema error', e);
  process.exit(1);
});

async function ensureDefaultAdmin() {
  const username = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASS || 'admin123';
  const row = await get(db, 'SELECT id FROM admin_users WHERE username=?', [username]);
  if (!row) {
    const hash = await bcrypt.hash(pass, 10);
    await exec(db, 'INSERT INTO admin_users(username, password_hash) VALUES(?,?)', [username, hash]);
    console.log('Default admin created:', username);
  }
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Static
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/app', express.static(PUBLIC_WEBAPP));
app.use('/admin', express.static(PUBLIC_ADMIN));
app.get('/', (req, res) => res.redirect('/app/'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ----- Auth -----
app.post('/api/auth/register', async (req, res) => {
  try {
    const { role, name, phone, password, car_model, car_plate } = req.body || {};
    if (!['passenger', 'driver'].includes(role)) return res.status(400).json({ error: 'BAD_ROLE' });
    if (!name || !phone || !password) return res.status(400).json({ error: 'MISSING_FIELDS' });
    if (String(password).length < 6) return res.status(400).json({ error: 'WEAK_PASSWORD' });

    const exists = await get(db, 'SELECT id FROM users WHERE phone=?', [phone]);
    if (exists) return res.status(409).json({ error: 'PHONE_EXISTS' });

    const hash = await bcrypt.hash(password, 10);
    const ins = await exec(db, 'INSERT INTO users(role,name,phone,password_hash) VALUES(?,?,?,?)', [role, name, phone, hash]);

    if (role === 'driver') {
      await exec(
        db,
        "INSERT INTO drivers(user_id, car_model, car_plate, approval_status, is_online) VALUES(?,?,?,?,0)",
        [ins.lastID, car_model || '', car_plate || '', 'PENDING']
      );
    }

    const token = jwt.sign({ id: ins.lastID, role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      token,
      user: { id: ins.lastID, role, name, phone },
      driver: role === 'driver' ? { approval_status: 'PENDING', is_online: false } : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) return res.status(400).json({ error: 'MISSING_FIELDS' });
    const u = await get(db, 'SELECT * FROM users WHERE phone=?', [phone]);
    if (!u) return res.status(401).json({ error: 'BAD_LOGIN' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'BAD_LOGIN' });

    const token = jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const driver = u.role === 'driver' ? await get(db, 'SELECT approval_status,is_online,car_model,car_plate FROM drivers WHERE user_id=?', [u.id]) : null;
    res.json({ token, user: { id: u.id, role: u.role, name: u.name, phone: u.phone }, driver });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/me', authRequired, async (req, res) => {
  const u = await get(db, 'SELECT id,role,name,phone FROM users WHERE id=?', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'NOT_FOUND' });
  const driver = u.role === 'driver' ? await get(db, 'SELECT approval_status,is_online,car_model,car_plate FROM drivers WHERE user_id=?', [u.id]) : null;
  res.json({ user: u, driver });
});

// ----- Places proxy -----
const placesCache = new NodeCache({ stdTTL: 600 });
const placesLimiter = rateLimit({ windowMs: 10 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

app.get('/api/places/search', placesLimiter, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json({ items: [], cached: true });
    const key = 's:' + q.toLowerCase();
    const cached = placesCache.get(key);
    if (cached) return res.json({ items: cached, cached: true });

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('countrycodes', 'az');
    url.searchParams.set('limit', '6');

    const r = await fetch(url.toString(), {
      headers: {
        'User-Agent': process.env.NOMINATIM_UA || 'PayTaksiMiniApp/1.0 (contact: example@example.com)'
      }
    });
    const data = await r.json();
    const items = (data || []).map((x) => ({
      text: x.display_name,
      lat: Number(x.lat),
      lon: Number(x.lon)
    }));
    placesCache.set(key, items);
    res.json({ items, cached: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'PLACES_ERROR' });
  }
});

app.get('/api/places/reverse', placesLimiter, async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'BAD_COORDS' });
    const key = `r:${lat.toFixed(5)}:${lon.toFixed(5)}`;
    const cached = placesCache.get(key);
    if (cached) return res.json({ ...cached, cached: true });

    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('format', 'json');

    const r = await fetch(url.toString(), {
      headers: {
        'User-Agent': process.env.NOMINATIM_UA || 'PayTaksiMiniApp/1.0 (contact: example@example.com)'
      }
    });
    const data = await r.json();
    const out = { text: data?.display_name || 'Unknown', lat, lon };
    placesCache.set(key, out);
    res.json({ ...out, cached: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'PLACES_ERROR' });
  }
});

// ----- Driver docs -----
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, `driver_${req.user.id}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/driver/docs', authRequired, roleRequired('driver'), upload.fields([
  { name: 'license_front', maxCount: 1 },
  { name: 'license_back', maxCount: 1 },
  { name: 'car_doc', maxCount: 1 }
]), async (req, res) => {
  try {
    const files = req.files || {};
    const lf = files.license_front?.[0];
    const lb = files.license_back?.[0];
    const cd = files.car_doc?.[0];
    if (!lf || !lb || !cd) return res.status(400).json({ error: 'MISSING_FILES' });

    const base = (p) => `/uploads/driver_${req.user.id}/${path.basename(p)}`;
    const license_front_url = base(lf.path);
    const license_back_url = base(lb.path);
    const car_doc_url = base(cd.path);

    // upsert style: keep latest row
    await exec(db, 'DELETE FROM driver_docs WHERE driver_user_id=?', [req.user.id]);
    await exec(
      db,
      'INSERT INTO driver_docs(driver_user_id, license_front_url, license_back_url, car_doc_url) VALUES(?,?,?,?)',
      [req.user.id, license_front_url, license_back_url, car_doc_url]
    );

    res.json({ ok: true, docs: { license_front_url, license_back_url, car_doc_url } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'UPLOAD_ERROR' });
  }
});

app.get('/api/driver/docs/status', authRequired, roleRequired('driver'), async (req, res) => {
  const d = await get(db, 'SELECT approval_status FROM drivers WHERE user_id=?', [req.user.id]);
  const docs = await get(db, 'SELECT id FROM driver_docs WHERE driver_user_id=?', [req.user.id]);
  res.json({ approval_status: d?.approval_status || 'PENDING', docs_uploaded: !!docs });
});

// ----- Driver online/offline -----
app.post('/api/driver/online', authRequired, roleRequired('driver'), async (req, res) => {
  const d = await get(db, 'SELECT approval_status FROM drivers WHERE user_id=?', [req.user.id]);
  if (!d) return res.status(400).json({ error: 'NO_DRIVER' });
  if (d.approval_status !== 'APPROVED') return res.status(403).json({ error: 'NOT_APPROVED' });
  await exec(db, "UPDATE drivers SET is_online=1, updated_at=datetime('now') WHERE user_id=?", [req.user.id]);
  res.json({ ok: true, is_online: true });
});

app.post('/api/driver/offline', authRequired, roleRequired('driver'), async (req, res) => {
  await exec(db, "UPDATE drivers SET is_online=0, updated_at=datetime('now') WHERE user_id=?", [req.user.id]);
  res.json({ ok: true, is_online: false });
});

// ----- Orders -----
function normalizePoint(p) {
  if (!p) return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  const text = String(p.text || '').trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !text) return null;
  return { lat, lon, text };
}

app.post('/api/orders', authRequired, roleRequired('passenger'), async (req, res) => {
  try {
    const pickup = normalizePoint(req.body?.pickup);
    const dropoff = normalizePoint(req.body?.dropoff);
    if (!pickup || !dropoff) return res.status(400).json({ error: 'BAD_POINTS' });

    const ins = await exec(
      db,
      'INSERT INTO orders(passenger_user_id, pickup_lat, pickup_lon, pickup_text, dropoff_lat, dropoff_lon, dropoff_text, status) VALUES(?,?,?,?,?,?,?,?)',
      [req.user.id, pickup.lat, pickup.lon, pickup.text, dropoff.lat, dropoff.lon, dropoff.text, 'CREATED']
    );

    // broadcast to online drivers
    broadcastToDrivers({ type: 'order:new', order: { id: ins.lastID, pickup_text: pickup.text, dropoff_text: dropoff.text } });
    await exec(db, "UPDATE orders SET status='BROADCAST', updated_at=datetime('now') WHERE id=?", [ins.lastID]);

    res.json({ order: { id: ins.lastID, status: 'BROADCAST', pickup, dropoff } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ORDER_ERROR' });
  }
});

app.get('/api/orders/active', authRequired, async (req, res) => {
  const role = req.user.role;
  if (role === 'passenger') {
    const o = await get(db, "SELECT * FROM orders WHERE passenger_user_id=? AND status NOT IN ('COMPLETED','CANCELLED_BY_PASSENGER','CANCELLED_BY_DRIVER','EXPIRED') ORDER BY id DESC LIMIT 1", [req.user.id]);
    if (!o) return res.json({ order: null });
    const driver = o.driver_user_id ? await get(db, 'SELECT u.id,u.name,d.car_model,d.car_plate FROM users u JOIN drivers d ON d.user_id=u.id WHERE u.id=?', [o.driver_user_id]) : null;
    res.json({ order: {
      id: o.id,
      status: o.status,
      pickup: { lat: o.pickup_lat, lon: o.pickup_lon, text: o.pickup_text },
      dropoff: { lat: o.dropoff_lat, lon: o.dropoff_lon, text: o.dropoff_text },
      driver
    }});
  } else if (role === 'driver') {
    const o = await get(db, "SELECT * FROM orders WHERE driver_user_id=? AND status NOT IN ('COMPLETED','CANCELLED_BY_PASSENGER','CANCELLED_BY_DRIVER','EXPIRED') ORDER BY id DESC LIMIT 1", [req.user.id]);
    res.json({ order: o ? { id: o.id, status: o.status, pickup_text: o.pickup_text, dropoff_text: o.dropoff_text } : null });
  } else {
    res.status(400).json({ error: 'BAD_ROLE' });
  }
});

app.post('/api/orders/:id/cancel', authRequired, roleRequired('passenger'), async (req, res) => {
  const id = Number(req.params.id);
  const o = await get(db, 'SELECT * FROM orders WHERE id=?', [id]);
  if (!o || o.passenger_user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });
  if (['COMPLETED','CANCELLED_BY_PASSENGER','CANCELLED_BY_DRIVER','EXPIRED'].includes(o.status)) return res.status(400).json({ error: 'NOT_ACTIVE' });
  await exec(db, "UPDATE orders SET status='CANCELLED_BY_PASSENGER', updated_at=datetime('now') WHERE id=?", [id]);
  // notify driver if exists
  if (o.driver_user_id) broadcastToUser(o.driver_user_id, { type: 'order:status', order_id: id, status: 'CANCELLED_BY_PASSENGER' });
  res.json({ ok: true, status: 'CANCELLED_BY_PASSENGER' });
});

app.post('/api/orders/:id/accept', authRequired, roleRequired('driver'), async (req, res) => {
  const id = Number(req.params.id);
  const d = await get(db, 'SELECT approval_status,is_online FROM drivers WHERE user_id=?', [req.user.id]);
  if (!d || d.approval_status !== 'APPROVED') return res.status(403).json({ error: 'NOT_APPROVED' });
  if (!d.is_online) return res.status(403).json({ error: 'NOT_ONLINE' });

  const o = await get(db, 'SELECT * FROM orders WHERE id=?', [id]);
  if (!o) return res.status(404).json({ error: 'NOT_FOUND' });
  if (o.status !== 'BROADCAST') return res.status(400).json({ error: 'NOT_AVAILABLE' });

  await exec(db, "UPDATE orders SET driver_user_id=?, status='ACCEPTED', updated_at=datetime('now') WHERE id=? AND status='BROADCAST'", [req.user.id, id]);
  const updated = await get(db, 'SELECT * FROM orders WHERE id=?', [id]);
  if (updated.driver_user_id !== req.user.id) return res.status(409).json({ error: 'ALREADY_TAKEN' });

  const driverInfo = await get(db, 'SELECT u.id,u.name,d.car_model,d.car_plate FROM users u JOIN drivers d ON d.user_id=u.id WHERE u.id=?', [req.user.id]);
  broadcastToUser(updated.passenger_user_id, { type: 'order:accepted', order_id: id, driver: driverInfo });
  res.json({ ok: true, status: 'ACCEPTED' });
});

app.post('/api/orders/:id/reject', authRequired, roleRequired('driver'), async (req, res) => {
  // MVP: no action, just ack
  res.json({ ok: true });
});

app.post('/api/orders/:id/status', authRequired, roleRequired('driver'), async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!['DRIVER_ARRIVED','STARTED','COMPLETED','CANCELLED_BY_DRIVER'].includes(status)) {
    return res.status(400).json({ error: 'BAD_STATUS' });
  }
  const o = await get(db, 'SELECT * FROM orders WHERE id=?', [id]);
  if (!o || o.driver_user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });

  await exec(db, 'UPDATE orders SET status=?, updated_at=datetime(\'now\') WHERE id=?', [status, id]);
  broadcastToUser(o.passenger_user_id, { type: 'order:status', order_id: id, status });
  res.json({ ok: true });
});

// ----- Admin -----
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'MISSING_FIELDS' });
  const a = await get(db, 'SELECT * FROM admin_users WHERE username=?', [username]);
  if (!a) return res.status(401).json({ error: 'BAD_LOGIN' });
  const ok = await bcrypt.compare(password, a.password_hash);
  if (!ok) return res.status(401).json({ error: 'BAD_LOGIN' });
  const token = jwt.sign({ id: a.id, username: a.username }, process.env.ADMIN_JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, admin: { id: a.id, username: a.username } });
});

app.get('/api/admin/drivers', adminAuthRequired, async (req, res) => {
  const status = String(req.query.status || 'pending').toUpperCase();
  const allowed = ['PENDING','APPROVED','REJECTED','BLOCKED'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'BAD_STATUS' });
  const items = await all(db, `
    SELECT u.id as user_id, u.name, u.phone, d.car_model, d.car_plate, d.approval_status,
           dd.license_front_url, dd.license_back_url, dd.car_doc_url
    FROM users u
    JOIN drivers d ON d.user_id=u.id
    LEFT JOIN driver_docs dd ON dd.driver_user_id=u.id
    WHERE d.approval_status=?
    ORDER BY u.id DESC
  `, [status]);
  res.json({ items: items.map(x => ({
    user_id: x.user_id,
    name: x.name,
    phone: x.phone,
    car_model: x.car_model,
    car_plate: x.car_plate,
    approval_status: x.approval_status,
    docs: {
      license_front_url: x.license_front_url,
      license_back_url: x.license_back_url,
      car_doc_url: x.car_doc_url
    }
  })) });
});

async function adminAction(req, res, action) {
  const id = Number(req.params.id);
  const map = { APPROVE: 'APPROVED', REJECT: 'REJECTED', BLOCK: 'BLOCKED' };
  const target = map[action];
  const drv = await get(db, 'SELECT user_id FROM drivers WHERE user_id=?', [id]);
  if (!drv) return res.status(404).json({ error: 'NOT_FOUND' });
  await exec(db, 'UPDATE drivers SET approval_status=?, is_online=0, updated_at=datetime(\'now\') WHERE user_id=?', [target, id]);
  await exec(db, 'INSERT INTO admin_actions(admin_id, action, driver_user_id) VALUES(?,?,?)', [req.admin.id, action, id]);
  broadcastToUser(id, { type: 'driver:approval', approval_status: target });
  res.json({ ok: true, approval_status: target });
}

app.post('/api/admin/driver/:id/approve', adminAuthRequired, (req, res) => adminAction(req, res, 'APPROVE'));
app.post('/api/admin/driver/:id/reject', adminAuthRequired, (req, res) => adminAction(req, res, 'REJECT'));
app.post('/api/admin/driver/:id/block', adminAuthRequired, (req, res) => adminAction(req, res, 'BLOCK'));

// ----- WebSocket -----
const server = app.listen(PORT, () => {
  console.log('API listening on', PORT);
  console.log('WebApp:', '/app/');
  console.log('Admin:', '/admin/');
});

const wss = new WebSocketServer({ server, path: '/ws' });

// In-memory connections
const userSockets = new Map(); // userId -> Set(ws)
const driverSockets = new Set(); // all online (connected) drivers (regardless of approved)

function addSocket(userId, ws) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(ws);
}
function removeSocket(userId, ws) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userSockets.delete(userId);
}

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

function broadcastToUser(userId, obj) {
  const set = userSockets.get(userId);
  if (!set) return;
  for (const ws of set) safeSend(ws, obj);
}

function broadcastToDrivers(obj) {
  for (const ws of driverSockets) safeSend(ws, obj);
}

wss.on('connection', (ws, req) => {
  // Expect query token
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) {
    safeSend(ws, { type: 'error', error: 'NO_TOKEN' });
    ws.close();
    return;
  }
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    safeSend(ws, { type: 'error', error: 'BAD_TOKEN' });
    ws.close();
    return;
  }

  addSocket(payload.id, ws);
  if (payload.role === 'driver') driverSockets.add(ws);

  safeSend(ws, { type: 'hello', user_id: payload.id, role: payload.role });

  ws.on('close', () => {
    removeSocket(payload.id, ws);
    if (payload.role === 'driver') driverSockets.delete(ws);
  });
});

