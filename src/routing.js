export async function routeDistanceKm(pickup, drop) {
  const base = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org';
  const url = `${base}/route/v1/driving/${pickup.lng},${pickup.lat};${drop.lng},${drop.lat}?overview=false`;
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`OSRM error ${r.status}`);
  const j = await r.json();
  const meters = j?.routes?.[0]?.distance;
  if (!meters) throw new Error('OSRM missing distance');
  return meters / 1000;
}
