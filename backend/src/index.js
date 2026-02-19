
// ==== PAYTAKSI BACKEND (UPDATED - NO DELETE PATCH) ====

const express = require("express");
const app = express();

// Keep existing imports if they exist
let routes;
try {
  routes = require("./routes");
} catch (e) {
  console.log("routes.js not found, continuing...");
}

app.use(express.json());

if (routes) {
  app.use("/", routes);
}

// Render PORT FIX (no deletion)
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("PayTaksi backend işləyir ✅");
});

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
