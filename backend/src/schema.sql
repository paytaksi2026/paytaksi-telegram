-- PayTaksi MVP DB (SQLite)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('passenger','driver','admin')),
  full_name TEXT,
  phone TEXT,
  car_model TEXT,
  car_plate TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(telegram_id, role)
);

CREATE TABLE IF NOT EXISTS driver_status (
  driver_user_id INTEGER PRIMARY KEY,
  is_online INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lon REAL,
  updated_at INTEGER,
  FOREIGN KEY(driver_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passenger_user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('searching','accepted','arrived','started','finished','canceled')),
  pickup_lat REAL NOT NULL,
  pickup_lon REAL NOT NULL,
  pickup_text TEXT,
  dropoff_lat REAL NOT NULL,
  dropoff_lon REAL NOT NULL,
  dropoff_text TEXT,
  distance_km REAL,
  price_azn REAL,
  driver_user_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER,
  FOREIGN KEY(passenger_user_id) REFERENCES users(id),
  FOREIGN KEY(driver_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  from_role TEXT NOT NULL CHECK (from_role IN ('passenger','driver')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_driver_status_online ON driver_status(is_online);
