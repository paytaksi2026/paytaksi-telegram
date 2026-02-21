const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    password TEXT,
    role TEXT,
    name TEXT,
    approved INTEGER DEFAULT 0,
    UNIQUE(phone, role)
  )`);
});

app.post('/api/register', (req, res) => {
  const { phone, password, role, name } = req.body;

  db.run(
    "INSERT INTO users (phone, password, role, name) VALUES (?, ?, ?, ?)",
    [phone, password, role, name],
    function(err) {
      if (err) return res.json({ error: "PHONE_ROLE_EXISTS" });
      res.json({ success: true });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { phone, password, role } = req.body;

  db.get(
    "SELECT * FROM users WHERE phone=? AND password=? AND role=?",
    [phone, password, role],
    (err, row) => {
      if (!row) return res.json({ error: "INVALID_CREDENTIALS" });

      if (role === "driver" && row.approved === 0) {
        return res.json({ pending: true, name: row.name });
      }

      res.json({ success: true, name: row.name });
    }
  );
});

app.post('/api/approve', (req, res) => {
  const { phone } = req.body;
  db.run("UPDATE users SET approved=1 WHERE phone=? AND role='driver'", [phone]);
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.send("OK");
});

app.listen(3000, () => console.log("Server started on 3000"));
