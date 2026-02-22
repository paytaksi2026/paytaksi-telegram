const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

// ---------------- Real-time (SSE): order status + driver location
// Lightweight server-sent events. Clients subscribe per order_id.
const sseOrderClients = new Map(); // order_id -> Set(res)

function sseWrite(res, event, data){
  try{
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
  }catch(_){ /* ignore */ }
}

function sseBroadcast(orderId, event, data){
  const key = String(orderId);
  const set = sseOrderClients.get(key);
  if (!set || set.size === 0) return;
  for (const r of Array.from(set)){
    if (!r || r.writableEnded) { set.delete(r); continue; }
    sseWrite(r, event, data);
  }
  if (set.size === 0) sseOrderClients.delete(key);
}

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
    allowed_packages TEXT DEFAULT 'economy,comfort,business', -- admin-granted fare packages
    enabled_packages TEXT DEFAULT 'economy,comfort,business', -- driver enabled subset (can only toggle within allowed)
UNIQUE(phone, role)
  )`);

  // Ensure columns if older DB exists
  ensureColumn('users', 'approved', 'approved INTEGER DEFAULT 0');
  ensureColumn('users', 'is_online', 'is_online INTEGER DEFAULT 0');
  ensureColumn('users', 'driver_radius_km', 'driver_radius_km INTEGER DEFAULT 4');
  ensureColumn('users', 'allowed_packages', "allowed_packages TEXT DEFAULT 'economy,comfort,business'");
  ensureColumn('users', 'enabled_packages', "enabled_packages TEXT DEFAULT 'economy,comfort,business'");

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
  seedSetting('fare_base', 3.5);
  seedSetting('fare_per_km', 0.4);
  seedSetting('fare_per_min', 0.0);
  seedSetting('fare_min', 3.5);
  seedSetting('commission_rate', 0.10);

  // Fare packages (JSON). Additive + backward compatible.
  // Stored in settings to keep migrations minimal.
  // Default packages are derived from the base fare settings above.
  seedSetting('fare_packages_json', JSON.stringify({
    economy:  { name: 'Ekonom',  fare_base: 3.5, fare_per_km: 0.4, fare_per_min: 0.0, fare_min: 3.5, commission_rate: 0.10 },
    comfort:  { name: 'Komfort', fare_base: 4.0, fare_per_km: 0.5, fare_per_min: 0.0, fare_min: 4.0, commission_rate: 0.13 },
    business: { name: 'Biznes',  fare_base: 5.0, fare_per_km: 0.6, fare_per_min: 0.0, fare_min: 5.0, commission_rate: 0.16 }
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

  // ---------------- Wallet (driver earnings + admin fees) - additive
  // Stores wallet balances per (role, phone).
  db.run(`CREATE TABLE IF NOT EXISTS wallet_balances (
    role TEXT NOT NULL,
    phone TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(role, phone)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    phone TEXT NOT NULL,
    type TEXT NOT NULL,               -- credit | debit | adjust | withdraw
    amount REAL NOT NULL,
    ref_order_id INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_role_phone ON wallet_transactions(role, phone, id)`);

  // Driver withdrawal requests (MVP: log-only)
  db.run(`CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status, id)`);
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

// ---------------- Wallet helpers
const ADMIN_WALLET_PHONE = '__admin__';

function toMoney(n){
  const x = Number(n);
  if(!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

async function ensureWalletRow(role, phone){
  role = String(role||'').toLowerCase().trim();
  phone = String(phone||'').trim();
  const t = nowMs();
  return await new Promise((resolve)=>{
    db.run(
      "INSERT INTO wallet_balances(role,phone,balance,updated_at) VALUES (?,?,0,?) ON CONFLICT(role,phone) DO UPDATE SET updated_at=updated_at",
      [role, phone, t],
      ()=> resolve(true)
    );
  });
}

async function getWalletBalance(role, phone){
  await ensureWalletRow(role, phone);
  return await new Promise((resolve)=>{
    db.get("SELECT balance FROM wallet_balances WHERE role=? AND phone=?", [role, phone], (e,row)=>{
      if(e||!row) return resolve(0);
      resolve(toMoney(row.balance));
    });
  });
}

async function walletTx(role, phone, type, amount, refOrderId=null, note=null){
  role = String(role||'').toLowerCase().trim();
  phone = String(phone||'').trim();
  const amt = Number(amount);
  if(!Number.isFinite(amt) || amt === 0) return false;
  await ensureWalletRow(role, phone);
  const t = nowMs();
  return await new Promise((resolve)=>{
    db.serialize(()=>{
      db.run(
        "INSERT INTO wallet_transactions(role,phone,type,amount,ref_order_id,note,created_at) VALUES (?,?,?,?,?,?,?)",
        [role, phone, String(type||'').trim(), amt, refOrderId, note, t]
      );
      db.run(
        "UPDATE wallet_balances SET balance = balance + ?, updated_at=? WHERE role=? AND phone=?",
        [amt, t, role, phone],
        (e)=> resolve(!e)
      );
    });
  });
}

async function getWalletTransactions(role, phone, limit=30){
  await ensureWalletRow(role, phone);
  const lim = Math.max(1, Math.min(100, Number(limit)||30));
  return await new Promise((resolve)=>{
    db.all(
      "SELECT id,type,amount,ref_order_id,note,created_at FROM wallet_transactions WHERE role=? AND phone=? ORDER BY id DESC LIMIT ?",
      [role, phone, lim],
      (e, rows)=> resolve((rows||[]).map(r=>({
        id:r.id,
        type:r.type,
        amount:toMoney(r.amount),
        ref_order_id:r.ref_order_id,
        note:r.note||'',
        created_at:r.created_at
      })))
    );
  });
}

async function walletCreditOnceForOrder(orderId, driverPhone, adminFee, driverEarn){
  const oid = Number(orderId);
  if(!Number.isFinite(oid) || oid<=0) return false;
  const t = nowMs();
  // Skip if already credited for this order
  const already = await new Promise((resolve)=>{
    db.get(
      "SELECT id FROM wallet_transactions WHERE ref_order_id=? AND note='order_complete' LIMIT 1",
      [oid],
      (e,row)=> resolve(!!row)
    );
  });
  if(already) return true;

  const adminAmt = toMoney(adminFee);
  const driverAmt = toMoney(driverEarn);
  // Record admin fee (platform wallet) and driver earnings
  if(adminAmt > 0){
    await walletTx('admin', ADMIN_WALLET_PHONE, 'credit', adminAmt, oid, 'order_complete');
  }
  if(driverAmt !== 0){
    await walletTx('driver', driverPhone, 'credit', driverAmt, oid, 'order_complete');
  }
  return true;
}

function parseAllowedPackages(raw){
  // Accept comma string or JSON array string
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map(x=>String(x).toLowerCase().trim()).filter(Boolean);
  } catch(_){/* ignore */}
  return s.split(',').map(x=>String(x).toLowerCase().trim()).filter(Boolean);
}

async function normalizeAllowedPackages(input){
  const pkgs = await getFarePackages();
  const valid = new Set(Object.keys(pkgs || {}).map(x=>String(x).toLowerCase().trim()).filter(Boolean));
  const list = parseAllowedPackages(input).filter(x=>valid.has(x));
  // ensure at least economy
  const out = Array.from(new Set(list.length ? list : ['economy']));
  return out;
}

async function defaultAllowedPackages(){
  const pkgs = await getFarePackages();
  const ids = Object.keys(pkgs || {}).map(x=>String(x).toLowerCase().trim()).filter(Boolean);
  const order = { economy: 1, comfort: 2, business: 3 };
  ids.sort((a,b)=> (order[a]||99)-(order[b]||99));
  return ids.length ? ids : ['economy'];
}

async function getEnabledPackagesForUser(user){
  const allowed = new Set(await normalizeAllowedPackages(user && user.allowed_packages));
  const enabledRaw = (user && (user.enabled_packages ?? user.allowed_packages)) || '';
  const enabled = parseAllowedPackages(enabledRaw).filter(x=>allowed.has(String(x).toLowerCase().trim()));
  const out = Array.from(new Set(enabled));
  return out.length ? out : Array.from(allowed);
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
      "SELECT id, phone, role, name, approved, is_online, driver_radius_km, allowed_packages, enabled_packages FROM users WHERE phone=? AND password=? AND role=?",
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

  // For drivers, default allowed packages is all packages currently configured.
  const allowed_packages = (role === 'driver') ? (await defaultAllowedPackages()).join(',') : '';
  const enabled_packages = (role === 'driver') ? allowed_packages : '';

  db.run(
    "INSERT INTO users (phone, password, role, name, approved, is_online, driver_radius_km, allowed_packages, enabled_packages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [phone, password, role, name, approved, is_online, driver_radius_km, allowed_packages, enabled_packages],
    function (err) {
      if (err) return res.json({ error: "PHONE_ROLE_EXISTS" });
      res.json({ success: true, role, approved, driver_radius_km, allowed_packages: parseAllowedPackages(allowed_packages), enabled_packages: parseAllowedPackages(enabled_packages) });
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
      const allowed_packages = parseAllowedPackages(row.allowed_packages);
      const enabled_packages = parseAllowedPackages(row.enabled_packages || row.allowed_packages);

      if (role === "driver" && approved === 0) {
        return res.json({ pending: true, name: row.name || "", role });
      }

      return res.json({ success: true, name: row.name || "", role, is_online, driver_radius_km: Number(row.driver_radius_km||0), allowed_packages, enabled_packages });
    }
  );
});

// ---------------- Wallet (MVP)
// Returns balance + recent transactions for the authenticated user.
app.post('/api/wallet', async (req, res) => {
  const role = normRole(req.body.role);
  const user = await authUser(req.body.phone, req.body.password, role);
  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (role === 'driver' && parseInt(user.approved, 10) !== 1) return res.status(403).json({ error: 'DRIVER_PENDING' });

  const phone = user.phone;
  const balance = await getWalletBalance(role, phone);
  const tx = await getWalletTransactions(role, phone, 30);

  // Pending withdrawals (drivers only)
  let withdrawals = [];
  if (role === 'driver') {
    withdrawals = await new Promise((resolve)=>{
      db.all(
        "SELECT id, amount, method, details, status, created_at, updated_at FROM withdrawal_requests WHERE role='driver' AND phone=? ORDER BY id DESC LIMIT 20",
        [phone],
        (e, rows)=> resolve((rows||[]).map(r=>({
          id:r.id,
          amount: toMoney(r.amount),
          method: r.method||'',
          details: r.details||'',
          status: r.status||'pending',
          created_at: r.created_at,
          updated_at: r.updated_at||null
        })))
      );
    });
  }

  return res.json({ success: true, role, phone, balance, transactions: tx, withdrawals });
});

// Driver creates a withdrawal request (log-only MVP)
app.post('/api/driver/withdraw/request', async (req, res) => {
  const driver = await authUser(req.body.phone, req.body.password, 'driver');
  if (!driver) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (parseInt(driver.approved, 10) !== 1) return res.status(403).json({ error: 'DRIVER_PENDING' });

  const amount = toMoney(req.body.amount);
  const method = String(req.body.method || '').trim();
  const details = String(req.body.details || '').trim();
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'BAD_AMOUNT' });
  if (!method) return res.status(400).json({ error: 'METHOD_REQUIRED' });

  const bal = await getWalletBalance('driver', driver.phone);
  if (amount > bal) return res.status(400).json({ error: 'INSUFFICIENT_BALANCE', balance: bal });

  const ts = nowMs();
  db.run(
    "INSERT INTO withdrawal_requests(role,phone,amount,method,details,status,created_at) VALUES ('driver',?,?,?,?, 'pending', ?)",
    [driver.phone, amount, method, details, ts],
    function(e){
      if(e) return res.status(500).json({ error: 'DB_ERROR' });
      // NOTE: In MVP we do NOT debit balance automatically until admin marks as paid.
      return res.json({ success: true, request_id: this.lastID });
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
    driver_radius_km: Number(user.driver_radius_km||0),
    allowed_packages: parseAllowedPackages(user.allowed_packages),
    enabled_packages: parseAllowedPackages(user.enabled_packages || user.allowed_packages)
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


// Driver: set enabled fare packages (subset of admin-granted allowed_packages)
app.post('/api/driver/set-packages', async (req, res) => {
  const user = await authUser(req.body.phone, req.body.password, 'driver');
  if (!user) return res.json({ error: "INVALID_CREDENTIALS" });
  const approved = parseInt(user.approved, 10) || 0;
  if (approved === 0) return res.json({ error: "DRIVER_NOT_APPROVED" });

  const wanted = req.body.enabled_packages ?? req.body.packages ?? req.body.allowed ?? req.body.allowed_packages;
  const requested = await normalizeAllowedPackages(wanted);

  const allowed = new Set(await normalizeAllowedPackages(user.allowed_packages));
  const bad = requested.filter(x => !allowed.has(String(x).toLowerCase().trim()));
  if (bad.length) return res.status(403).json({ error: 'PACKAGE_NOT_ALLOWED', not_allowed: bad });

  const list = requested.length ? requested : Array.from(allowed);
  const value = list.join(',');

  db.run("UPDATE users SET enabled_packages=? WHERE id=?", [value, user.id], function(e2){
    if (e2) return res.json({ error: "DB_ERROR" });
    res.json({ success: true, allowed_packages: parseAllowedPackages(user.allowed_packages), enabled_packages: list });
  });
});


// ---------------- Orders (MVP)

// Passenger: real-time stream for a single order (status + driver_location)
// Usage (browser): new EventSource(`/api/orders/stream?order_id=1&phone=...&password=...`)
app.get('/api/orders/stream', async (req, res) => {
  const phone = normPhone(req.query.phone);
  const password = String(req.query.password || '');
  const passenger = await authUser(phone, password, 'passenger');
  if (!passenger) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const order_id = parseInt(req.query.order_id, 10);
  if (!order_id) return res.status(400).json({ error: 'ORDER_ID_REQUIRED' });

  // Ensure passenger owns the order
  const ord = await new Promise((resolve)=>{
    db.get(
      "SELECT id, passenger_phone, status, driver_phone, fare_package, accepted_at, arrived_at, started_at, completed_at, cancelled_at, updated_at FROM orders WHERE id=?",
      [order_id],
      (e,row)=> resolve(e ? null : (row||null))
    );
  });
  if (!ord) return res.status(404).json({ error: 'NOT_FOUND' });
  if (String(ord.passenger_phone || '') !== passenger.phone) return res.status(403).json({ error: 'FORBIDDEN' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Some proxies buffer; this header helps on certain setups
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  // Register
  const key = String(order_id);
  if (!sseOrderClients.has(key)) sseOrderClients.set(key, new Set());
  sseOrderClients.get(key).add(res);

  // Send initial snapshot
  sseWrite(res, 'snapshot', {
    order: {
      id: ord.id,
      status: ord.status,
      driver_phone: ord.driver_phone,
      fare_package: ord.fare_package,
      accepted_at: ord.accepted_at,
      arrived_at: ord.arrived_at,
      started_at: ord.started_at,
      completed_at: ord.completed_at,
      cancelled_at: ord.cancelled_at,
      updated_at: ord.updated_at,
    }
  });

  // Keep-alive ping (prevents idle timeouts)
  const ka = setInterval(() => {
    if (res.writableEnded) return;
    try{ res.write(': ping\n\n'); }catch(_){/* ignore */}
  }, 25000);

  req.on('close', () => {
    clearInterval(ka);
    const set = sseOrderClients.get(key);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseOrderClients.delete(key);
    }
  });
});

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

  // Filter new orders by driver's allowed packages
  const enabledList = await getEnabledPackagesForUser(driver);
  const enabledSet = new Set(enabledList);

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
        let list = (rows || []).map(o => ({...o})).filter(o => allowedSet.has(String(o.fare_package || 'economy').toLowerCase().trim()));

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
          allowed_packages: parseAllowedPackages(driver.allowed_packages),
          enabled_packages: enabledList,
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

  // Enforce driver's allowed packages (server-side)
  const enabledList = await getEnabledPackagesForUser(driver);
  const enabledSet = new Set(enabledList);
  const orderPkgRow = await new Promise((resolve)=>{
    db.get("SELECT id, fare_package, status FROM orders WHERE id=?", [order_id], (e,row)=> resolve(row||null));
  });
  if (!orderPkgRow) return res.status(404).json({ error: 'NOT_FOUND' });
  const pkgId = String(orderPkgRow.fare_package || 'economy').toLowerCase().trim();
  if (!allowedSet.has(pkgId)) return res.status(403).json({ error: 'PACKAGE_NOT_ALLOWED' });

  const accepted_at = nowMs();
  db.run(
    "UPDATE orders SET status='accepted', driver_phone=?, accepted_at=?, updated_at=? WHERE id=? AND status='new'",
    [driver.phone, accepted_at, accepted_at, order_id],
    function(err){
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (this.changes === 0) return res.status(409).json({ error: 'NOT_AVAILABLE' });

      // Real-time notify passenger
      db.get(
        "SELECT id, status, driver_phone, accepted_at, arrived_at, started_at, completed_at, cancelled_at, updated_at FROM orders WHERE id=?",
        [order_id],
        (e2, row2) => {
          if (!e2 && row2) sseBroadcast(order_id, 'status', { order: row2 });
        }
      );

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

// Passenger: cancel order (allowed before ride starts)
app.post('/api/orders/cancel', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const passenger = await authUser(phone, password, 'passenger');
  if (!passenger) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const order_id = parseInt(req.body.order_id, 10);
  if (!order_id) return res.status(400).json({ error: 'ORDER_ID_REQUIRED' });

  const ts = nowMs();
  db.run(
    "UPDATE orders SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=? AND passenger_phone=? AND status IN ('new','accepted') AND (started_at IS NULL OR started_at=0)",
    [ts, ts, order_id, passenger.phone],
    function(err){
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (this.changes === 0) return res.status(409).json({ error: 'NOT_CANCELLABLE' });

      // Real-time notify (if passenger has multiple tabs)
      db.get(
        "SELECT id, status, driver_phone, accepted_at, arrived_at, started_at, completed_at, cancelled_at, updated_at FROM orders WHERE id=?",
        [order_id],
        (e2, row2) => {
          if (!e2 && row2) sseBroadcast(order_id, 'status', { order: row2 });
        }
      );

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
  // Backward compatible aliases
  let next = String(req.body.status || '').toLowerCase().trim();
  if (next === 'started') next = 'in_progress';
  if (next === 'finished') next = 'completed';
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

    // Real-time notify passenger about status change ASAP
    try {
      const snap = await dbGet(
        "SELECT id, status, driver_phone, accepted_at, arrived_at, started_at, completed_at, cancelled_at, updated_at, fare_package FROM orders WHERE id=?",
        [order_id]
      );
      if (snap) sseBroadcast(order_id, 'status', { order: snap });
    } catch(_){ /* ignore */ }

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

      // IMPORTANT: use the fare package of this order (single source of truth)
      const pkgSettings = await getFareSettingsForPackage(ord.fare_package || 'economy');
      const final_fare = computeFare(pkgSettings, km, minutes);

      const cr = Number(pkgSettings.commission_rate) || 0;
      const admin_fee = Math.round((final_fare * cr) * 100) / 100;
      const driver_earn = Math.round((final_fare - admin_fee) * 100) / 100;

      await dbRun(
        "UPDATE orders SET real_km=?, real_minutes=?, final_fare=?, admin_fee=?, driver_earn=? WHERE id=?",
        [km, minutes, final_fare, admin_fee, driver_earn, order_id]
      );

      // Wallet credit (MVP): credit driver earnings + platform admin fee exactly once.
      try{
        await walletCreditOnceForOrder(order_id, driver.phone, admin_fee, driver_earn);
      }catch(_){ /* do not block completion */ }

      // Real-time notify with final fare
      try {
        const snap2 = await dbGet(
          "SELECT id, status, driver_phone, accepted_at, arrived_at, started_at, completed_at, cancelled_at, updated_at, fare_package, real_km, real_minutes, final_fare, admin_fee, driver_earn FROM orders WHERE id=?",
          [order_id]
        );
        if (snap2) sseBroadcast(order_id, 'status', { order: snap2, fare: { real_km: snap2.real_km, real_minutes: snap2.real_minutes, final_fare: snap2.final_fare, admin_fee: snap2.admin_fee, driver_earn: snap2.driver_earn } });
      } catch(_){ /* ignore */ }

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

      // Real-time: broadcast driver location to passenger if there's an active order
      db.get(
        "SELECT id FROM orders WHERE driver_phone=? AND status IN ('accepted','arrived','in_progress') ORDER BY id DESC LIMIT 1",
        [driver.phone],
        (eAct, act) => {
          if (!eAct && act && act.id) {
            sseBroadcast(act.id, 'location', { order_id: act.id, location: { lat, lng, updated_at: ts } });
          }
        }
      );

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

  db.all(`SELECT id, phone, name, approved, is_online, allowed_packages, enabled_packages FROM users WHERE ${where} ORDER BY approved ASC, is_online DESC, id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB_ERROR' });
    const list = (rows || []).map(r => ({
      ...r,
      allowed_packages: parseAllowedPackages(r.allowed_packages),
      enabled_packages: parseAllowedPackages(r.enabled_packages || r.allowed_packages)
    }));
    res.json({ success: true, drivers: list });
  });
});

