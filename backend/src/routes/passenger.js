import express from 'express';
import { q } from '../lib/db.js';
import { authRequired, roleRequired } from '../lib/auth.js';
import { route as osrmRoute, calcPrice } from '../lib/geo.js';

export const passengerRouter = express.Router();

passengerRouter.use(authRequired, roleRequired('passenger'));

// Create a ride request (auto-assign nearest online approved driver)
passengerRouter.post('/rides', async (req, res) => {
  const {
    pickup_lat, pickup_lng, pickup_text,
    drop_lat, drop_lng, drop_text
  } = req.body || {};

  if ([pickup_lat, pickup_lng, drop_lat, drop_lng].some(v => typeof v !== 'number')) {
    return res.status(400).json({ error: 'invalid_coords' });
  }

  // route distance
  const rt = await osrmRoute(pickup_lat, pickup_lng, drop_lat, drop_lng);
  const distance_km = rt.distance_m / 1000;
  const price_azn = calcPrice(distance_km);

  // find nearest driver within 10km
  const near = await q(
    `SELECT d.id as driver_id, u.full_name, u.phone,
            dl.lat, dl.lon,
            (6371 * acos(
               cos(radians($1)) * cos(radians(dl.lat)) * cos(radians(dl.lon) - radians($2)) +
               sin(radians($1)) * sin(radians(dl.lat))
            )) AS km
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     JOIN driver_locations dl ON dl.driver_id = d.id
     WHERE d.is_online = true AND d.is_approved = true
     ORDER BY km ASC
     LIMIT 1`,
    [pickup_lat, pickup_lng]
  );

  const assigned_driver_id = near.rowCount ? near.rows[0].driver_id : null;

  const ride = await q(
    `INSERT INTO rides(passenger_user_id, driver_id, status,
                       pickup_lat, pickup_lng, pickup_text,
                       drop_lat, drop_lng, drop_text,
                       distance_km, price_azn)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, status, driver_id, distance_km, price_azn`,
    [
      req.user.id,
      assigned_driver_id,
      assigned_driver_id ? 'assigned' : 'requested',
      pickup_lat, pickup_lng, pickup_text || null,
      drop_lat, drop_lng, drop_text || null,
      distance_km,
      price_azn
    ]
  );

  await q(
    'INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type, payload) VALUES($1,$2,$3,$4,$5)',
    [ride.rows[0].id, 'passenger', req.user.id, 'created', JSON.stringify({ assigned_driver_id })]
  );

  res.json({ ride: ride.rows[0], assigned: Boolean(assigned_driver_id) });
});

passengerRouter.get('/rides/:id', async (req, res) => {
  const id = req.params.id;
  const r = await q(
    `SELECT r.*, 
            du.full_name AS driver_name, du.phone AS driver_phone,
            d.car_model, d.car_number
     FROM rides r
     LEFT JOIN drivers d ON d.id = r.driver_id
     LEFT JOIN users du ON du.id = d.user_id
     WHERE r.id=$1 AND r.passenger_user_id=$2`,
    [id, req.user.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ ride: r.rows[0] });
});

passengerRouter.post('/rides/:id/cancel', async (req, res) => {
  const id = req.params.id;
  const upd = await q(
    `UPDATE rides SET status='cancelled', updated_at=now()
     WHERE id=$1 AND passenger_user_id=$2 AND status IN ('requested','assigned','accepted')
     RETURNING id, status`,
    [id, req.user.id]
  );
  if (!upd.rowCount) return res.status(400).json({ error: 'cannot_cancel' });
  await q('INSERT INTO ride_events(ride_id, actor_role, actor_user_id, event_type) VALUES($1,$2,$3,$4)',
    [id, 'passenger', req.user.id, 'cancelled']
  );
  res.json({ ride: upd.rows[0] });
});

