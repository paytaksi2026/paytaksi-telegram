const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- DB init + lightweight migrations (SQLite)
function ensureColumn(table, column, ddl) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
      if (err) return resolve(false);
      const exists = (rows || []).some(r => r.name === column);
      if (exists) return resolve(true);
      db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`, () => resolve(true));
    });
  });
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL,              -- passenger | driver
    name TEXT,
    approved INTEGER DEFAULT 0,      -- driver: 0 pending, 1 approved
    is_online INTEGER DEFAULT 0,     -- driver presence: 0/1
    UNIQUE(phone, role)
  )`);

  ensureColumn('users', 'approved', 'approved INTEGER DEFAULT 0');
  ensureColumn('users', 'is_online', 'is_online INTEGER DEFAULT 0');

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    passenger_phone TEXT NOT NULL,
    pickup_text TEXT,
    pickup_lat REAL,
    pickup_lon REAL,
    dropoff_text TEXT,
    dropoff_lat REAL,
    dropoff_lon REAL,
    status TEXT NOT NULL DEFAULT 'new',   -- new|accepted|arrived|started|completed|cancelled
    driver_phone TEXT,                   -- assigned driver
    est_km REAL,                         -- estimate (straight-line) km
    est_fare REAL,                       -- estimate fare
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  )`);

  ensureColumn('orders', 'driver_phone', 'driver_phone TEXT');
  ensureColumn('orders', 'updated_at', 'updated_at INTEGER');
  ensureColumn('orders', 'est_km', 'est_km REAL');
  ensureColumn('orders', 'est_fare', 'est_fare REAL');

  db.run(`CREATE TABLE IF NOT EXISTS driver_locations (
    driver_phone TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
});

// ---------------- Helpers
function normRole(role) {
  role = String(role || '').toLowerCase().trim();
  return (role === 'driver') ? 'driver' : 'passenger';
}
function normPhone(phone) {
  return String(phone || '').trim();
}
function nowMs() { return Date.now(); }

function adminCreds() {
  return {
    user: process.env.ADMIN_USER || 'Ratik',
    pass: process.env.ADMIN_PASS || 'Sevenler1984',
  };
}

const ADMIN_COOKIE = 'pt_admin';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change_me_admin_secret';

function signAdmin(value) {
  const h = crypto.createHmac('sha256', ADMIN_SECRET).update(value).digest('hex');
  return `${value}.${h}`;
}
function verifyAdmin(signed) {
  if (!signed || typeof signed !== 'string') return false;
  const idx = signed.lastIndexOf('.');
  if (idx <= 0) return false;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const h = crypto.createHmac('sha256', ADMIN_SECRET).update(value).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(h));
  } catch (_) {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const p = part.trim();
    if (!p) return;
    const eq = p.indexOf('=');
    if (eq < 0) return;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_COOKIE];
  if (!verifyAdmin(token)) return res.status(401).json({ error: 'ADMIN_REQUIRED' });

  try {
    const value = token.slice(0, token.lastIndexOf('.'));
    const payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    if (payload && payload.exp && Date.now() > payload.exp) {
      return res.status(401).json({ error: 'ADMIN_EXPIRED' });
    }
  } catch (_) {}
  next();
}

