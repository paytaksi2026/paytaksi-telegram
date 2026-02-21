import express from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../lib/db.js';
import { authRequired, roleRequired } from '../lib/auth.js';

export const adminRouter = express.Router();
adminRouter.use(authRequired, roleRequired('admin'));

adminRouter.get('/drivers', async (req, res) => {
  const r = await q(
    `SELECT d.id, d.user_id, d.car_model, d.car_number, d.is_online, d.is_approved, d.created_at,
            u.full_name, u.phone
     FROM drivers d JOIN users u ON u.id=d.user_id
     ORDER BY d.created_at DESC`,
    []
  );
  res.json({ drivers: r.rows });
});

adminRouter.post('/drivers/:id/approve', async (req, res) => {
  const id = req.params.id;
  const { approved } = req.body || {};
  const upd = await q('UPDATE drivers SET is_approved=$1, updated_at=now() WHERE id=$2 RETURNING id, is_approved', [!!approved, id]);
  if (!upd.rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ driver: upd.rows[0] });
});

adminRouter.get('/rides', async (req, res) => {
  const r = await q(
    `SELECT r.*, pu.full_name AS passenger_name, du.full_name AS driver_name
     FROM rides r
     JOIN users pu ON pu.id=r.passenger_user_id
     LEFT JOIN drivers d ON d.id=r.driver_id
     LEFT JOIN users du ON du.id=d.user_id
     ORDER BY r.created_at DESC
     LIMIT 200`,
    []
  );
  res.json({ rides: r.rows });
});

adminRouter.post('/admins', async (req, res) => {
  // create another admin
  const { phone, password, full_name } = req.body || {};
  if (!phone || !password || password.length < 4) return res.status(400).json({ error: 'invalid_input' });
  const exists = await q('SELECT id FROM users WHERE phone=$1', [phone]);
  if (exists.rowCount) return res.status(409).json({ error: 'phone_exists' });
  const pass_hash = await bcrypt.hash(password, 10);
  const u = await q('INSERT INTO users(role, phone, pass_hash, full_name) VALUES($1,$2,$3,$4) RETURNING id, phone, full_name', ['admin', phone, pass_hash, full_name || null]);
  res.json({ admin: u.rows[0] });
});

