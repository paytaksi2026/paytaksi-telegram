import 'dotenv/config';
import path from 'node:path';
import http from 'node:http';

import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { Server as SocketIOServer } from 'socket.io';

import { makePool, runMigrations } from './db.js';
import { verifyInitData } from './telegramAuth.js';
import { routeDistanceKm } from './routing.js';
import { calcCommissionAzn, calcPriceAzn, round2 } from './pricing.js';

import { startPassengerBot } from './bots/passengerBot.js';
import { startDriverBot } from './bots/driverBot.js';
import { startAdminBot } from './bots/adminBot.js';

const PORT = Number(process.env.PORT || 3000);

function allowedAdminTgIds() {
  return (process.env.ADMIN_TG_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedAdmin(tgId) {
  const allow = allowedAdminTgIds();
  if (!allow.length) return true;
  return allow.includes(String(tgId));
}

function pickBotTokens() {
  return [
    process.env.PASSENGER_BOT_TOKEN,
    process.env.DRIVER_BOT_TOKEN,
    process.env.ADMIN_BOT_TOKEN
  ].filter(Boolean);
}

function getInitData(req) {
  return String(req.header('x-telegram-init-data') || '').trim();
}

function authFromInitData(req) {
  const initData = getInitData(req);
  if (!initData) return { ok: false, error: 'missing_init_data' };
  const tokens = pickBotTokens();
  for (const t of tokens) {
    const v = verifyInitData(initData, t);
    if (v.ok) return { ok: true, tgUser: v.user, tokenUsed: t };
  }
  return { ok: false, error: 'bad_init_data' };
}

async function upsertUser(pool, tgUser, role) {
  await pool.query(
    `INSERT INTO users (tg_id, role, first_name, last_name, username)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tg_id) DO UPDATE SET role=EXCLUDED.role, updated_at=NOW()`,
    [tgUser.id, role, tgUser.first_name || null, tgUser.last_name || null, tgUser.username || null]
  );
  const u = await pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgUser.id]);
  return u.rows[0];
}

function jsonOk(res, payload) {
  res.json({ ok: true, ...payload });
}

function jsonErr(res, code, error) {
  res.status(code).json({ ok: false, error });
}

