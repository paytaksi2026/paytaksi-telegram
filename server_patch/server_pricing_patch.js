
/* ===== PRICING SYSTEM PATCH (Add to server.js) ===== */

// In-memory pricing settings (you can later move to DB)
let pricingSettings = {
  fare_base: 1,
  fare_per_km: 0.5,
  fare_min: 2,
  commission: 10
};

app.get('/api/settings', (req, res) => {
  res.json(pricingSettings);
});

app.post('/api/settings', (req, res) => {
  const { fare_base, fare_per_km, fare_min, commission } = req.body;

  pricingSettings = {
    fare_base: parseFloat(fare_base),
    fare_per_km: parseFloat(fare_per_km),
    fare_min: parseFloat(fare_min),
    commission: parseInt(commission)
  };

  res.json({ success: true });
});

// Replace your current fare calculation inside order creation with:
function calculateFare(km) {
  const raw = pricingSettings.fare_base + (km * pricingSettings.fare_per_km);
  return Math.max(pricingSettings.fare_min, raw);
}

/* Then inside order create endpoint use:
   const fare = calculateFare(km);
*/