// Basic credential check for passenger/driver API calls (MVP)
function authUser(phone, password, role) {
  return new Promise((resolve) => {
    phone = normPhone(phone);
    password = String(password || '');
    role = normRole(role);
    if (!phone || !password) return resolve(null);

    db.get(
      "SELECT id, phone, role, name, approved, is_online FROM users WHERE phone=? AND password=? AND role=?",
      [phone, password, role],
      (err, row) => {
        if (err || !row) return resolve(null);
        resolve(row);
      }
    );
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Pricing (simple, configurable)
const BASE_FARE = Number(process.env.FARE_BASE || 1.0);      // AZN
const PER_KM = Number(process.env.FARE_PER_KM || 0.6);       // AZN per km
const MIN_FARE = Number(process.env.FARE_MIN || 2.0);        // AZN

function estimateFare(km) {
  const raw = BASE_FARE + (PER_KM * km);
  const val = Math.max(MIN_FARE, raw);
  // 2 decimals
  return Math.round(val * 100) / 100;
}

// ---------------- Auth (user)
app.post('/api/register', (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const role = normRole(req.body.role);
  const name = String(req.body.name || '');

  if (!phone || !password) return res.json({ error: "MISSING_FIELDS" });
  if (password.length < 4) return res.json({ error: "WEAK_PASSWORD" });

  const approved = (role === 'driver') ? 0 : 1; // passengers active by default
  const is_online = 0;

  db.run(
    "INSERT INTO users (phone, password, role, name, approved, is_online) VALUES (?, ?, ?, ?, ?, ?)",
    [phone, password, role, name, approved, is_online],
    function (err) {
      if (err) return res.json({ error: "PHONE_ROLE_EXISTS" });
      res.json({ success: true, role, approved });
    }
  );
});

app.post('/api/login', (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const role = normRole(req.body.role);

  if (!phone || !password) return res.json({ error: "MISSING_FIELDS" });

  db.get(
    "SELECT * FROM users WHERE phone=? AND password=? AND role=?",
    [phone, password, role],
    (err, row) => {
      if (err) return res.json({ error: "DB_ERROR" });
      if (!row) return res.json({ error: "INVALID_CREDENTIALS" });

      const approved = parseInt(row.approved, 10) || 0;
      const is_online = parseInt(row.is_online, 10) || 0;

      if (role === "driver" && approved === 0) {
        return res.json({ pending: true, name: row.name || "", role });
      }

      return res.json({ success: true, name: row.name || "", role, is_online });
    }
  );
});

// ---------------- Driver presence (approved drivers only)
app.post('/api/driver/online', async (req, res) => {
  const user = await authUser(req.body.phone, req.body.password, 'driver');
  if (!user) return res.json({ error: "INVALID_CREDENTIALS" });

  const approved = parseInt(user.approved, 10) || 0;
  if (approved === 0) return res.json({ error: "DRIVER_NOT_APPROVED" });

  db.run("UPDATE users SET is_online=1 WHERE id=?", [user.id], function(e2){
    if (e2) return res.json({ error: "DB_ERROR" });
    res.json({ success: true, is_online: 1 });
  });
});

app.post('/api/driver/offline', async (req, res) => {
  const user = await authUser(req.body.phone, req.body.password, 'driver');
  if (!user) return res.json({ error: "INVALID_CREDENTIALS" });

  db.run("UPDATE users SET is_online=0 WHERE id=?", [user.id], function(e2){
    if (e2) return res.json({ error: "DB_ERROR" });
    res.json({ success: true, is_online: 0 });
  });
});

// Driver live location update (GPS tracking)
app.post('/api/driver/location/update', async (req, res) => {
  const user = await authUser(req.body.phone, req.body.password, 'driver');
  if (!user) return res.json({ error: "INVALID_CREDENTIALS" });

  const approved = parseInt(user.approved, 10) || 0;
  if (approved === 0) return res.json({ error: "DRIVER_NOT_APPROVED" });

  const lat = Number(req.body.lat);
  const lon = Number(req.body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.json({ error: "BAD_COORDS" });

  const updated_at = nowMs();
  db.run(
    `INSERT INTO driver_locations (driver_phone, lat, lon, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(driver_phone) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, updated_at=excluded.updated_at`,
    [user.phone, lat, lon, updated_at],
    function(err){
      if (err) return res.json({ error: "DB_ERROR" });
      res.json({ success: true, updated_at });
    }
  );
});

// Get driver location (for passenger)
app.get('/api/driver/location/get', (req, res) => {
  const driver_phone = normPhone(req.query.driver_phone);
  if (!driver_phone) return res.status(400).json({ error: "MISSING_DRIVER" });

  db.get("SELECT driver_phone, lat, lon, updated_at FROM driver_locations WHERE driver_phone=?", [driver_phone], (err, row) => {
    if (err) return res.status(500).json({ error: "DB_ERROR" });
    if (!row) return res.json({ success: true, location: null });
    res.json({ success: true, location: row });
  });
});

// ---------------- Orders (MVP) + estimates
app.post('/api/orders/create', async (req, res) => {
  const passenger = await authUser(req.body.phone, req.body.password, 'passenger');
  if (!passenger) return res.json({ error: 'INVALID_CREDENTIALS' });

  const pickup = req.body.pickup || {};
  const dropoff = req.body.dropoff || {};

  const pickup_text = String(pickup.text || '').slice(0, 255);
  const dropoff_text = String(dropoff.text || '').slice(0, 255);
  const pickup_lat = Number(pickup.lat);
  const pickup_lon = Number(pickup.lon);
  const dropoff_lat = Number(dropoff.lat);
  const dropoff_lon = Number(dropoff.lon);

  if (!pickup_text || !dropoff_text) return res.json({ error: 'MISSING_ADDRESSES' });
  if (!Number.isFinite(pickup_lat) || !Number.isFinite(pickup_lon) || !Number.isFinite(dropoff_lat) || !Number.isFinite(dropoff_lon)) {
    return res.json({ error: 'MISSING_COORDS' });
  }

  const est_km = Math.max(0, haversineKm(pickup_lat, pickup_lon, dropoff_lat, dropoff_lon));
  const est_fare = estimateFare(est_km);

  const created_at = nowMs();
  db.run(
    `INSERT INTO orders (passenger_phone, pickup_text, pickup_lat, pickup_lon, dropoff_text, dropoff_lat, dropoff_lon,
                         status, driver_phone, est_km, est_fare, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?, ?, ?)`,
    [passenger.phone, pickup_text, pickup_lat, pickup_lon, dropoff_text, dropoff_lat, dropoff_lon,
     est_km, est_fare, created_at, created_at],
    function(err){
      if (err) return res.json({ error: 'DB_ERROR' });
      res.json({ success: true, order_id: this.lastID, est_km, est_fare });
    }
  );
});

app.get('/api/orders/my', async (req, res) => {
  const passenger = await authUser(req.query.phone, req.query.password, 'passenger');
  if (!passenger) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  db.all(
    "SELECT id, pickup_text, dropoff_text, status, driver_phone, est_km, est_fare, created_at, updated_at FROM orders WHERE passenger_phone=? ORDER BY id DESC LIMIT 20",
    [passenger.phone],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      res.json({ success: true, orders: rows || [] });
    }
  );
});

// Available orders for drivers (only new) + proximity sorting
app.get('/api/orders/available', async (req, res) => {
  const driver = await authUser(req.query.phone, req.query.password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if ((parseInt(driver.approved,10)||0) === 0) return res.status(403).json({ error: 'DRIVER_NOT_APPROVED' });
  if ((parseInt(driver.is_online,10)||0) === 0) return res.json({ success: true, orders: [] });

  const radiusKm = Number(req.query.radius_km || 10); // default 10km
  db.get("SELECT lat, lon, updated_at FROM driver_locations WHERE driver_phone=?", [driver.phone], (e0, loc) => {
    // If no GPS yet, return without distance info (still allow)
    db.all(
      "SELECT id, pickup_text, pickup_lat, pickup_lon, dropoff_text, status, est_km, est_fare, created_at FROM orders WHERE status='new' ORDER BY id ASC LIMIT 20",
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB_ERROR' });
        let out = (rows || []).map(o => ({...o}));
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
          out = out.map(o => {
            const dkm = haversineKm(Number(loc.lat), Number(loc.lon), Number(o.pickup_lat), Number(o.pickup_lon));
            return { ...o, pickup_distance_km: Math.round(dkm * 10) / 10 };
          });
          out = out.filter(o => !Number.isFinite(radiusKm) || o.pickup_distance_km <= radiusKm);
          out.sort((a,b) => (a.pickup_distance_km ?? 1e9) - (b.pickup_distance_km ?? 1e9));
        }
        // remove raw pickup coords from response (optional)
        out = out.map(({pickup_lat, pickup_lon, ...rest}) => rest);
        res.json({ success: true, orders: out, radius_km: radiusKm, has_gps: !!loc });
      }
    );
  });
});

// Driver accepts an order
app.post('/api/orders/accept', async (req, res) => {
  const driver = await authUser(req.body.phone, req.body.password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if ((parseInt(driver.approved,10)||0) === 0) return res.status(403).json({ error: 'DRIVER_NOT_APPROVED' });

  const order_id = parseInt(req.body.order_id, 10);
  if (!order_id) return res.json({ error: 'MISSING_ORDER' });

  const t = nowMs();
  db.run(
    "UPDATE orders SET status='accepted', driver_phone=?, updated_at=? WHERE id=? AND status='new'",
    [driver.phone, t, order_id],
    function(err){
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (this.changes === 0) return res.json({ error: 'ORDER_NOT_AVAILABLE' });
      res.json({ success: true });
    }
  );
});

// Driver gets their active order (accepted/arrived/started)
app.get('/api/orders/driver-active', async (req, res) => {
  const driver = await authUser(req.query.phone, req.query.password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  db.get(
    "SELECT id, passenger_phone, pickup_text, dropoff_text, status, est_km, est_fare, created_at, updated_at FROM orders WHERE driver_phone=? AND status IN ('accepted','arrived','started') ORDER BY id DESC LIMIT 1",
    [driver.phone],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      res.json({ success: true, order: row || null });
    }
  );
});

async function updateOrderStatus(req, res, nextStatus) {
  const driver = await authUser(req.body.phone, req.body.password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const order_id = parseInt(req.body.order_id, 10);
  if (!order_id) return res.json({ error: 'MISSING_ORDER' });

  const t = nowMs();
  db.run(
    "UPDATE orders SET status=?, updated_at=? WHERE id=? AND driver_phone=? AND status IN ('accepted','arrived','started')",
    [nextStatus, t, order_id, driver.phone],
    function(err){
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (this.changes === 0) return res.json({ error: 'NOT_ALLOWED' });
      res.json({ success: true, status: nextStatus });
    }
  );
}
app.post('/api/orders/arrived', (req, res) => updateOrderStatus(req, res, 'arrived'));
app.post('/api/orders/start', (req, res) => updateOrderStatus(req, res, 'started'));
app.post('/api/orders/complete', async (req, res) => {
  const driver = await authUser(req.body.phone, req.body.password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const order_id = parseInt(req.body.order_id, 10);
  if (!order_id) return res.json({ error: 'MISSING_ORDER' });

  const t = nowMs();
  db.run(
    "UPDATE orders SET status='completed', updated_at=? WHERE id=? AND driver_phone=? AND status IN ('accepted','arrived','started')",
    [t, order_id, driver.phone],
    function(err){
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (this.changes === 0) return res.json({ error: 'NOT_ALLOWED' });
      res.json({ success: true, status: 'completed' });
    }
  );
});

// ---------------- Admin: login/logout + driver management (unchanged)
app.post('/api/admin/login', (req, res) => {
  const u = String(req.body.username || '');
  const p = String(req.body.password || '');
  const creds = adminCreds();

  if (u !== creds.user || p !== creds.pass) {
    return res.status(401).json({ error: 'INVALID_ADMIN' });
  }

  const payload = { u: creds.user, iat: Date.now(), exp: Date.now() + (1000 * 60 * 60 * 24 * 7) };
  const value = Buffer.from(JSON.stringify(payload)).toString('base64');
  const token = signAdmin(value);

  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
  res.json({ success: true });
});

app.get('/api/admin/drivers', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'all');
  let where = "role='driver'";
  if (status === 'pending') where += " AND approved=0";
  if (status === 'approved') where += " AND approved=1";

  db.all(`SELECT id, phone, name, approved, is_online FROM users WHERE ${where} ORDER BY approved ASC, is_online DESC, id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB_ERROR' });
    res.json({ success: true, drivers: rows || [] });
  });
});

app.post('/api/admin/approve', requireAdmin, (req, res) => {
  const id = parseInt(req.body.id, 10);
  const phone = normPhone(req.body.phone);
  if (!id && !phone) return res.json({ error: "MISSING_ID_OR_PHONE" });

  const q = id ? "UPDATE users SET approved=1 WHERE id=? AND role='driver'" : "UPDATE users SET approved=1 WHERE phone=? AND role='driver'";
  const params = id ? [id] : [phone];

  db.run(q, params, function(err) {
    if (err) return res.status(500).json({ error: "DB_ERROR" });
    res.json({ success: true, changes: this.changes });
  });
});

app.post('/api/admin/delete-driver', requireAdmin, (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!id) return res.json({ error: "MISSING_ID" });

  db.run("DELETE FROM users WHERE id=? AND role='driver'", [id], function(err) {
    if (err) return res.status(500).json({ error: "DB_ERROR" });
    res.json({ success: true, changes: this.changes });
  });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

app.get('/health', (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on", PORT));
