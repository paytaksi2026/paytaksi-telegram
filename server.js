const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- DB init
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL,              -- passenger | driver
    name TEXT,
    approved INTEGER DEFAULT 0,      -- driver: 0 pending, 1 approved
    UNIQUE(phone, role)
  )`);
});

// ---- Helpers
function normRole(role) {
  role = String(role || '').toLowerCase().trim();
  return (role === 'driver') ? 'driver' : 'passenger';
}
function normPhone(phone) {
  return String(phone || '').trim();
}

// ---- Auth
app.post('/api/register', (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = String(req.body.password || '');
  const role = normRole(req.body.role);
  const name = String(req.body.name || '');

  if (!phone || !password) return res.json({ error: "MISSING_FIELDS" });
  if (password.length < 4) return res.json({ error: "WEAK_PASSWORD" });

  const approved = (role === 'driver') ? 0 : 1; // passengers are "active" by default

  db.run(
    "INSERT INTO users (phone, password, role, name, approved) VALUES (?, ?, ?, ?, ?)",
    [phone, password, role, name, approved],
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

      // Driver pending flow
      if (role === "driver" && approved === 0) {
        return res.json({ pending: true, name: row.name || "", role });
      }

      return res.json({ success: true, name: row.name || "", role });
    }
  );
});

// ---- Admin actions (minimal)
// Approve driver by phone (role fixed to driver)
app.post('/api/approve', (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) return res.json({ error: "MISSING_PHONE" });

  db.run(
    "UPDATE users SET approved=1 WHERE phone=? AND role='driver'",
    [phone],
    function (err) {
      if (err) return res.json({ error: "DB_ERROR" });
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Reset DB (DANGEROUS) - protected by env key
// Usage: GET /admin/reset-db?key=YOUR_KEY
app.get('/admin/reset-db', (req, res) => {
  const key = String(req.query.key || '');
  const expected = process.env.ADMIN_RESET_KEY || '';
  if (!expected || key !== expected) {
    return res.status(403).send("FORBIDDEN");
  }

  db.serialize(() => {
    db.run("DROP TABLE IF EXISTS users", (err) => {
      if (err) return res.status(500).send("DB_ERROR");
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT,
        approved INTEGER DEFAULT 0,
        UNIQUE(phone, role)
      )`, (err2) => {
        if (err2) return res.status(500).send("DB_ERROR");
        res.send("OK_RESET");
      });
    });
  });
});

app.get('/health', (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on", PORT));
