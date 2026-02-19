// ==== PAYTAKSI BACKEND (UPDATED - MAP FIX + NO DELETE PATCH) ====
// - Keeps previous behavior
// - Serves Telegram Mini App (passenger.html) from the same Render Web Service (FREE)
// - Starts bots inside the same service (no Background Worker needed)

const express = require("express");
const path = require("path");
const app = express();

// JSON
app.use(express.json());

// Try to mount existing routes (if any)
let routes;
try {
  routes = require("./routes");
  app.use("/", routes);
} catch (e) {
  console.log("routes.js not found / not loadable, continuing...");
}

// ===== Serve Mini App (FREE hosting from backend) =====
// Your repo has /web/passenger.html at project root.
// backend/src/index.js -> project root is 2 levels up.
const WEB_DIR = path.join(__dirname, "..", "..", "web");
app.use("/web", express.static(WEB_DIR));

// Friendly short URL for Telegram WebApp button:
// https://<service>.onrender.com/passenger
app.get("/passenger", (req, res) => {
  res.sendFile(path.join(WEB_DIR, "passenger.html"));
});

// Health
app.get("/", (req, res) => {
  res.send("PayTaksi backend işləyir ✅");
});

// Render PORT FIX
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("PayTaksi backend listening on " + PORT);

  // ==== START TELEGRAM BOTS INSIDE SAME SERVICE (FREE RENDER FIX) ====
  try {
    require("../../bots/passenger_bot");
    require("../../bots/driver_bot");
    require("../../bots/admin_bot");
    console.log("Telegram botları başladıldı ✅");
  } catch (e) {
    console.error("Bot start xətası:", e.message);
  }
});
