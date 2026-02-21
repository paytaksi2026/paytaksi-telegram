
import { q } from "./db.js";

export async function initDriverRegistration(){

  await q(`CREATE TABLE IF NOT EXISTS driver_profiles(
    driver_id TEXT PRIMARY KEY,
    full_name TEXT,
    phone TEXT,
    car_model TEXT,
    car_plate TEXT,
    car_color TEXT,
    license_number TEXT,
    license_photo TEXT,
    car_photo TEXT,
    status TEXT DEFAULT 'PENDING',
    approved BOOLEAN DEFAULT FALSE,
    rejected_reason TEXT,

    created_at BIGINT NOT NULL
  )`);

}
