export function calcPrice(distanceKm) {
  const base = Number(process.env.PRICE_BASE_AZN || 2.0);
  const perKm = Number(process.env.PRICE_PER_KM_AZN || 0.6);
  const minPrice = Number(process.env.PRICE_MIN_AZN || 2.8);

  const raw = base + perKm * Math.max(0, distanceKm);
  const price = Math.max(minPrice, Math.round(raw * 100) / 100);
  return price;
}
