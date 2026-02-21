import pg from "pg";
const { Pool } = pg;

let pool = null;

export function getPool(){
  if(pool) return pool;
  const cs = process.env.DATABASE_URL;
  if(!cs) return null;
  pool = new Pool({
    connectionString: cs,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
    max: parseInt(process.env.PGPOOL_MAX || "10", 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  return pool;
}

export async function q(sql, params=[]){
  const p = getPool();
  if(!p) throw new Error("DATABASE_URL not set");
  return p.query(sql, params);
}

export async function initDb(){
  const p = getPool();
  if(!p) return false;

  await q(`CREATE TABLE IF NOT EXISTS drivers(
    driver_id TEXT PRIMARY KEY,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    heading DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    online BOOLEAN DEFAULT TRUE,
    ts BIGINT
  )`);

  await q(`CREATE TABLE IF NOT EXISTS orders(
    order_id TEXT PRIMARY KEY,
    passenger_id TEXT NOT NULL,
    driver_id TEXT,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    pickup JSONB NOT NULL,
    dropoff JSONB NOT NULL,
    distance_km DOUBLE PRECISION,
    duration_min INT,
    surge_multiplier DOUBLE PRECISION DEFAULT 1.0,
    price DOUBLE PRECISION NOT NULL,
    pay_method TEXT,
    rating INT,
    review TEXT
  )`);

  await q(`CREATE TABLE IF NOT EXISTS wallets(
    driver_id TEXT PRIMARY KEY,
    balance DOUBLE PRECISION NOT NULL DEFAULT 0,
    earned_total DOUBLE PRECISION NOT NULL DEFAULT 0,
    withdrawn_total DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`);

  await q(`CREATE TABLE IF NOT EXISTS withdrawals(
    id BIGSERIAL PRIMARY KEY,
    driver_id TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    card TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);

  await q(`CREATE TABLE IF NOT EXISTS logs(
    id BIGSERIAL PRIMARY KEY,
    ts BIGINT NOT NULL,
    level TEXT NOT NULL,
    msg TEXT NOT NULL,
    data JSONB
  )`);

  return true;
}
