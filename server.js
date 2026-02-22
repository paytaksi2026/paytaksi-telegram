const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

app.use(bodyParser.json({ limit: '1mb' }));

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

// Runtime-safe helper: read table columns (works even if user DB is older/newer)
function getTableCols(table) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
      if (err) return resolve(new Set());
      resolve(new Set((rows || []).map(r => r && r.name).filter(Boolean)));
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
    
    driver_radius_km INTEGER DEFAULT 4, -- driver radius (km)
UNIQUE(phone, role)
  )`);

  // Ensure columns if older DB exists
  ensureColumn('users', 'approved', 'approved INTEGER DEFAULT 0');
  ensureColumn('users', 'is_online', 'is_online INTEGER DEFAULT 0');
  ensureColumn('users', 'driver_radius_km', 'driver_radius_km INTEGER DEFAULT 4');

  // Settings (default radius & pricing) - additive
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  function seedSetting(k, v){
    db.get("SELECT value FROM settings WHERE key=?", [k], (e, row)=>{
      if(e) return;
      if(!row) db.run("INSERT INTO settings (key,value) VALUES (?,?)", [k, String(v)]);
    });
  }
  seedSetting('default_radius_km', 4);
  seedSetting('fare_base', 1.0);
  seedSetting('fare_per_km', 0.6);
  seedSetting('fare_per_min', 0.15);
  seedSetting('fare_min', 2.0);
  seedSetting('commission_rate', 0.10);

  // Fare packages (JSON). Additive + backward compatible.
  // Stored in settings to keep migrations minimal.
  // Default packages are derived from the base fare settings above.
  seedSetting('fare_packages_json', JSON.stringify({
    economy:  { name: 'Ekonom',  fare_base: 1.0, fare_per_km: 0.6, fare_per_min: 0.15, fare_min: 2.0, commission_rate: 0.10 },
    comfort:  { name: 'Komfort', fare_base: 2.0, fare_per_km: 0.75, fare_per_min: 0.20, fare_min: 3.0, commission_rate: 0.10 },
    business: { name: 'Biznes',  fare_base: 4.0, fare_per_km: 0.95, fare_per_min: 0.25, fare_min: 5.0, commission_rate: 0.10 }
  }));


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

  // GPS track points for real distance during ride (MVP)
  db.run(`CREATE TABLE IF NOT EXISTS order_track_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    driver_phone TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_order_track_points_order ON order_track_points(order_id, id)`);

  // Additive columns for order lifecycle
  ensureColumn('orders', 'driver_phone', 'driver_phone TEXT');
  ensureColumn('orders', 'accepted_at', 'accepted_at INTEGER');
  ensureColumn('orders', 'completed_at', 'completed_at INTEGER');
  ensureColumn('orders', 'started_at', 'started_at INTEGER');
  ensureColumn('orders', 'arrived_at', 'arrived_at INTEGER');
  ensureColumn('orders', 'cancelled_at', 'cancelled_at INTEGER');
  ensureColumn('orders', 'updated_at', 'updated_at INTEGER');
  // Estimated pricing (from pickup->dropoff)
  ensureColumn('orders', 'est_km', 'est_km REAL');
  ensureColumn('orders', 'est_minutes', 'est_minutes REAL');
  ensureColumn('orders', 'est_fare', 'est_fare REAL');
  ensureColumn('orders', 'fare_package', "fare_package TEXT DEFAULT 'economy'");
  // Final fare engine (completed)
  ensureColumn('orders', 'real_km', 'real_km REAL');
  ensureColumn('orders', 'real_minutes', 'real_minutes REAL');
  ensureColumn('orders', 'final_fare', 'final_fare REAL');
  ensureColumn('orders', 'admin_fee', 'admin_fee REAL');
  ensureColumn('orders', 'driver_earn', 'driver_earn REAL');
});

// ---------------- Helpers
function normRole(role) {
  role = String(role || '').toLowerCase().trim();
  return (role === 'driver') ? 'driver' : 'passenger';
}
function normPhone(phone) {
  return String(phone || '').trim();
}
function nowMs() {
  return Date.now();
}

async function getSetting(key, defVal){
  return await new Promise((resolve)=>{
    db.get("SELECT value FROM settings WHERE key=?", [key], (err, row)=>{
      if(err || !row) return resolve(defVal);
      const v = row.value;
      const n = Number(v);
      // if defVal is number, coerce
      if (typeof defVal === 'number' && Number.isFinite(n)) return resolve(n);
      resolve(v);
    });
  });
}
async function setSetting(key, value){
  return await new Promise((resolve)=>{
    db.run("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, String(value)],
      (err)=> resolve(!err)
    );
  });
}

// Fare engine helpers (single source of truth)
async function getFareSettings(){
  const fare_base = await getSetting('fare_base', 1.0);
  const fare_per_km = await getSetting('fare_per_km', 0.6);
  const fare_per_min = await getSetting('fare_per_min', 0.15);
  const fare_min = await getSetting('fare_min', 2.0);
  return {
    fare_base: Number(fare_base) || 0,
    fare_per_km: Number(fare_per_km) || 0,
    fare_per_min: Number(fare_per_min) || 0,
    fare_min: Number(fare_min) || 0,
  };
}

// Fare packages (stored as JSON in settings)
async function getFarePackages(){
  const raw = await getSetting('fare_packages_json', '');
  let obj = null;
  try { obj = JSON.parse(String(raw||'')); } catch(_) { obj = null; }

  // Fallback: build economy from base fare settings
  if (!obj || typeof obj !== 'object') {
    const base = await getFareSettings();
    obj = {
      economy: { name: 'Ekonom', ...base, commission_rate: await getSetting('commission_rate', 0.10) }
    };
  }

  // Ensure required fields & sane numbers
  const normPkg = (p, defName) => {
    p = (p && typeof p === 'object') ? p : {};
    return {
      name: String(p.name || defName || '').slice(0, 32) || defName || 'Paket',
      fare_base: Number(p.fare_base) || 0,
      fare_per_km: Number(p.fare_per_km) || 0,
      fare_per_min: Number(p.fare_per_min) || 0,
      fare_min: Number(p.fare_min) || 0,
      commission_rate: Number(p.commission_rate) || 0,
    };
  };

  // Normalize known packages if present
  const out = {};
  for (const [id, p] of Object.entries(obj)) {
    if (!id) continue;
    out[String(id).toLowerCase().trim()] = normPkg(p, (p && p.name) ? String(p.name) : id);
  }

  // Ensure at least economy exists
  if (!out.economy) {
    const base = await getFareSettings();
    out.economy = normPkg({ name:'Ekonom', ...base, commission_rate: await getSetting('commission_rate', 0.10) }, 'Ekonom');
  }
  return out;
}

async function setFarePackages(packagesObj){
  try {
    await setSetting('fare_packages_json', JSON.stringify(packagesObj || {}));
    return true;
  } catch (_) {
    return false;
  }
}

async function getFareSettingsForPackage(packageId){
  const pkgs = await getFarePackages();
  const id = String(packageId || 'economy').toLowerCase().trim();
  const p = pkgs[id] || pkgs.economy;
  return {
    package_id: pkgs[id] ? id : 'economy',
    name: p.name,
    fare_base: Number(p.fare_base)||0,
    fare_per_km: Number(p.fare_per_km)||0,
    fare_per_min: Number(p.fare_per_min)||0,
    fare_min: Number(p.fare_min)||0,
    commission_rate: Number(p.commission_rate)||0,
  };
}

function computeFare(settings, km, minutes){
  const s = settings || { fare_base:0, fare_per_km:0, fare_per_min:0, fare_min:0 };
  km = Number(km) || 0;
  minutes = Number(minutes) || 0;
  let fare = (Number(s.fare_base)||0) + (Number(s.fare_per_km)||0)*km + (Number(s.fare_per_min)||0)*minutes;
  const minFare = Number(s.fare_min)||0;
  if (minFare > 0) fare = Math.max(minFare, fare);
  return Math.round(fare * 100) / 100;
}
function havKm(lat1, lon1, lat2, lon2){
  const toRad = d => (d*Math.PI)/180;
  const R = 6371;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}
async function osrmRouteMeta(pickup_lon, pickup_lat, dropoff_lon, dropoff_lat){
  try{
    const url = `https://router.project-osrm.org/route/v1/driving/${pickup_lon},${pickup_lat};${dropoff_lon},${dropoff_lat}?overview=false`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const j = await r.json();
    const route = j && j.routes && j.routes[0];
    if(route && typeof route.distance === 'number' && typeof route.duration === 'number'){
      return { km: route.distance/1000, minutes: route.duration/60 };
    }
  }catch(e){}
  return null;
}