// Admin: set driver's allowed packages
app.post('/api/admin/driver/packages', requireAdmin, async (req, res) => {
  try{
    const id = parseInt(req.body.id, 10);
    if (!id) return res.status(400).json({ error:'ID_REQUIRED' });

    const wanted = req.body.allowed_packages ?? req.body.packages ?? req.body.allowed;
    const allowedList = await normalizeAllowedPackages(wanted);
    const allowedValue = allowedList.join(',');

    db.get("SELECT enabled_packages FROM users WHERE id=? AND role='driver'", [id], (e0, row0)=>{
      if (e0) return res.status(500).json({ error:'DB_ERROR' });
      const prevEnabled = parseAllowedPackages(row0 && row0.enabled_packages);
      const allowedSet = new Set(allowedList);
      let enabledList = prevEnabled.filter(x=>allowedSet.has(String(x).toLowerCase().trim()));
      if (!enabledList.length) enabledList = allowedList.slice();
      const enabledValue = enabledList.join(',');

      db.run("UPDATE users SET allowed_packages=?, enabled_packages=? WHERE id=? AND role='driver'", [allowedValue, enabledValue, id], function(err){
        if (err) return res.status(500).json({ error:'DB_ERROR' });
        res.json({ success:true, changes: this.changes || 0, allowed_packages: allowedList, enabled_packages: enabledList });
      });
    });
  }catch(e){
    res.status(500).json({ error:'DB_ERROR' });
  }
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

// Admin: list withdrawal requests
app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit)||100));
  const status = String(req.query.status||'').trim();
  const where = status ? "WHERE status=?" : "";
  const params = status ? [status] : [];
  db.all(
    `SELECT id, role, phone, amount, method, details, status, created_at, updated_at FROM withdrawal_requests ${where} ORDER BY id DESC LIMIT ?`,
    [...params, limit],
    (e, rows) => {
      if (e) return res.status(500).json({ error: 'DB_ERROR' });
      res.json({ success: true, items: (rows||[]).map(r=>({
        id:r.id,
        role:r.role,
        phone:r.phone,
        amount: toMoney(r.amount),
        method:r.method||'',
        details:r.details||'',
        status:r.status||'pending',
        created_at:r.created_at,
        updated_at:r.updated_at||null
      })) });
    }
  );
});

