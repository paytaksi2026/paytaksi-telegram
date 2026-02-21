const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- DB init + lightweight migrations
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

  // Ensure columns if older DB exists
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
    status TEXT NOT NULL DEFAULT 'new',
    created_at INTEGER NOT NULL
  )`);

  // Driver last known location (for live tracking after accept)
  db.run(`CREATE TABLE IF NOT EXISTS driver_locations (
    driver_phone TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  // Additive columns for order lifecycle
  ensureColumn('orders', 'driver_phone', 'driver_phone TEXT');
  ensureColumn('orders', 'accepted_at', 'accepted_at INTEGER');
  ensureColumn('orders', 'completed_at', 'completed_at INTEGER');
  ensureColumn('orders', 'started_at', 'started_at INTEGER');
  ensureColumn('orders', 'arrived_at', 'arrived_at INTEGER');
  ensureColumn('orders', 'cancelled_at', 'cancelled_at INTEGER');
  ensureColumn('orders', 'updated_at', 'updated_at INTEGER');
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

app.post('/api/driver/status', async (req, res) => {
  const user = await authUser(req.body.phone, req.body.password, 'driver');
  if (!user) return res.json({ error: "INVALID_CREDENTIALS" });
  res.json({
    success: true,
    approved: parseInt(user.approved,10) || 0,
    is_online: parseInt(user.is_online,10) || 0,
    name: user.name || ''
  });
});

// ---------------- Orders (MVP)
app.post('/api/orders/create', async (req, res) => {
  // Passenger auth via phone+password (MVP)
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

  const created_at = nowMs();
  db.run(
    `INSERT INTO orders (passenger_phone, pickup_text, pickup_lat, pickup_lon, dropoff_text, dropoff_lat, dropoff_lon, status, created_at, updated_at, driver_phone, accepted_at, arrived_at, started_at, completed_at, cancelled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
    [passenger.phone, pickup_text, pickup_lat, pickup_lon, dropoff_text, dropoff_lat, dropoff_lon, created_at, created_at],
    function(err){
      if (err) return res.json({ error: 'DB_ERROR' });
      res.json({ success: true, order_id: this.lastID });
    }
  );
});

app.get('/api/orders/my', async (req, res) => {
  const phone = normPhone(req.query.phone);
  const password = String(req.query.password || '');
  const passenger = await authUser(phone, password, 'passenger');
  if (!passenger) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  db.all(
    "SELECT id, pickup_text, pickup_lat, pickup_lon, dropoff_text, dropoff_lat, dropoff_lon, status, driver_phone, est_km, est_fare, fare_total, commission_amount, created_at, accepted_at, arrived_at, started_at, completed_at, cancelled_at, updated_at FROM orders WHERE passenger_phone=? ORDER BY id DESC LIMIT 20",
    [passenger.phone],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      res.json({ success: true, orders: rows || [] });
    }
  );
});

// Driver: new orders feed
app.get('/api/orders/feed', async (req, res) => {
  const phone = normPhone(req.query.phone);
  const password = String(req.query.password || '');
  const driver = await authUser(phone, password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (parseInt(driver.approved, 10) !== 1) return res.status(403).json({ error: 'DRIVER_PENDING' });

  db.all(
    "SELECT id, passenger_phone, pickup_text, dropoff_text, pickup_lat, pickup_lon, dropoff_lat, dropoff_lon, status, created_at FROM orders WHERE status='new' ORDER BY id DESC LIMIT 30",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      res.json({ success: true, orders: rows || [] });
    }
  );
});

// Driver: accept order (first come first served)
app.post('/api/orders/accept', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const driver = await authUser(phone, password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (parseInt(driver.approved, 10) !== 1) return res.status(403).json({ error: 'DRIVER_PENDING' });

  const order_id = parseInt(req.body.order_id, 10);
  if (!order_id) return res.status(400).json({ error: 'ORDER_ID_REQUIRED' });

  const accepted_at = nowMs();
  db.run(
    "UPDATE orders SET status='accepted', driver_phone=?, accepted_at=?, updated_at=? WHERE id=? AND status='new'",
    [driver.phone, accepted_at, accepted_at, order_id],
    function(err){
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (this.changes === 0) return res.status(409).json({ error: 'NOT_AVAILABLE' });
      res.json({ success: true });
    }
  );
});

// Driver: my accepted/completed orders
app.get('/api/orders/driver/my', async (req, res) => {
  const phone = normPhone(req.query.phone);
  const password = String(req.query.password || '');
  const driver = await authUser(phone, password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (parseInt(driver.approved, 10) !== 1) return res.status(403).json({ error: 'DRIVER_PENDING' });

  db.all(
    "SELECT id, passenger_phone, pickup_text, pickup_lat, pickup_lon, dropoff_text, dropoff_lat, dropoff_lon, status, created_at, accepted_at, arrived_at, started_at, completed_at, cancelled_at, updated_at FROM orders WHERE driver_phone=? ORDER BY id DESC LIMIT 20",
    [driver.phone],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      res.json({ success: true, orders: rows || [] });
    }
  );
});

// Passenger: cancel order (only if still 'new')
app.post('/api/orders/cancel', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const passenger = await authUser(phone, password, 'passenger');
  if (!passenger) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const order_id = parseInt(req.body.order_id, 10);
  if (!order_id) return res.status(400).json({ error: 'ORDER_ID_REQUIRED' });

  const ts = nowMs();
  db.run(
    "UPDATE orders SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=? AND passenger_phone=? AND status='new'",
    [ts, ts, order_id, passenger.phone],
    function(err){
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (this.changes === 0) return res.status(409).json({ error: 'NOT_CANCELLABLE' });
      res.json({ success: true });
    }
  );
});

// Driver: update order status (arrived / in_progress / completed / cancelled)
app.post('/api/orders/status', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const driver = await authUser(phone, password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (parseInt(driver.approved, 10) !== 1) return res.status(403).json({ error: 'DRIVER_PENDING' });

  const order_id = parseInt(req.body.order_id, 10);
  const next = String(req.body.status || '');
  if (!order_id) return res.status(400).json({ error: 'ORDER_ID_REQUIRED' });
  if (!['arrived','in_progress','completed','cancelled'].includes(next)) return res.status(400).json({ error: 'BAD_STATUS' });

  db.get(
    "SELECT id, status, driver_phone FROM orders WHERE id=?",
    [order_id],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
      if ((row.driver_phone || '') !== driver.phone) return res.status(403).json({ error: 'NOT_YOUR_ORDER' });

      const cur = row.status;
      const allowed = {
        accepted: ['arrived','in_progress','cancelled'],
        arrived: ['in_progress','cancelled'],
        in_progress: ['completed'],
      };
      if (!allowed[cur] || !allowed[cur].includes(next)) return res.status(409).json({ error: 'BAD_TRANSITION' });

      const ts = nowMs();
      const sets = ["status=?", "updated_at=?"];
      const vals = [next, ts];
      if (next === 'arrived') { sets.push('arrived_at=?'); vals.push(ts); }
      if (next === 'in_progress') { sets.push('started_at=?'); vals.push(ts); }
      if (next === 'completed') { sets.push('completed_at=?'); vals.push(ts); }
      if (next === 'cancelled') { sets.push('cancelled_at=?'); vals.push(ts); }

      vals.push(order_id);
      db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id=?`, vals, function(e2){
        if (e2) return res.status(500).json({ error: 'DB_ERROR' });
        res.json({ success: true });
      });
    }
  );
});

