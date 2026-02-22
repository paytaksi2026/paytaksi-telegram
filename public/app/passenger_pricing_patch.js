
/* ===== PASSENGER MAP PATCH ===== */

async function getPricing(){
  const r = await fetch('/api/settings');
  return await r.json();
}

async function estimateFare(km){
  const p = await getPricing();
  const raw = p.fare_base + (km * p.fare_per_km);
  return Math.max(p.fare_min, raw).toFixed(2);
}

// Replace preview price calculation with:
// const fare = await estimateFare(km);
// document.getElementById('estFare').textContent = fare + ' AZN';
