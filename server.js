const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const USER_COOKIE = 'pt_sess';

function normPhone(p) {
  return String(p || '').trim();
}

function hashToken(raw) {
  // store hashed token in DB (so if db leaks, cookie token isn't reusable)
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  // On Render you're on HTTPS; Secure is good, but keep optional for local dev
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const cookies = header.split(';').map(s => s.trim()).filter(Boolean);
  for (const c of cookies) {
    const idx = c.indexOf('=');
    if (idx === -1) continue;
    const k = c.slice(0, idx);
    const v = c.slice(idx + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return '';
}

function requireUser(req, res, next) {
  const raw = readCookie(req, USER_COOKIE);
  if (!raw) return res.status(401).json({ error: 'NO_SESSION' });
  const tokenHash = hashToken(raw);

  db.get(
    `SELECT s.id as sid, u.id, u.phone, u.role, u.name, u.approved, u.is_online
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=?`,
    [tokenHash],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (!row) return res.status(401).json({ error: 'INVALID_SESSION' });
      req.user = row;
      next();
    }
  );
}

// --- DB init

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT,
    approved INTEGER DEFAULT 0,
    is_online INTEGER DEFAULT 0,
    UNIQUE(phone, role)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

// --- API

app.post('/api/register', (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const role = String(req.body.role || '');
  const name = String(req.body.name || '');

  if (!phone || !password || !role) return res.json({ error: 'MISSING_FIELDS' });
  if (!['passenger','driver'].includes(role)) return res.json({ error: 'INVALID_ROLE' });
  if (role === 'driver' && !name.trim()) return res.json({ error: 'NAME_REQUIRED' });

  db.run(
    'INSERT INTO users (phone, password, role, name, approved, is_online) VALUES (?, ?, ?, ?, ?, 0)',
    [phone, password, role, name, role === 'driver' ? 0 : 1],
    function(err) {
      if (err) return res.json({ error: 'PHONE_ROLE_EXISTS' });
      res.json({
        success: true,
        message: `Hörmətli ${name || 'istifadəçi'}, siz qeydiyyatdan keçdiniz. Login: ${phone}  Parol: ${password}`
      });
    }
  );
});

app.post('/api/login', (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const role = String(req.body.role || '');

  if (!phone || !password || !role) return res.json({ error: 'MISSING_FIELDS' });
  if (!['passenger','driver'].includes(role)) return res.json({ error: 'INVALID_ROLE' });

  db.get(
    'SELECT id, phone, role, name, approved FROM users WHERE phone=? AND password=? AND role=?',
    [phone, password, role],
    (err, row) => {
      if (err) return res.json({ error: 'DB_ERROR' });
      if (!row) return res.json({ error: 'INVALID_CREDENTIALS' });

      if (role === 'driver' && (parseInt(row.approved,10)||0) === 0) {
        return res.json({ pending: true, name: row.name || '' });
      }

      const raw = makeToken();
      const tokenHash = hashToken(raw);
      const now = Date.now();

      db.run(
        'INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)',
        [tokenHash, row.id, now],
        (e2) => {
          if (e2) return res.json({ error: 'DB_ERROR' });
          setCookie(res, USER_COOKIE, raw, { maxAge: 60 * 60 * 24 * 14 }); // 14 days
          res.json({ success: true, name: row.name || '', role: row.role });
        }
      );
    }
  );
});

app.post('/api/logout', (req, res) => {
  const raw = readCookie(req, USER_COOKIE);
  if (!raw) {
    setCookie(res, USER_COOKIE, '', { maxAge: 0 });
    return res.json({ success: true });
  }
  const tokenHash = hashToken(raw);
  db.run('DELETE FROM sessions WHERE token_hash=?', [tokenHash], () => {
    setCookie(res, USER_COOKIE, '', { maxAge: 0 });
    res.json({ success: true });
  });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.id,
      phone: req.user.phone,
      role: req.user.role,
      name: req.user.name || '',
      approved: (parseInt(req.user.approved,10)||0),
      is_online: (parseInt(req.user.is_online,10)||0)
    }
  });
});

// Keep old approve endpoint if you already use it (admin panel may have its own)
app.post('/api/approve', (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) return res.json({ error: 'MISSING_PHONE' });
  db.run("UPDATE users SET approved=1 WHERE phone=? AND role='driver'", [phone], function(err) {
    if (err) return res.json({ error: 'DB_ERROR' });
    res.json({ success: true, changes: this.changes });
  });
});

// Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app/passenger', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'passenger.html')));
app.get('/app/driver', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app', 'driver.html')));

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server started on', PORT));