async function main() {
  const pool = makePool();

  // Auto-run migrations unless disabled
  if (String(process.env.RUN_MIGRATIONS || '1') !== '0') {
    await runMigrations(pool);
  }

  // Start bots (long-polling) in same process
  await startPassengerBot({ pool });
  await startDriverBot({ pool });
  await startAdminBot({ pool });

  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan('combined'));
  app.use(express.json({ limit: '2mb' }));

  // Health
  app.get('/health', (req, res) => res.status(200).send('ok'));

  // Static WebApp
  app.use('/public', express.static(path.join(process.cwd(), 'src', 'public')));

  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: { origin: true, credentials: true }
  });

  io.on('connection', (socket) => {
    socket.on('join', ({ room }) => {
      if (room && typeof room === 'string') socket.join(room);
    });
    socket.on('joinDrivers', () => {
      socket.join('drivers');
    });
  });

  // --- Passenger API
  app.get('/api/passenger/me', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    const user = await upsertUser(pool, a.tgUser, 'passenger');
    await pool.query(`INSERT INTO passengers(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user.id]);
    return jsonOk(res, { user });
  });

  app.post('/api/passenger/rides', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    const user = await upsertUser(pool, a.tgUser, 'passenger');
    await pool.query(`INSERT INTO passengers(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user.id]);

    const { pickup, drop, pickupText, dropText } = req.body || {};
    if (!pickup || !drop) return jsonErr(res, 400, 'missing_pickup_or_drop');

    let distanceKm;
    try {
      distanceKm = await routeDistanceKm(pickup, drop);
    } catch (e) {
      return jsonErr(res, 502, 'routing_failed');
    }

    const priceAzn = calcPriceAzn(distanceKm);
    const commissionAzn = calcCommissionAzn(priceAzn);

    const ins = await pool.query(
      `INSERT INTO rides (
        passenger_user_id, status,
        pickup_lat, pickup_lng, pickup_text,
        drop_lat, drop_lng, drop_text,
        distance_km, price_azn, commission_azn, updated_at
      ) VALUES (
        $1,'pending',
        $2,$3,$4,
        $5,$6,$7,
        $8,$9,$10,NOW()
      ) RETURNING *`,
      [
        user.id,
        pickup.lat, pickup.lng, pickupText || null,
        drop.lat, drop.lng, dropText || null,
        distanceKm,
        priceAzn,
        commissionAzn
      ]
    );
    const ride = ins.rows[0];

    await pool.query(
      `INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type, payload)
       VALUES ($1,'passenger',$2,'created',$3)`,
      [ride.id, user.id, { pickup, drop, distanceKm, priceAzn }]
    );

    // Notify drivers (any online drivers listen to 'drivers' room)
    io.to('drivers').emit('ride:new', {
      id: ride.id,
      pickup: { lat: ride.pickup_lat, lng: ride.pickup_lng, text: ride.pickup_text },
      drop: { lat: ride.drop_lat, lng: ride.drop_lng, text: ride.drop_text },
      distanceKm: round2(ride.distance_km),
      priceAzn: Number(ride.price_azn)
    });

    io.to(`ride:${ride.id}`).emit('ride:update', { id: ride.id, status: ride.status });

    return jsonOk(res, { ride });
  });

  // --- Driver API
  app.get('/api/driver/me', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    const user = await upsertUser(pool, a.tgUser, 'driver');
    const d = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
    return jsonOk(res, { user, driver: d.rows[0] || null });
  });

  app.get('/api/driver/rides/pending', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    const user = await upsertUser(pool, a.tgUser, 'driver');
    const blockAt = Number(process.env.DRIVER_BLOCK_BALANCE_AZN ?? -15);
    const d = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
    const driver = d.rows[0];
    if (!driver || driver.status !== 'approved') return jsonErr(res, 403, 'driver_not_approved');
    if (Number(driver.balance_azn) <= blockAt) return jsonErr(res, 403, 'driver_balance_blocked');

    const q = await pool.query(
      `SELECT * FROM rides
       WHERE status='pending'
       ORDER BY created_at DESC
       LIMIT 10`
    );
    return jsonOk(res, { rides: q.rows });
  });

  app.post('/api/driver/rides/:id/accept', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    const user = await upsertUser(pool, a.tgUser, 'driver');
    const rideId = Number(req.params.id);
    if (!Number.isFinite(rideId)) return jsonErr(res, 400, 'bad_ride_id');

    const blockAt = Number(process.env.DRIVER_BLOCK_BALANCE_AZN ?? -15);

    await pool.query('BEGIN');
    try {
      const d = await pool.query(`SELECT * FROM drivers WHERE user_id=$1 FOR UPDATE`, [user.id]);
      const driver = d.rows[0];
      if (!driver || driver.status !== 'approved') { await pool.query('ROLLBACK'); return jsonErr(res, 403, 'driver_not_approved'); }
      if (Number(driver.balance_azn) <= blockAt) { await pool.query('ROLLBACK'); return jsonErr(res, 403, 'driver_balance_blocked'); }

      const r = await pool.query(`SELECT * FROM rides WHERE id=$1 FOR UPDATE`, [rideId]);
      const ride = r.rows[0];
      if (!ride) { await pool.query('ROLLBACK'); return jsonErr(res, 404, 'ride_not_found'); }
      if (ride.status !== 'pending') { await pool.query('ROLLBACK'); return jsonErr(res, 409, 'ride_not_pending'); }

      const upd = await pool.query(
        `UPDATE rides SET status='accepted', driver_user_id=$1, updated_at=NOW()
         WHERE id=$2 RETURNING *`,
        [user.id, rideId]
      );

      await pool.query(
        `INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type)
         VALUES ($1,'driver',$2,'accepted')`,
        [rideId, user.id]
      );
      await pool.query('COMMIT');

      io.to(`ride:${rideId}`).emit('ride:update', { id: rideId, status: 'accepted' });
      return jsonOk(res, { ride: upd.rows[0] });
    } catch (e) {
      await pool.query('ROLLBACK');
      return jsonErr(res, 500, 'accept_failed');
    }
  });

  app.post('/api/driver/rides/:id/status', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    const user = await upsertUser(pool, a.tgUser, 'driver');
    const rideId = Number(req.params.id);
    const { status } = req.body || {};
    if (!['arrived', 'started', 'finished'].includes(status)) return jsonErr(res, 400, 'bad_status');

    await pool.query('BEGIN');
    try {
      const r = await pool.query(`SELECT * FROM rides WHERE id=$1 FOR UPDATE`, [rideId]);
      const ride = r.rows[0];
      if (!ride) { await pool.query('ROLLBACK'); return jsonErr(res, 404, 'ride_not_found'); }
      if (Number(ride.driver_user_id) !== Number(user.id)) { await pool.query('ROLLBACK'); return jsonErr(res, 403, 'not_your_ride'); }

      // Simple transitions
      const allowed = {
        accepted: ['arrived', 'started', 'finished'],
        arrived: ['started', 'finished'],
        started: ['finished']
      };
      const okNext = allowed[ride.status] || [];
      if (!okNext.includes(status)) {
        await pool.query('ROLLBACK');
        return jsonErr(res, 409, 'bad_transition');
      }

      const upd = await pool.query(
        `UPDATE rides SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
        [status, rideId]
      );

      await pool.query(
        `INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type)
         VALUES ($1,'driver',$2,$3)`,
        [rideId, user.id, status]
      );

      // On finish: deduct commission
      if (status === 'finished') {
        const commission = Number(ride.commission_azn);
        await pool.query(`UPDATE drivers SET balance_azn = balance_azn - $1 WHERE user_id=$2`, [commission, user.id]);
      }

      await pool.query('COMMIT');

      io.to(`ride:${rideId}`).emit('ride:update', { id: rideId, status });
      return jsonOk(res, { ride: upd.rows[0] });
    } catch (e) {
      await pool.query('ROLLBACK');
      return jsonErr(res, 500, 'status_failed');
    }
  });

  // --- Admin API
  app.get('/api/admin/me', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    if (!isAllowedAdmin(a.tgUser.id)) return jsonErr(res, 403, 'admin_not_allowed');
    const user = await upsertUser(pool, a.tgUser, 'admin');
    return jsonOk(res, { user });
  });

  app.get('/api/admin/topups', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    if (!isAllowedAdmin(a.tgUser.id)) return jsonErr(res, 403, 'admin_not_allowed');
    await upsertUser(pool, a.tgUser, 'admin');

    const q = await pool.query(
      `SELECT t.*, u.first_name, u.last_name, u.tg_id
       FROM topups t
       JOIN users u ON u.id=t.driver_user_id
       WHERE t.status='pending'
       ORDER BY t.created_at DESC
       LIMIT 50`
    );
    return jsonOk(res, { topups: q.rows });
  });

  app.post('/api/admin/topups/:id/decide', async (req, res) => {
    const a = authFromInitData(req);
    if (!a.ok || !a.tgUser) return jsonErr(res, 401, a.error);
    if (!isAllowedAdmin(a.tgUser.id)) return jsonErr(res, 403, 'admin_not_allowed');
    await upsertUser(pool, a.tgUser, 'admin');

    const id = Number(req.params.id);
    const action = String(req.body?.action || '').toLowerCase();
    if (!['approve', 'reject'].includes(action)) return jsonErr(res, 400, 'bad_action');

    await pool.query('BEGIN');
    try {
      const q = await pool.query(`SELECT * FROM topups WHERE id=$1 FOR UPDATE`, [id]);
      const t = q.rows[0];
      if (!t || t.status !== 'pending') { await pool.query('ROLLBACK'); return jsonErr(res, 409, 'already_decided'); }
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      await pool.query(`UPDATE topups SET status=$1, decided_at=NOW() WHERE id=$2`, [newStatus, id]);
      if (action === 'approve') {
        await pool.query(`UPDATE drivers SET balance_azn = balance_azn + $1 WHERE user_id=$2`, [t.amount_azn, t.driver_user_id]);
      }
      await pool.query('COMMIT');
      return jsonOk(res, { status: newStatus });
    } catch (e) {
      await pool.query('ROLLBACK');
      return jsonErr(res, 500, 'decide_failed');
    }
  });

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on :${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    try { await pool.end(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', e);
  process.exit(1);
});
