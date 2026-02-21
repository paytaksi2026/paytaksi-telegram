import express from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../lib/db.js';
import { signToken } from '../lib/auth.js';

export const authRouter = express.Router();

authRouter.post('/register', async (req, res) => {
  const { role, phone, password, full_name, car_model, car_number } = req.body || {};
  if (!['passenger', 'driver'].includes(role)) return res.status(400).json({ error: 'invalid_role' });
  if (!phone || !password || password.length < 4) return res.status(400).json({ error: 'invalid_input' });

  const exists = await q('SELECT id FROM users WHERE phone=$1', [phone]);
  if (exists.rowCount) return res.status(409).json({ error: 'phone_exists' });

  const pass_hash = await bcrypt.hash(password, 10);
  const u = await q(
    'INSERT INTO users(role, phone, pass_hash, full_name) VALUES($1,$2,$3,$4) RETURNING id, role, phone, full_name',
    [role, phone, pass_hash, full_name || null]
  );

  if (role === 'driver') {
    // create driver profile (needs approval)
    await q(
      'INSERT INTO drivers(user_id, car_model, car_number, is_approved, is_online) VALUES($1,$2,$3,false,false)',
      [u.rows[0].id, car_model || null, car_number || null]
    );
  }

  const token = signToken(u.rows[0]);
  res.json({ token, user: u.rows[0] });
});

authRouter.post('/login', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'invalid_input' });

  const r = await q('SELECT id, role, phone, full_name, pass_hash FROM users WHERE phone=$1', [phone]);
  if (!r.rowCount) return res.status(401).json({ error: 'bad_credentials' });
  const user = r.rows[0];
  const ok = await bcrypt.compare(password, user.pass_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, role: user.role, phone: user.phone, full_name: user.full_name }
  });
});

