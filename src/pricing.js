export function calcPriceAzn(distanceKm) {
  const baseFare = Number(process.env.BASE_FARE_AZN ?? 3.5);
  const baseKm = Number(process.env.BASE_DISTANCE_KM ?? 3);
  const perKm = Number(process.env.PER_KM_AFTER_BASE_AZN ?? 0.4);

  const d = Math.max(0, Number(distanceKm) || 0);
  const extraKm = Math.max(0, d - baseKm);
  const price = baseFare + extraKm * perKm;
  return round2(price);
}

export function calcCommissionAzn(priceAzn) {
  const pct = Number(process.env.DRIVER_COMMISSION_PCT ?? 10);
  return round2((Number(priceAzn) || 0) * pct / 100);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
