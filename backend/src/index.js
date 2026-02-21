import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authRouter } from './routes/auth.js';
import { passengerRouter } from './routes/passenger.js';
import { driverRouter } from './routes/driver.js';
import { adminRouter } from './routes/admin.js';
import { geoRouter } from './routes/geo.js';
import { q } from './lib/db.js';

dotenv.config();

const app = express();
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/geo', geoRouter);
app.use('/api/passenger', passengerRouter);
app.use('/api/driver', driverRouter);
app.use('/api/admin', adminRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PayTaksi backend listening on ${port}`);
});