// Driver: location ping
app.post('/api/driver/location', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const driver = await authUser(phone, password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (parseInt(driver.approved, 10) !== 1) return res.status(403).json({ error: 'DRIVER_PENDING' });

  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'COORDS_REQUIRED' });

  const ts = nowMs();
  db.run(
    "INSERT OR REPLACE INTO driver_locations (driver_phone, lat, lng, updated_at) VALUES (?, ?, ?, ?)",
    [driver.phone, lat, lng, ts],
    (err) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      res.json({ success: true });
    }
  );
});

// Passenger: get driver location for an order (only after accepted)
app.get('/api/orders/driver_location', async (req, res) => {
  const phone = normPhone(req.query.phone);
  const password = String(req.query.password || '');
  const passenger = await authUser(phone, password, 'passenger');
  if (!passenger) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const order_id = parseInt(req.query.order_id, 10);
  if (!order_id) return res.status(400).json({ error: 'ORDER_ID_REQUIRED' });

  db.get(
    "SELECT id, driver_phone, status FROM orders WHERE id=? AND passenger_phone=?",
    [order_id, passenger.phone],
    (err, ord) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (!ord) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!ord.driver_phone || !['accepted','arrived','in_progress'].includes(ord.status)) {
        return res.json({ success: true, location: null });
      }

      db.get(
        "SELECT lat, lng, updated_at FROM driver_locations WHERE driver_phone=?",
        [ord.driver_phone],
        (e2, loc) => {
          if (e2) return res.status(500).json({ error: 'DB_ERROR' });
          res.json({ success: true, location: loc || null, driver_phone: ord.driver_phone });
        }
      );
    }
  );
});

