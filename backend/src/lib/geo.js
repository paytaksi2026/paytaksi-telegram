import fetch from 'node-fetch';

const NOMINATIM_BASE = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
const OSRM_BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';

function uaHeaders() {
  return {
    'User-Agent': process.env.APP_UA || 'PayTaksi/1.0 (contact: admin@example.com)',
    'Accept': 'application/json'
  };
}

export async function geocode(q) {
  const url = new URL('/search', NOMINATIM_BASE);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '5');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('q', q);
  const r = await fetch(url.toString(), { headers: uaHeaders() });
  if (!r.ok) throw new Error('geocode_failed');
  const data = await r.json();
  return data.map(x => ({
    display_name: x.display_name,
    lat: Number(x.lat),
    lon: Number(x.lon)
  }));
}

export async function reverse(lat, lon) {
  const url = new URL('/reverse', NOMINATIM_BASE);
  url.searchParams.set('format', 'json');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('zoom', '18');
  const r = await fetch(url.toString(), { headers: uaHeaders() });
  if (!r.ok) throw new Error('reverse_failed');
  const data = await r.json();
  return { display_name: data.display_name || null };
}

export async function route(fromLat, fromLon, toLat, toLon) {
  // OSRM expects lon,lat
  const url = new URL(`/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}`, OSRM_BASE);
  url.searchParams.set('overview', 'false');
  url.searchParams.set('alternatives', 'false');
  const r = await fetch(url.toString(), { headers: uaHeaders() });
  if (!r.ok) throw new Error('route_failed');
  const data = await r.json();
  const rt = data?.routes?.[0];
  if (!rt) throw new Error('route_not_found');
  return {
    distance_m: rt.distance,
    duration_s: rt.duration
  };
}

export function calcPrice(distanceKm) {
  const base = Number(process.env.PRICE_BASE_AZN || 3.5);
  const perKm = Number(process.env.PRICE_PER_KM_AZN || 0.4);
  const price = base + perKm * distanceKm;
  // round to 2 decimals
  return Math.round(price * 100) / 100;
}
