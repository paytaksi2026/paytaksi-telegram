-- PayTaksi Telegram: initial schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS app_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('passenger','driver','admin')),
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS passengers (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_verified BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS drivers (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  operator TEXT,
  car_model TEXT,
  car_make TEXT,
  car_plate TEXT,
  car_photo_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  balance_azn NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS driver_docs (
  id BIGSERIAL PRIMARY KEY,
  driver_user_id BIGINT NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  telegram_file_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS topups (
  id BIGSERIAL PRIMARY KEY,
  driver_user_id BIGINT NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  amount_azn NUMERIC(12,2) NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('card_to_card','terminal','m10')),
  receipt_file_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rides (
  id BIGSERIAL PRIMARY KEY,
  passenger_user_id BIGINT NOT NULL REFERENCES users(id),
  driver_user_id BIGINT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','offered','accepted','arrived','started','finished','canceled')),
  pickup_lat DOUBLE PRECISION NOT NULL,
  pickup_lng DOUBLE PRECISION NOT NULL,
  pickup_text TEXT,
  drop_lat DOUBLE PRECISION NOT NULL,
  drop_lng DOUBLE PRECISION NOT NULL,
  drop_text TEXT,
  distance_km DOUBLE PRECISION NOT NULL,
  price_azn NUMERIC(12,2) NOT NULL,
  commission_azn NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ride_events (
  id BIGSERIAL PRIMARY KEY,
  ride_id BIGINT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  actor_role TEXT,
  actor_user_id BIGINT,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_user_id);
CREATE INDEX IF NOT EXISTS idx_rides_passenger ON rides(passenger_user_id);

INSERT INTO app_meta(k,v) VALUES ('schema_version','1')
ON CONFLICT (k) DO NOTHING;