// Public estimate endpoint (server-side pricing; used by passenger preview)
app.post('/api/estimate', async (req, res) => {
  try{
    const b = req.body || {};
    const package_id = String(b.package_id || b.package || 'economy');

    // Option A: km/min passed directly
    let km = Number(b.km);
    let minutes = Number(b.minutes);

    // Option B: pickup/dropoff coords
    if (!Number.isFinite(km) || km < 0 || !Number.isFinite(minutes) || minutes < 0) {
      const pickup = b.pickup || {};
      const dropoff = b.dropoff || {};
      const pickup_lat = Number(pickup.lat);
      const pickup_lon = Number(pickup.lon);
      const dropoff_lat = Number(dropoff.lat);
      const dropoff_lon = Number(dropoff.lon);

      if (!Number.isFinite(pickup_lat) || !Number.isFinite(pickup_lon) || !Number.isFinite(dropoff_lat) || !Number.isFinite(dropoff_lon)) {
        return res.status(400).json({ success:false, error:'BAD_INPUT' });
      }

      // fallback straight line
      km = havKm(pickup_lat, pickup_lon, dropoff_lat, dropoff_lon);
      minutes = 0;
      const meta = await osrmRouteMeta(pickup_lon, pickup_lat, dropoff_lon, dropoff_lat);
      if (meta){
        if (Number.isFinite(meta.km) && meta.km > 0) km = meta.km;
        if (Number.isFinite(meta.minutes) && meta.minutes > 0) minutes = meta.minutes;
      }
    }

    km = Math.max(0, km);
    minutes = Math.max(0, minutes);

    const settings = await getFareSettingsForPackage(package_id);
    const fare = computeFare(settings, km, minutes);

    res.json({
      success: true,
      package_id: settings.package_id,
      package_name: settings.name,
      km: Number(km.toFixed(3)),
      minutes: Number(minutes.toFixed(1)),
      fare,
    });
  }catch(e){
    res.status(500).json({ success:false, error:'DB_ERROR' });
  }
});


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


