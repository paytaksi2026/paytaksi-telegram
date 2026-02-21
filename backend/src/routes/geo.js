import express from 'express';
import { geocode, reverse, route as osrmRoute, calcPrice } from '../lib/geo.js';

export const geoRouter = express.Router();

geoRouter.get('/geocode', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ results: [] });
  try {
    const results = await geocode(q);
    res.json({ results });
  } catch {
    res.status(502).json({ error: 'geocode_failed' });
  }
});

geoRouter.get('/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'invalid_coords' });
  try {
    const r = await reverse(lat, lon);
    res.json(r);
  } catch {
    res.status(502).json({ error: 'reverse_failed' });
  }
});

geoRouter.get('/route', async (req, res) => {
  const fromLat = Number(req.query.fromLat);
  const fromLon = Number(req.query.fromLon);
  const toLat = Number(req.query.toLat);
  const toLon = Number(req.query.toLon);
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) return res.status(400).json({ error: 'invalid_coords' });
  try {
    const r = await osrmRoute(fromLat, fromLon, toLat, toLon);
    const distance_km = r.distance_m / 1000;
    const price_azn = calcPrice(distance_km);
    res.json({ distance_km, duration_s: r.duration_s, price_azn });
  } catch {
    res.status(502).json({ error: 'route_failed' });
  }
});

