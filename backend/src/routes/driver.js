import express from 'express';
import { q } from '../lib/db.js';
import { authRequired, roleRequired } from '../lib/auth.js';

export const driverRouter = express.Router();

driverRouter.use(authRequired, roleRequired('driver'));

async function getDriverId(userId) {
  const r = await q('SELECT id, is_approved, is_online, car_model, car_number FROM drivers WHERE user_id=$1', [userId]);
  return r.rowCount ? r.rows[0] : null;
}

// driver profile

driverRouter.get('/me', async (req, res) => {
  const d = await getDriverId(req.user.id);
  if (!d) return res.status(404).json({ error: 'no_driver_profile' });
  res.json({ driver: d });
});

// toggle online/offline

driverRouter.post('/online', async (req, res) => {
  const { online } = req.body || {};
  const d = await getDriverId(req.user.id);
  if (!d) return res.status(404).json({ error: 'no_driver_profile' });
  if (!d.is_approved) return res.status(403).json({ error: 'not_approved' });
  const upd = await q('UPDATE drivers SET is_online=$1, updated_at=now() WHERE user_id=$2 RETURNING is_online', [!!online, req.user.id]);
  res.json({ is_online: upd.rows[0].is_online });
});

// update live location

driverRouter.post('/location', async (req, res) => {
  const { lat, lon } = req.body || {};
  if (typeof lat !== 'number' || typeof lon !== 'number') return res.status(400).json({ error: 'invalid_coords' });
  const d = await getDriverId(req.user.id);
  if (!d) return res.status(404).json({ error: 'no_driver_profile' });

  // upsert
  await q(
    `INSERT INTO driver_locations(driver_id, lat, lon, updated_at)
     VALUES($1,$2,$3,now())
     ON CONFLICT (driver_id)
     DO UPDATE SET lat=EXCLUDED.lat, lon=EXCLUDED.lon, updated_at=now()`,
    [d.id, lat, lon]
  );

  res.json({ ok: true });
});

// get next assigned ride

driverRouter.get('/rides/assigned', async (req, res) => {
  const d = await getDriverId(req.user.id);
  if (!d) return res.status(404).json({ error: 'no_driver_profile' });

  const r = await q(
    `SELECT r.*, pu.full_name AS passenger_name, pu.phone AS passenger_phone
     FROM rides r
     JOIN users pu ON pu.id = r.passenger_user_id
     WHERE r.driver_id=$1 AND r.status IN ('assigned','accepted','arrived','started')
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [d.id]
  );

  res.json({ ride: r.rowCount ? r.rows[0] : null });
});

// accept assigned ride

driverRouter.post('/rides/:id/accept', async (req, res) => {
  const d = await getDriverId(req.user.id);
  const id = req.params.id;
  const upd = await q(
    `UPDATE rides SET status='accepted', accepted_at=now(), updated_at=now()
     WHERE id=$1 AND driver_id=$2 AND status='assigned'
     RETURNING id, status`,
    [id, d.id]
  );
  if (!upd.rowCount) return res.status(400).json({ error: 'cannot_accept' });
  await q('INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type) VALUES($1,$2,$3,$4)',
    [id, 'driver', req.user.id, 'accepted']
  );
  res.json({ ride: upd.rows[0] });
});

// arrived

driverRouter.post('/rides/:id/arrived', async (req, res) => {
  const d = await getDriverId(req.user.id);
  const id = req.params.id;
  const upd = await q(
    `UPDATE rides SET status='arrived', arrived_at=now(), updated_at=now()
     WHERE id=$1 AND driver_id=$2 AND status IN ('accepted')
     RETURNING id, status`,
    [id, d.id]
  );
  if (!upd.rowCount) return res.status(400).json({ error: 'cannot_mark_arrived' });
  await q('INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type) VALUES($1,$2,$3,$4)',
    [id, 'driver', req.user.id, 'arrived']
  );
  res.json({ ride: upd.rows[0] });
});

// start ride

driverRouter.post('/rides/:id/start', async (req, res) => {
  const d = await getDriverId(req.user.id);
  const id = req.params.id;
  const upd = await q(
    `UPDATE rides SET status='started', started_at=now(), updated_at=now()
     WHERE id=$1 AND driver_id=$2 AND status IN ('arrived','accepted')
     RETURNING id, status`,
    [id, d.id]
  );
  if (!upd.rowCount) return res.status(400).json({ error: 'cannot_start' });
  await q('INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type) VALUES($1,$2,$3,$4)',
    [id, 'driver', req.user.id, 'started']
  );
  res.json({ ride: upd.rows[0] });
});

// finish ride

driverRouter.post('/rides/:id/finish', async (req, res) => {
  const d = await getDriverId(req.user.id);
  const id = req.params.id;
  const upd = await q(
    `UPDATE rides SET status='finished', finished_at=now(), updated_at=now()
     WHERE id=$1 AND driver_id=$2 AND status='started'
     RETURNING id, status, price_azn`,
    [id, d.id]
  );
  if (!upd.rowCount) return res.status(400).json({ error: 'cannot_finish' });
  await q('INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type) VALUES($1,$2,$3,$4)',
    [id, 'driver', req.user.id, 'finished']
  );
  res.json({ ride: upd.rows[0] });
});