// ---------------- Admin: login/logout + driver management
app.post('/api/admin/login', (req, res) => {
  const u = String(req.body.username || '');
  const p = String(req.body.password || '');
  const creds = adminCreds();

  if (u !== creds.user || p !== creds.pass) {
    return res.status(401).json({ error: 'INVALID_ADMIN' });
  }

  const payload = {
    u: creds.user,
    iat: Date.now(),
    exp: Date.now() + (1000 * 60 * 60 * 24 * 7) // 7 days
  };
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
  const status = String(req.query.status || 'all'); // pending|approved|all
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

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// ---------------- Reset DB (DANGEROUS) - protected by env key
app.get('/admin/reset-db', (req, res) => {
  const key = String(req.query.key || '');
  const expected = process.env.ADMIN_RESET_KEY || '';
  if (!expected || key !== expected) {
    return res.status(403).send("FORBIDDEN");
  }

  db.serialize(() => {
    db.run("DROP TABLE IF EXISTS users", (err) => {
      if (err) return res.status(500).send("DB_ERROR");
      db.run("DROP TABLE IF EXISTS orders", (err3) => {
        if (err3) return res.status(500).send("DB_ERROR");
        db.run("DROP TABLE IF EXISTS driver_locations", (errLoc) => {
          if (errLoc) return res.status(500).send("DB_ERROR");
          db.run(`CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT NOT NULL,
          password TEXT NOT NULL,
          role TEXT NOT NULL,
          name TEXT,
          approved INTEGER DEFAULT 0,
          is_online INTEGER DEFAULT 0,
          UNIQUE(phone, role)
        )`, (err2) => {
            if (err2) return res.status(500).send("DB_ERROR");

            db.run(`CREATE TABLE IF NOT EXISTS orders (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              passenger_phone TEXT NOT NULL,
              pickup_text TEXT,
              pickup_lat REAL,
              pickup_lon REAL,
              dropoff_text TEXT,
              dropoff_lat REAL,
              dropoff_lon REAL,
              status TEXT NOT NULL DEFAULT 'new',
              driver_phone TEXT,
              created_at INTEGER NOT NULL,
              accepted_at INTEGER,
              arrived_at INTEGER,
              started_at INTEGER,
              completed_at INTEGER,
              cancelled_at INTEGER,
              updated_at INTEGER
            )`, (err4) => {
              if (err4) return res.status(500).send("DB_ERROR");

              db.run(`CREATE TABLE IF NOT EXISTS driver_locations (
                driver_phone TEXT PRIMARY KEY,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                updated_at INTEGER NOT NULL
              )`, (err5) => {
                if (err5) return res.status(500).send("DB_ERROR");
                res.send("OK_RESET");
              });
            });
          });
        });
      });
    });
  });
});

app.get('/health', (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on", PORT));
