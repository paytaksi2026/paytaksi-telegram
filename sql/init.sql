-- PayTaksi ZERO DB schema (PostgreSQL)
-- Run this in DBeaver SQL Editor.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS app_meta (
  k text PRIMARY KEY,
  v text
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('passenger','driver','admin')),
  phone TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  car_model TEXT,
  car_number TEXT,
  is_online BOOLEAN NOT NULL DEFAULT false,
  is_approved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_locations (
  driver_id UUID PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  passenger_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_id UUID NULL REFERENCES drivers(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'requested','assigned','accepted','arrived','started','finished','cancelled'
  )),

  pickup_lat DOUBLE PRECISION NOT NULL,
  pickup_lng DOUBLE PRECISION NOT NULL,
  pickup_text TEXT,

  drop_lat DOUBLE PRECISION NOT NULL,
  drop_lng DOUBLE PRECISION NOT NULL,
  drop_text TEXT,

  distance_km DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_azn NUMERIC(10,2) NOT NULL DEFAULT 0,

  accepted_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_driver_status ON rides(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_rides_passenger_created ON rides(passenger_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ride_events (
  id BIGSERIAL PRIMARY KEY,
  ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  actor_role TEXT,
  actor_user_id BIGINT,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settings (pricing)
INSERT INTO app_meta(k, v) VALUES
('price_base_azn', '3.50'),
('price_per_km_azn', '0.40')
ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v;

-- Default admin (phone: 0000, password: admin1234)
INSERT INTO users(role, phone, pass_hash, full_name)
VALUES('admin','0000','$2b$10$cfpm/kCXl3BHn6WjX43tCeNTpOoFA.9CuMlBXHNiXuZdNurUo6/2.','Admin')
ON CONFLICT (phone) DO NOTHING;