// Admin: update withdrawal status. When marking as paid, debit driver wallet once.
app.post('/api/admin/withdrawals/status', requireAdmin, async (req, res) => {
  const id = Number(req.body.id);
  const next = String(req.body.status||'').trim().toLowerCase();
  if(!Number.isFinite(id) || id<=0) return res.status(400).json({ error: 'BAD_ID' });
  if(!['pending','approved','rejected','paid'].includes(next)) return res.status(400).json({ error: 'BAD_STATUS' });

  db.get("SELECT * FROM withdrawal_requests WHERE id=?", [id], async (e, row) => {
    if(e) return res.status(500).json({ error: 'DB_ERROR' });
    if(!row) return res.status(404).json({ error: 'NOT_FOUND' });

    const ts = nowMs();
    db.run("UPDATE withdrawal_requests SET status=?, updated_at=? WHERE id=?", [next, ts, id], async (e2)=>{
      if(e2) return res.status(500).json({ error: 'DB_ERROR' });

      // Debit wallet only when paid, and only once
      if(next === 'paid' && row.role === 'driver'){
        try{
          const already = await new Promise((resolve)=>{
            db.get(
              "SELECT id FROM wallet_transactions WHERE note='withdraw_paid' AND ref_order_id IS NULL AND role='driver' AND phone=? AND amount=? LIMIT 1",
              [row.phone, -toMoney(row.amount)],
              (e3, r3)=> resolve(!!r3)
            );
          });
          if(!already){
            await walletTx('driver', row.phone, 'withdraw', -toMoney(row.amount), null, 'withdraw_paid');
          }
        }catch(_){ /* ignore */ }
      }
      res.json({ success: true });
    });
  });
});

// Admin: view platform wallet (admin fees)
app.get('/api/admin/wallet', requireAdmin, async (req, res) => {
  const balance = await getWalletBalance('admin', ADMIN_WALLET_PHONE);
  const tx = await getWalletTransactions('admin', ADMIN_WALLET_PHONE, 50);
  res.json({ success: true, role: 'admin', phone: ADMIN_WALLET_PHONE, balance, transactions: tx });
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
