PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('passenger','driver')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drivers (
  user_id INTEGER PRIMARY KEY,
  car_model TEXT,
  car_plate TEXT,
  approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(approval_status IN ('PENDING','APPROVED','REJECTED','BLOCKED')),
  is_online INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS driver_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_user_id INTEGER NOT NULL,
  license_front_url TEXT,
  license_back_url TEXT,
  car_doc_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(driver_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passenger_user_id INTEGER NOT NULL,
  driver_user_id INTEGER,
  pickup_lat REAL NOT NULL,
  pickup_lon REAL NOT NULL,
  pickup_text TEXT NOT NULL,
  dropoff_lat REAL NOT NULL,
  dropoff_lon REAL NOT NULL,
  dropoff_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(passenger_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(driver_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('APPROVE','REJECT','BLOCK')),
  driver_user_id INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(admin_id) REFERENCES admin_users(id),
  FOREIGN KEY(driver_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_passenger_status ON orders(passenger_user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_driver_status ON orders(driver_user_id, status);
