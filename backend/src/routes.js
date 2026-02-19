import { z } from 'zod';
import fetch from 'node-fetch';
import { getDb } from './db.js';
import { haversineKm } from './geo.js';
import { calcPrice } from './pricing.js';
import { tgSendMessage } from './telegram.js';

const orderCreateSchema = z.object({
  passenger_telegram_id: z.string().min(1),
  pickup: z.object({ lat: z.number(), lon: z.number(), text: z.string().optional() }),
  dropoff: z.object({ lat: z.number(), lon: z.number(), text: z.string().optional() })
});

const registerSchema = z.object({
  telegram_id: z.string().min(1),
  role: z.enum(['passenger','driver','admin']),
  full_name: z.string().optional(),
  phone: z.string().optional(),
  car_model: z.string().optional(),
  car_plate: z.string().optional()
});

const locationSchema = z.object({
  telegram_id: z.string().min(1),
  role: z.enum(['driver','passenger']),
  lat: z.number(),
  lon: z.number(),
  is_online: z.boolean().optional()
});

const acceptSchema = z.object({
  order_id: z.number().int().positive(),
  driver_telegram_id: z.string().min(1)
});

const statusSchema = z.object({
  order_id: z.number().int().positive(),
  driver_telegram_id: z.string().optional(),
  passenger_telegram_id: z.string().optional(),
  status: z.enum(['arrived','started','finished','canceled'])
});

const chatSchema = z.object({
  order_id: z.number().int().positive(),
  from_role: z.enum(['passenger','driver']),
  text: z.string().min(1)
});

