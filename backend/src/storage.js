import { q, initDb } from "./db.js";

export async function useDb(){
  try{ return await initDb(); }catch(e){ console.error("DB init error:", e.message); return false; }
}

export async function upsertDriver(d){
  await q(`INSERT INTO drivers(driver_id,lat,lon,heading,speed,online,ts)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(driver_id) DO UPDATE SET
             lat=EXCLUDED.lat, lon=EXCLUDED.lon, heading=EXCLUDED.heading, speed=EXCLUDED.speed,
             online=EXCLUDED.online, ts=EXCLUDED.ts`,
          [d.driverId, d.lat, d.lon, d.heading, d.speed, d.online, d.ts]);
}

export async function createOrder(o){
  await q(`INSERT INTO orders(order_id,passenger_id,driver_id,status,created_at,pickup,dropoff,distance_km,duration_min,surge_multiplier,price,pay_method,rating,review)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [o.orderId,o.passengerId,o.driverId||null,o.status,o.createdAt,o.pickup,o.dropoff,o.distanceKm||null,o.durationMin||null,o.surgeMultiplier||1.0,o.price,o.payMethod||null,o.rating||null,o.review||null]);
}

export async function updateOrderStatus(orderId,status){ await q(`UPDATE orders SET status=$2 WHERE order_id=$1`,[orderId,status]); }
export async function assignDriver(orderId,driverId){ await q(`UPDATE orders SET driver_id=$2 WHERE order_id=$1`,[orderId,driverId]); }
export async function setPayMethod(orderId,method){ await q(`UPDATE orders SET pay_method=$2 WHERE order_id=$1`,[orderId,method]); }
export async function setRating(orderId,stars,review){ await q(`UPDATE orders SET rating=$2, review=$3 WHERE order_id=$1`,[orderId,stars,review]); }

export async function ensureWallet(driverId){
  const now = Date.now();
  await q(`INSERT INTO wallets(driver_id,balance,earned_total,withdrawn_total,updated_at)
           VALUES($1,0,0,0,$2) ON CONFLICT(driver_id) DO NOTHING`,[driverId,now]);
}
export async function walletAddEarning(driverId,amount){
  const now = Date.now();
  await ensureWallet(driverId);
  await q(`UPDATE wallets SET balance=balance+$2, earned_total=earned_total+$2, updated_at=$3 WHERE driver_id=$1`,
          [driverId,amount,now]);
}
export async function walletAddWithdrawal(driverId,amount){
  const now = Date.now();
  await ensureWallet(driverId);
  await q(`UPDATE wallets SET balance=balance-$2, withdrawn_total=withdrawn_total+$2, updated_at=$3 WHERE driver_id=$1`,
          [driverId,amount,now]);
}

export async function addLog(level,msg,data){
  await q(`INSERT INTO logs(ts,level,msg,data) VALUES($1,$2,$3,$4)`,[Date.now(),level,msg,data||null]);
}
export async function listLogs(limit=200){
  const r = await q(`SELECT ts,level,msg,data FROM logs ORDER BY id DESC LIMIT $1`,[limit]);
  return r.rows.reverse();
}