// Protect sensitive admin-only static pages (e.g. pricing) even if someone types the URL
app.use((req, res, next) => {
  // Only guard the pricing page (others can stay public/login-gated by UI)
  if (req.path === '/admin/pricing.html' || req.path === '/admin/pricing') {
    // Allow only logged-in admin (cookie)
    const cookies = parseCookies(req);
    const token = cookies[ADMIN_COOKIE];
    if (!verifyAdmin(token)) {
      // Send to admin login page
      return res.redirect('/admin/index.html');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Basic credential check for passenger/driver API calls (MVP)
function authUser(phone, password, role) {
  return new Promise((resolve) => {
    phone = normPhone(phone);
    password = String(password || '');
    role = normRole(role);
    if (!phone || !password) return resolve(null);

    db.get(
      "SELECT id, phone, role, name, approved, is_online, driver_radius_km FROM users WHERE phone=? AND password=? AND role=?",
      [phone, password, role],
      (err, row) => {
        if (err || !row) return resolve(null);
        resolve(row);
      }
    );
  });
}

// ---------------- Auth (user)

app.post('/api/register', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const role = normRole(req.body.role);
  const name = String(req.body.name || '');

  if (!phone || !password) return res.json({ error: "MISSING_FIELDS" });
  if (password.length < 4) return res.json({ error: "WEAK_PASSWORD" });

  const approved = (role === 'driver') ? 0 : 1; // passengers active by default
  const is_online = 0;

  const defaultRadius = await getSetting('default_radius_km', 4);
  const driver_radius_km = (role === 'driver') ? Number(defaultRadius) : 0;

  db.run(
    "INSERT INTO users (phone, password, role, name, approved, is_online, driver_radius_km) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [phone, password, role, name, approved, is_online, driver_radius_km],
    function (err) {
      if (err) return res.json({ error: "PHONE_ROLE_EXISTS" });
      res.json({ success: true, role, approved, driver_radius_km });
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

      return res.json({ success: true, name: row.name || "", role, is_online, driver_radius_km: Number(row.driver_radius_km||0) });
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
    name: user.name || '',
    driver_radius_km: Number(user.driver_radius_km||0)
  });
});



app.post('/api/driver/set-radius', async (req, res) => {
  const user = await authUser(req.body.phone, req.body.password, 'driver');
  if (!user) return res.json({ error: "INVALID_CREDENTIALS" });
  const approved = parseInt(user.approved, 10) || 0;
  if (approved === 0) return res.json({ error: "DRIVER_NOT_APPROVED" });

  const r = parseInt(req.body.radius_km, 10);
  if (![2,4,8].includes(r)) return res.json({ error: "INVALID_RADIUS" });

  db.run("UPDATE users SET driver_radius_km=? WHERE id=?", [r, user.id], function(e2){
    if (e2) return res.json({ error: "DB_ERROR" });
    res.json({ success: true, driver_radius_km: r });
  });
});


// ---------------- Orders (MVP)

app.post('/api/orders/create', async (req, res) => {
  const passenger = await authUser(req.body.phone, req.body.password, 'passenger');
  if (!passenger) return res.json({ error: 'INVALID_CREDENTIALS' });

  const package_id = String(req.body.package_id || req.body.package || 'economy');

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

  // Estimate (km/fare)
  let est_km = havKm(pickup_lat, pickup_lon, dropoff_lat, dropoff_lon);
  let est_minutes = 0;
  const meta = await osrmRouteMeta(pickup_lon, pickup_lat, dropoff_lon, dropoff_lat);
  if (meta){
    if (Number.isFinite(meta.km) && meta.km > 0) est_km = meta.km;
    if (Number.isFinite(meta.minutes) && meta.minutes > 0) est_minutes = meta.minutes;
  }

  const fareSettings = await getFareSettingsForPackage(package_id);
  const est_fare = computeFare(fareSettings, est_km, est_minutes);

  const created_at = nowMs();
  db.run(
    `INSERT INTO orders (passenger_phone, pickup_text, pickup_lat, pickup_lon, dropoff_text, dropoff_lat, dropoff_lon, status, created_at, updated_at, driver_phone, accepted_at, arrived_at, started_at, completed_at, cancelled_at, est_km, est_minutes, est_fare, fare_package)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    [passenger.phone, pickup_text, pickup_lat, pickup_lon, dropoff_text, dropoff_lat, dropoff_lon, created_at, created_at, est_km, est_minutes, est_fare, fareSettings.package_id],
    function(err){
      if (err) return res.json({ error: 'DB_ERROR' });
      res.json({ success: true, order_id: this.lastID, package_id: fareSettings.package_id, package_name: fareSettings.name, est_km: Number(est_km.toFixed(3)), est_minutes: Number(est_minutes.toFixed(1)), est_fare: Number(est_fare.toFixed(2)) });
    }
  );
});

app.get('/api/orders/my', async (req, res) => {
  const phone = normPhone(req.query.phone);
  const password = String(req.query.password || '');
  const passenger = await authUser(phone, password, 'passenger');
  if (!passenger) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  // DB schema may differ between deploys; build a safe SELECT based on existing columns.
  const cols = await getTableCols('orders');
  const base = ['id','pickup_text','dropoff_text','status','driver_phone','created_at'];
  const optional = [
    'pickup_lat','pickup_lon','dropoff_lat','dropoff_lon',
    'fare_package',
    'est_km','est_fare',
    'real_km','real_minutes','final_fare','admin_fee','driver_earn',
    'accepted_at','arrived_at','started_at','completed_at','cancelled_at','updated_at'
  ];
  const selectCols = base.concat(optional.filter(c => cols.has(c)));

  db.all(
    `SELECT ${selectCols.join(', ')} FROM orders WHERE passenger_phone=? ORDER BY id DESC LIMIT 20`,
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
  if (parseInt(driver.is_online, 10) !== 1) return res.status(403).json({ error: 'DRIVER_OFFLINE' });

  const radiusKm = (Number(driver.driver_radius_km) > 0) ? Number(driver.driver_radius_km) : await getSetting('default_radius_km', 4);

  db.get("SELECT lat, lng, updated_at FROM driver_locations WHERE driver_phone=?", [driver.phone], (eLoc, loc) => {
    if (eLoc) return res.status(500).json({ error: 'DB_ERROR' });

    // If no GPS yet, still return latest orders but without distance filter
    const hasLoc = !!(loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng));

    db.all(
      "SELECT id, passenger_phone, pickup_text, dropoff_text, pickup_lat, pickup_lon, dropoff_lat, dropoff_lon, est_km, est_minutes, est_fare, fare_package, status, created_at FROM orders WHERE status='new' ORDER BY id DESC LIMIT 50",
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB_ERROR' });
        let list = (rows || []).map(o => ({...o}));

        if (hasLoc) {
          list = list.map(o => {
            const d = havKm(loc.lat, loc.lng, Number(o.pickup_lat), Number(o.pickup_lon));
            o.pickup_distance_km = Number(d.toFixed(3));
            return o;
          }).filter(o => Number(o.pickup_distance_km) <= Number(radiusKm));
          list.sort((a,b)=> (a.pickup_distance_km - b.pickup_distance_km));
        }

        res.json({
          success: true,
          radius_km: Number(radiusKm),
          driver_location: hasLoc ? { lat: loc.lat, lng: loc.lng, updated_at: loc.updated_at } : null,
          orders: list
        });
      }
    );
  });
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

  const cols = await getTableCols('orders');
  const base = ['id','passenger_phone','pickup_text','dropoff_text','status','driver_phone','created_at'];
  const optional = [
    'pickup_lat','pickup_lon','dropoff_lat','dropoff_lon',
    'fare_package',
    'est_km','est_fare',
    'real_km','real_minutes','final_fare','admin_fee','driver_earn',
    'accepted_at','arrived_at','started_at','completed_at','cancelled_at','updated_at'
  ];
  const selectCols = base.concat(optional.filter(c => cols.has(c)));

  db.all(
    `SELECT ${selectCols.join(', ')} FROM orders WHERE driver_phone=? ORDER BY id DESC LIMIT 20`,
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

  const dbGet = (sql, params)=>new Promise((resolve,reject)=>db.get(sql, params, (e,row)=> e?reject(e):resolve(row)));
  const dbRun = (sql, params)=>new Promise((resolve,reject)=>db.run(sql, params, function(e){ e?reject(e):resolve(this); }));

  try{
    const row = await dbGet("SELECT * FROM orders WHERE id=?", [order_id]);
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
    if (next === 'in_progress') {
      sets.push('started_at=?'); vals.push(ts);
      // reset real tracking fields
      sets.push('real_km=?'); vals.push(0);
      sets.push('real_minutes=?'); vals.push(0);
      sets.push('final_fare=?'); vals.push(0);
      sets.push('admin_fee=?'); vals.push(0);
      sets.push('driver_earn=?'); vals.push(0);
    }
    if (next === 'completed') { sets.push('completed_at=?'); vals.push(ts); }
    if (next === 'cancelled') { sets.push('cancelled_at=?'); vals.push(ts); }

    vals.push(order_id);
    await dbRun(`UPDATE orders SET ${sets.join(', ')} WHERE id=?`, vals);

    // If ride started, reset track points (additive)
    if (next === 'in_progress') {
      await dbRun('DELETE FROM order_track_points WHERE order_id=?', [order_id]);
    }

    // Fare engine on completion (additive; does not break old flow)
    if (next === 'completed') {
      const ord = await dbGet("SELECT * FROM orders WHERE id=?", [order_id]);
      const started = Number(ord.started_at || 0);
      const completed = Number(ord.completed_at || ts);
      const minutes = started ? Math.max(1, Math.round((completed - started) / 60000)) : Number(ord.real_minutes || 0);

      // Prefer GPS-tracked real_km if available; otherwise OSRM estimate
      let km = Number(ord.real_km || 0);
      if (!Number.isFinite(km) || km < 0.05) {
        km = havKm(Number(ord.pickup_lat), Number(ord.pickup_lon), Number(ord.dropoff_lat), Number(ord.dropoff_lon));
        const meta = await osrmRouteMeta(Number(ord.pickup_lon), Number(ord.pickup_lat), Number(ord.dropoff_lon), Number(ord.dropoff_lat));
        if (meta && Number.isFinite(meta.km) && meta.km > 0) km = meta.km;
      }

      const fare_base = await getSetting('fare_base', 1.0);
      const fare_per_km = await getSetting('fare_per_km', 0.6);
      const fare_per_min = await getSetting('fare_per_min', 0.15);
      const fare_min = await getSetting('fare_min', 2.0);
      const commission_rate = await getSetting('commission_rate', 0.10);

      let final_fare = Number(fare_base) + (Number(fare_per_km) * km) + (Number(fare_per_min) * minutes);
      final_fare = Math.max(Number(fare_min), final_fare);

      const admin_fee = final_fare * Number(commission_rate);
      const driver_earn = final_fare - admin_fee;

      await dbRun(
        "UPDATE orders SET real_km=?, real_minutes=?, final_fare=?, admin_fee=?, driver_earn=? WHERE id=?",
        [km, minutes, final_fare, admin_fee, driver_earn, order_id]
      );

      return res.json({
        success: true,
        fare: {
          real_km: Number(km.toFixed(3)),
          real_minutes: minutes,
          final_fare: Number(final_fare.toFixed(2)),
          admin_fee: Number(admin_fee.toFixed(2)),
          driver_earn: Number(driver_earn.toFixed(2)),
        }
      });
    }

    res.json({ success: true });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'DB_ERROR' });
  }
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

      // If driver has an active in-progress order, append GPS track point and update real_km/minutes
      db.get(
        "SELECT id, started_at, real_km FROM orders WHERE driver_phone=? AND status='in_progress' ORDER BY id DESC LIMIT 1",
        [driver.phone],
        (e1, ord) => {
          if (e1 || !ord) return res.json({ success: true });

          db.get(
            "SELECT lat, lng FROM order_track_points WHERE order_id=? ORDER BY id DESC LIMIT 1",
            [ord.id],
            (e2, last) => {
              if (e2) return res.json({ success: true });

              // Always insert first point
              if (!last) {
                db.run(
                  "INSERT INTO order_track_points(order_id, driver_phone, lat, lng, created_at) VALUES(?,?,?,?,?)",
                  [ord.id, driver.phone, lat, lng, ts],
                  () => res.json({ success: true })
                );
                return;
              }

              const distKm = havKm(Number(last.lat), Number(last.lng), lat, lng);
              // filter GPS noise (>=10m)
              if (!Number.isFinite(distKm) || distKm < 0.01) return res.json({ success: true });

              const startedAt = Number(ord.started_at || 0);
              const minutes = startedAt ? Math.max(0, Math.round((ts - startedAt) / 60000)) : 0;
              const newKm = Number(ord.real_km || 0) + distKm;

              db.run(
                "INSERT INTO order_track_points(order_id, driver_phone, lat, lng, created_at) VALUES(?,?,?,?,?)",
                [ord.id, driver.phone, lat, lng, ts],
                () => {
                  db.run(
                    "UPDATE orders SET real_km=?, real_minutes=? WHERE id=?",
                    [newKm, minutes, ord.id],
                    () => res.json({ success: true })
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});


app.get('/api/driver/location/get', (req, res) => {
  const driver_phone = normPhone(req.query.driver_phone);
  if (!driver_phone) return res.status(400).json({ error: 'DRIVER_PHONE_REQUIRED' });

  db.get("SELECT lat, lng, updated_at FROM driver_locations WHERE driver_phone=?", [driver_phone], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB_ERROR' });
    if (!row) return res.json({ success: true, location: null });
    res.json({ success: true, location: { lat: row.lat, lon: row.lng, updated_at: row.updated_at } });
  });
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



// ---------------- Public settings endpoint for the client (single source of truth for pricing)
// GET is public (needed for passenger estimate UI), POST is admin-only (updates settings)
app.get('/api/settings', async (req, res) => {
  // Backward compatible: return economy package as the "default" pricing.
  const eco = await getFareSettingsForPackage('economy');
  const fare_base = eco.fare_base;
  const fare_per_km = eco.fare_per_km;
  const fare_per_min = eco.fare_per_min;
  const fare_min = eco.fare_min;
  const commission_rate = eco.commission_rate;

  // Backward-compatible aliases (some pages expect these names)
  res.json({
    success: true,
    fare_base,
    fare_per_km,
    fare_per_min,
    fare_min,
    commission_rate,
    commission: Math.round(Number(commission_rate) * 100) // percent
  });
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  const b = req.body || {};
  // Accept both new and old field names
  const fare_base = Number(b.fare_base);
  const fare_per_km = Number(b.fare_per_km);
  const fare_per_min = Number(b.fare_per_min);
  const fare_min = Number(b.fare_min);
  const commission_rate = (b.commission_rate !== undefined)
    ? Number(b.commission_rate)
    : (b.commission !== undefined ? (Number(b.commission) / 100) : NaN);

  // Validate minimally (keep flexible, but avoid NaN)
  // Keep legacy keys updated
  if (Number.isFinite(fare_base)) await setSetting('fare_base', fare_base);
  if (Number.isFinite(fare_per_km)) await setSetting('fare_per_km', fare_per_km);
  if (Number.isFinite(fare_per_min)) await setSetting('fare_per_min', fare_per_min);
  if (Number.isFinite(fare_min)) await setSetting('fare_min', fare_min);
  if (Number.isFinite(commission_rate)) await setSetting('commission_rate', commission_rate);

  // Also update economy package so all clients stay consistent.
  const pkgs = await getFarePackages();
  pkgs.economy = pkgs.economy || { name:'Ekonom' };
  if (Number.isFinite(fare_base)) pkgs.economy.fare_base = fare_base;
  if (Number.isFinite(fare_per_km)) pkgs.economy.fare_per_km = fare_per_km;
  if (Number.isFinite(fare_per_min)) pkgs.economy.fare_per_min = fare_per_min;
  if (Number.isFinite(fare_min)) pkgs.economy.fare_min = fare_min;
  if (Number.isFinite(commission_rate)) pkgs.economy.commission_rate = commission_rate;
  await setFarePackages(pkgs);

  res.json({ success: true });
});


// ---------------- Fare packages API
// Public: list packages for passenger UI
app.get('/api/fare-packages', async (req, res) => {
  try{
    const pkgs = await getFarePackages();
    const list = Object.entries(pkgs).map(([id, p]) => ({
      id,
      name: p.name,
      fare_base: p.fare_base,
      fare_per_km: p.fare_per_km,
      fare_per_min: p.fare_per_min,
      fare_min: p.fare_min,
      commission_rate: p.commission_rate,
      commission: Math.round(Number(p.commission_rate||0) * 100),
    }));
    // stable ordering
    const order = { economy: 1, comfort: 2, business: 3 };
    list.sort((a,b)=> (order[a.id]||99) - (order[b.id]||99));
    res.json({ success:true, packages: list });
  }catch(e){
    res.status(500).json({ success:false, error:'DB_ERROR' });
  }
});

// Admin: update one package (keeps changes additive)
app.post('/api/fare-packages', requireAdmin, async (req, res) => {
  try{
    const b = req.body || {};
    const id = String(b.id || b.package_id || '').toLowerCase().trim();
    if (!id) return res.status(400).json({ success:false, error:'MISSING_ID' });

    const pkgs = await getFarePackages();
    const cur = pkgs[id] || { name: (b.name || id) };

    const upd = {
      name: (b.name != null ? String(b.name) : cur.name),
      fare_base: Number.isFinite(Number(b.fare_base)) ? Number(b.fare_base) : Number(cur.fare_base)||0,
      fare_per_km: Number.isFinite(Number(b.fare_per_km)) ? Number(b.fare_per_km) : Number(cur.fare_per_km)||0,
      fare_per_min: Number.isFinite(Number(b.fare_per_min)) ? Number(b.fare_per_min) : Number(cur.fare_per_min)||0,
      fare_min: Number.isFinite(Number(b.fare_min)) ? Number(b.fare_min) : Number(cur.fare_min)||0,
      commission_rate: (b.commission_rate != null)
        ? Number(b.commission_rate)
        : (b.commission != null ? (Number(b.commission)/100) : (Number(cur.commission_rate)||0)),
    };

    pkgs[id] = upd;
    await setFarePackages(pkgs);

    // Keep legacy keys in sync with economy to avoid any UI drift
    if (id === 'economy'){
      await setSetting('fare_base', upd.fare_base);
      await setSetting('fare_per_km', upd.fare_per_km);
      await setSetting('fare_per_min', upd.fare_per_min);
      await setSetting('fare_min', upd.fare_min);
      await setSetting('commission_rate', upd.commission_rate);
    }

    res.json({ success:true });
  }catch(e){
    res.status(500).json({ success:false, error:'DB_ERROR' });
  }
});


app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const s = {
    default_radius_km: await getSetting('default_radius_km', 4),
    fare_base: await getSetting('fare_base', 1.0),
    fare_per_km: await getSetting('fare_per_km', 0.6),
    fare_per_min: await getSetting('fare_per_min', 0.15),
    fare_min: await getSetting('fare_min', 2.0),
    commission_rate: await getSetting('commission_rate', 0.10),
  };
  res.json({ success: true, settings: s });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  const updates = {};
  if (req.body.default_radius_km != null) {
    const r = parseInt(req.body.default_radius_km, 10);
    if (![2,4,8].includes(r)) return res.status(400).json({ error: 'INVALID_RADIUS' });
    updates.default_radius_km = r;
    await setSetting('default_radius_km', r);
  }
  // Optional: allow pricing edits later (kept additive)
  for (const k of ['fare_base','fare_per_km','fare_per_min','fare_min','commission_rate']) {
    if (req.body[k] != null) {
      const v = Number(req.body[k]);
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'INVALID_VALUE' });
      updates[k] = v;
      await setSetting(k, v);
    }
  }
  res.json({ success: true, updates });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  db.get(
    "SELECT COUNT(*) as rides, COALESCE(SUM(final_fare),0) as total_turnover, COALESCE(SUM(admin_fee),0) as total_commission FROM orders WHERE status='completed'",
    [],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      res.json({ success: true, stats: row });
    }
  );
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
          driver_radius_km INTEGER DEFAULT 4,
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
              updated_at INTEGER,
              est_km REAL,
              est_fare REAL,
              real_km REAL,
              real_minutes REAL,
              final_fare REAL,
              admin_fee REAL,
              driver_earn REAL
            )`, (err4) => {
              if (err4) return res.status(500).send("DB_ERROR");

              db.run(`CREATE TABLE IF NOT EXISTS driver_locations (
                driver_phone TEXT PRIMARY KEY,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                updated_at INTEGER NOT NULL
              )`, (err5) => {
                if (err5) return res.status(500).send("DB_ERROR");
                
db.run(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`, ()=>{
  // seed defaults
  db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('default_radius_km','4')");
  db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('fare_base','1')");
  db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('fare_per_km','0.6')");
  db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('fare_per_min','0.15')");
  db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('fare_min','2')");
  db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('commission_rate','0.10')");
  res.send("OK_RESET");
});

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