async function osrmDistanceKm(pickup, dropoff) {
  // Self-hosted OSRM is recommended. For MVP we can fall back to haversine.
  const osrmUrl = process.env.OSRM_URL; // e.g. http://localhost:5000
  if (!osrmUrl) {
    return haversineKm(pickup.lat, pickup.lon, dropoff.lat, dropoff.lon);
  }

  const url = `${osrmUrl}/route/v1/driving/${pickup.lon},${pickup.lat};${dropoff.lon},${dropoff.lat}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) {
    return haversineKm(pickup.lat, pickup.lon, dropoff.lat, dropoff.lon);
  }
  const data = await res.json();
  const meters = data?.routes?.[0]?.distance;
  if (!meters) return haversineKm(pickup.lat, pickup.lon, dropoff.lat, dropoff.lon);
  return meters / 1000;
}

export function mountRoutes(app, notify) {
  const PASSENGER_BOT_TOKEN = process.env.PASSENGER_BOT_TOKEN;
  const DRIVER_BOT_TOKEN = process.env.DRIVER_BOT_TOKEN;

  async function notifyPassenger(telegramId, text, extra) {
    return tgSendMessage(PASSENGER_BOT_TOKEN, telegramId, text, extra);
  }

  async function notifyDriver(telegramId, text, extra) {
    return tgSendMessage(DRIVER_BOT_TOKEN, telegramId, text, extra);
  }

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.post('/api/register', (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const db = getDb();
    const u = parsed.data;

    const stmt = db.prepare(`
      INSERT INTO users (telegram_id, role, full_name, phone, car_model, car_plate)
      VALUES (@telegram_id, @role, @full_name, @phone, @car_model, @car_plate)
      ON CONFLICT(telegram_id, role) DO UPDATE SET
        full_name=COALESCE(excluded.full_name, users.full_name),
        phone=COALESCE(excluded.phone, users.phone),
        car_model=COALESCE(excluded.car_model, users.car_model),
        car_plate=COALESCE(excluded.car_plate, users.car_plate)
    `);

    stmt.run(u);

    const user = db.prepare('SELECT * FROM users WHERE telegram_id=? AND role=?').get(u.telegram_id, u.role);

    if (u.role === 'driver') {
      db.prepare(`INSERT INTO driver_status (driver_user_id, is_online) VALUES (?, 0)
                  ON CONFLICT(driver_user_id) DO NOTHING`).run(user.id);
    }

    res.json({ ok: true, user });
  });

  app.post('/api/location/update', (req, res) => {
    const parsed = locationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { telegram_id, role, lat, lon, is_online } = parsed.data;
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE telegram_id=? AND role=?').get(telegram_id, role);
    if (!user) return res.status(404).json({ error: 'user_not_found' });

    if (role === 'driver') {
      db.prepare(`
        INSERT INTO driver_status (driver_user_id, is_online, lat, lon, updated_at)
        VALUES (?, ?, ?, ?, strftime('%s','now'))
        ON CONFLICT(driver_user_id) DO UPDATE SET
          is_online=COALESCE(?, driver_status.is_online),
          lat=excluded.lat,
          lon=excluded.lon,
          updated_at=excluded.updated_at
      `).run(user.id, is_online ? 1 : 0, lat, lon, is_online ? 1 : null);

      if (typeof is_online === 'boolean') {
        db.prepare('UPDATE driver_status SET is_online=? WHERE driver_user_id=?').run(is_online ? 1 : 0, user.id);
      }
    }

    res.json({ ok: true });
  });

  app.get('/api/drivers/online', (req, res) => {
    const db = getDb();
    const drivers = db.prepare(`
      SELECT u.id, u.full_name, u.car_model, u.car_plate, ds.lat, ds.lon, ds.updated_at
      FROM driver_status ds
      JOIN users u ON u.id = ds.driver_user_id
      WHERE ds.is_online=1 AND ds.lat IS NOT NULL AND ds.lon IS NOT NULL
    `).all();
    res.json({ ok: true, drivers });
  });

  app.post('/api/order/create', async (req, res) => {
    const parsed = orderCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { passenger_telegram_id, pickup, dropoff } = parsed.data;
    const db = getDb();

    // ensure passenger exists
    db.prepare(`INSERT INTO users (telegram_id, role) VALUES (?, 'passenger')
                ON CONFLICT(telegram_id, role) DO NOTHING`).run(passenger_telegram_id);

    const passenger = db.prepare("SELECT * FROM users WHERE telegram_id=? AND role='passenger'").get(passenger_telegram_id);

    const distanceKm = await osrmDistanceKm(pickup, dropoff);
    const priceAzn = calcPrice(distanceKm);

    const info = db.prepare(`
      INSERT INTO orders (
        passenger_user_id, status,
        pickup_lat, pickup_lon, pickup_text,
        dropoff_lat, dropoff_lon, dropoff_text,
        distance_km, price_azn, updated_at
      ) VALUES (?, 'searching', ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    `).run(
      passenger.id,
      pickup.lat, pickup.lon, pickup.text || null,
      dropoff.lat, dropoff.lon, dropoff.text || null,
      distanceKm, priceAzn
    );

    const orderId = info.lastInsertRowid;

    // notify drivers (bots will also poll, but this helps push later)
    notify?.broadcastNewOrder?.({
      order_id: orderId,
      pickup,
      dropoff,
      distance_km: distanceKm,
      price_azn: priceAzn
    });

    res.json({ ok: true, order_id: orderId, distance_km: distanceKm, price_azn: priceAzn });
  });

  app.get('/api/orders/nearby', (req, res) => {
    const driver_telegram_id = String(req.query.driver_telegram_id || '');
    const radiusKm = Number(req.query.radius_km || 5);
    if (!driver_telegram_id) return res.status(400).json({ error: 'driver_telegram_id_required' });

    const db = getDb();
    const driver = db.prepare("SELECT * FROM users WHERE telegram_id=? AND role='driver'").get(driver_telegram_id);
    if (!driver) return res.status(404).json({ error: 'driver_not_found' });

    const ds = db.prepare('SELECT * FROM driver_status WHERE driver_user_id=?').get(driver.id);
    if (!ds?.lat || !ds?.lon) return res.json({ ok: true, orders: [] });

    const orders = db.prepare(`
      SELECT o.*, up.telegram_id AS passenger_telegram_id
      FROM orders o
      JOIN users up ON up.id = o.passenger_user_id
      WHERE o.status='searching'
      ORDER BY o.created_at DESC
      LIMIT 20
    `).all();

    const filtered = orders
      .map((o) => {
        const d = haversineKm(ds.lat, ds.lon, o.pickup_lat, o.pickup_lon);
        return { ...o, pickup_distance_km: d };
      })
      .filter((o) => o.pickup_distance_km <= radiusKm)
      .sort((a, b) => a.pickup_distance_km - b.pickup_distance_km)
      .slice(0, 10);

    res.json({ ok: true, orders: filtered });
  });

  app.post('/api/order/accept', (req, res) => {
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { order_id, driver_telegram_id } = parsed.data;
    const db = getDb();

    const driver = db.prepare("SELECT * FROM users WHERE telegram_id=? AND role='driver'").get(driver_telegram_id);
    if (!driver) return res.status(404).json({ error: 'driver_not_found' });

    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (order.status !== 'searching') return res.status(409).json({ error: 'order_not_available' });

    db.prepare(`
      UPDATE orders
      SET status='accepted', driver_user_id=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(driver.id, order_id);

    const full = db.prepare(`
      SELECT o.*, up.telegram_id AS passenger_telegram_id, ud.telegram_id AS driver_telegram_id,
             ud.full_name AS driver_name, ud.car_model, ud.car_plate
      FROM orders o
      JOIN users up ON up.id=o.passenger_user_id
      JOIN users ud ON ud.id=o.driver_user_id
      WHERE o.id=?
    `).get(order_id);

    // Notify passenger in passenger bot
    const pickup = full.pickup_text || `${full.pickup_lat},${full.pickup_lon}`;
    const dropoff = full.dropoff_text || `${full.dropoff_lat},${full.dropoff_lon}`;
    await notifyPassenger(
      full.passenger_telegram_id,
      `✅ Sifarişiniz qəbul edildi #${full.id}\n\n🚖 Sürücü: ${full.driver_name || 'Sürücü'}\n🚘 Avto: ${full.car_model || '-'}\n🔢 Nömrə: ${full.car_plate || '-'}\n\n📍 Qarşılama: ${pickup}\n🏁 Gediləcək: ${dropoff}\n\n💬 Chat üçün: #${full.id} mesajınız\n📞 Zəng üçün: sürücüyə Telegramdan yazıb zəng edə bilərsiniz.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🧭 Waze - Qarşılama', url: `waze://?ll=${full.pickup_lat},${full.pickup_lon}&navigate=yes` }],
            [{ text: '🧭 Waze - Gediləcək', url: `waze://?ll=${full.dropoff_lat},${full.dropoff_lon}&navigate=yes` }]
          ]
        }
      }
    );

    notify?.orderAccepted?.(full);

    res.json({ ok: true, order: full });
  });

  app.post('/api/order/status', (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { order_id, status } = parsed.data;
    const db = getDb();

    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    db.prepare('UPDATE orders SET status=?, updated_at=strftime(\'%s\',\'now\') WHERE id=?').run(status, order_id);

    const full = db.prepare(`
      SELECT o.*, up.telegram_id AS passenger_telegram_id, ud.telegram_id AS driver_telegram_id,
             ud.full_name AS driver_name, ud.car_model, ud.car_plate
      FROM orders o
      JOIN users up ON up.id=o.passenger_user_id
      LEFT JOIN users ud ON ud.id=o.driver_user_id
      WHERE o.id=?
    `).get(order_id);

    const statusText = {
      arrived: '🚩 Sürücü çatdı',
      started: '🟢 Gediş başladı',
      finished: '🏁 Gediş bitdi',
      canceled: '❌ Sifariş ləğv edildi'
    }[status] || `Status: ${status}`;

    await notifyPassenger(full.passenger_telegram_id, `#${full.id} ${statusText}`);
    if (full.driver_telegram_id) await notifyDriver(full.driver_telegram_id, `#${full.id} ${statusText}`);

    notify?.orderStatus?.(full);

    res.json({ ok: true, order: full });
  });

  app.post('/api/chat/send', (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { order_id, from_role, text } = parsed.data;
    const db = getDb();

    const order = db.prepare(`
      SELECT o.*, up.telegram_id AS passenger_telegram_id, ud.telegram_id AS driver_telegram_id
      FROM orders o
      JOIN users up ON up.id=o.passenger_user_id
      LEFT JOIN users ud ON ud.id=o.driver_user_id
      WHERE o.id=?
    `).get(order_id);

    if (!order) return res.status(404).json({ error: 'order_not_found' });

    db.prepare('INSERT INTO messages (order_id, from_role, text) VALUES (?, ?, ?)').run(order_id, from_role, text);

    // Telegram relay
    const prefix = `💬 #${order_id} `;
    if (from_role === 'passenger' && order.driver_telegram_id) {
      await notifyDriver(order.driver_telegram_id, `${prefix}${text}`);
    }
    if (from_role === 'driver') {
      await notifyPassenger(order.passenger_telegram_id, `${prefix}${text}`);
    }

    notify?.chat?.({ order_id, from_role, text, passenger_telegram_id: order.passenger_telegram_id, driver_telegram_id: order.driver_telegram_id });

    res.json({ ok: true });
  });

  app.get('/api/order/get', (req, res) => {
    const order_id = Number(req.query.order_id || 0);
    if (!order_id) return res.status(400).json({ error: 'order_id_required' });

    const db = getDb();
    const full = db.prepare(`
      SELECT o.*, up.telegram_id AS passenger_telegram_id,
             ud.telegram_id AS driver_telegram_id,
             ud.full_name AS driver_name, ud.car_model, ud.car_plate
      FROM orders o
      JOIN users up ON up.id=o.passenger_user_id
      LEFT JOIN users ud ON ud.id=o.driver_user_id
      WHERE o.id=?
    `).get(order_id);
    if (!full) return res.status(404).json({ error: 'order_not_found' });
    res.json({ ok: true, order: full });
  });
}
