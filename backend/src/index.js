/**
 * PayTaksi Telegram - backend/src/index.js (PATCH 2)
 * Fixes Telegram "Not Found" by adding alias routes:
 *   /passenger, /passenger/, /passenger.html, /passenger/index.html
 * Also serves /web static directory.
 * Bots start inside same service (FREE, no worker).
 */
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS
const corsOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.includes("*")) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
  })
);

// ===== Serve Mini App (FREE) =====
const WEB_DIR = path.join(__dirname, "..", "..", "web");
app.use("/web", express.static(WEB_DIR));

function sendPassenger(res) {
  return res.sendFile(path.join(WEB_DIR, "passenger.html"));
}

function sendDriver(res) {
  return res.sendFile(path.join(WEB_DIR, "driver.html"));
}

function sendAdmin(res) {
  return res.sendFile(path.join(WEB_DIR, "admin.html"));
}

// Telegram sometimes opens different variants -> avoid 404
app.get("/passenger", (req, res) => sendPassenger(res));
app.get("/passenger/", (req, res) => sendPassenger(res));
app.get("/passenger.html", (req, res) => sendPassenger(res));
app.get("/passenger/index.html", (req, res) => sendPassenger(res));

// Driver mini app routes
app.get("/driver", (req, res) => sendDriver(res));
app.get("/driver/", (req, res) => sendDriver(res));
app.get("/driver.html", (req, res) => sendDriver(res));
app.get("/driver/index.html", (req, res) => sendDriver(res));

// Admin mini app routes
app.get("/admin", (req, res) => sendAdmin(res));
app.get("/admin/", (req, res) => sendAdmin(res));
app.get("/admin.html", (req, res) => sendAdmin(res));
app.get("/admin/index.html", (req, res) => sendAdmin(res));

// --- In-memory store (MVP) ---
const store = {
  drivers: new Map(),
  orders: new Map(),
  chats: new Map(),
};

function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function computePrice(km) {
  const base = Number(process.env.BASE_FEE || process.env.PRICE_BASE_AZN || 1.0);
  const per = Number(process.env.PRICE_PER_KM || process.env.PRICE_PER_KM_AZN || 0.5);
  const min = Number(process.env.PRICE_MIN_AZN || process.env.PRICE_MIN_AZN || 0);
  const p = +(base + km * per).toFixed(2);
  return Math.max(min, p);
}

// Health
app.get("/", (req, res) => {
  res.type("text/plain").send("PayTaksi backend işləyir ✅");
});
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== API =====
app.post("/api/price", (req, res) => {
  const { pickup, dropoff } = req.body || {};
  if (!pickup || !dropoff)
    return res.status(400).json({ ok: false, error: "pickup/dropoff required" });
  const km = distanceKm(pickup, dropoff);
  const price = computePrice(km);
  res.json({ ok: true, distanceKm: +km.toFixed(2), price });
});

app.post("/api/order", (req, res) => {
  const { pickup, dropoff, passengerChatId } = req.body || {};
  if (!pickup || !dropoff || !passengerChatId)
    return res
      .status(400)
      .json({ ok: false, error: "pickup, dropoff, passengerChatId required" });

  const km = distanceKm(pickup, dropoff);
  const price = computePrice(km);
  const orderId = String(Date.now());

  store.orders.set(orderId, {
    orderId,
    status: "SEARCHING",
    pickup,
    dropoff,
    price,
    distanceKm: +km.toFixed(2),
    passengerChatId,
    driverId: null,
  });

  broadcast({ type: "order_created", order: store.orders.get(orderId) });
  res.json({ ok: true, order: store.orders.get(orderId) });
});

app.post("/api/order/:orderId/accept", (req, res) => {
  const { orderId } = req.params;
  const { driverId, name, car } = req.body || {};
  const order = store.orders.get(orderId);
  if (!order) return res.status(404).json({ ok: false, error: "order not found" });
  if (!driverId) return res.status(400).json({ ok: false, error: "driverId required" });

  order.status = "ACCEPTED";
  order.driverId = String(driverId);

  const d = store.drivers.get(String(driverId)) || { online: true };
  if (name) d.name = name;
  if (car) d.car = car;
  store.drivers.set(String(driverId), d);

  broadcast({ type: "order_accepted", order });
  res.json({ ok: true, order });
});

app.post("/api/order/:orderId/status", (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body || {};
  const order = store.orders.get(orderId);
  if (!order) return res.status(404).json({ ok: false, error: "order not found" });
  if (!status) return res.status(400).json({ ok: false, error: "status required" });

  order.status = status;
  broadcast({ type: "order_status", orderId, status });
  res.json({ ok: true });
});

app.post("/api/order/:orderId/chat", (req, res) => {
  const { orderId } = req.params;
  const { from, text } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: "text required" });

  const arr = store.chats.get(orderId) || [];
  arr.push({ from: from || "unknown", text, ts: Date.now() });
  store.chats.set(orderId, arr);

  broadcast({ type: "chat", orderId, msg: arr[arr.length - 1] });
  res.json({ ok: true });
});

app.post("/api/driver/update", (req, res) => {
  const { driverId, lat, lon, online, name, car } = req.body || {};
  if (!driverId || typeof lat !== "number" || typeof lon !== "number") {
    return res.status(400).json({ ok: false, error: "driverId, lat, lon required" });
  }
  const d = store.drivers.get(String(driverId)) || {};
  d.lat = lat;
  d.lon = lon;
  d.ts = Date.now();
  if (typeof online === "boolean") d.online = online;
  if (name) d.name = name;
  if (car) d.car = car;

  store.drivers.set(String(driverId), d);
  broadcast({ type: "driver", driverId: String(driverId), data: d });
  res.json({ ok: true });
});

// ===== Geocoding helpers (Nominatim via backend) =====
// This keeps the Mini App simple and avoids CORS issues.
// NOTE: Respect Nominatim usage policy in production (add caching / rate-limit if needed).
app.get("/api/geocode", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q required" });

    const limit = Math.min(Number(req.query.limit || 6) || 6, 10);
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("accept-language", "az");
    url.searchParams.set("q", q);

    const r = await fetch(url.toString(), {
      headers: {
        // Identify your app (important for Nominatim)
        "User-Agent": "PayTaksiTelegram/1.0 (MiniApp)",
      },
    });
    const data = await r.json();
    const items = (Array.isArray(data) ? data : []).map((it) => ({
      display_name: it.display_name,
      lat: Number(it.lat),
      lon: Number(it.lon),
    }));
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: "geocode_failed" });
  }
});

app.get("/api/reverse", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "lat/lon required" });
    }
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "json");
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "az");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));

    const r = await fetch(url.toString(), {
      headers: { "User-Agent": "PayTaksiTelegram/1.0 (MiniApp)" },
    });
    const data = await r.json();
    const name = data && data.display_name ? String(data.display_name) : "";
    res.json({ ok: true, display_name: name, lat, lon });
  } catch (e) {
    res.status(500).json({ ok: false, error: "reverse_failed" });
  }
});

app.get("/api/drivers", (req, res) => {
  const out = [];
  for (const [id, d] of store.drivers.entries()) out.push({ driverId: id, ...d });
  res.json({ ok: true, drivers: out });
});

// --- WebSocket ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on("connection", (ws) => {
  clients.add(ws);

  const drivers = [];
  for (const [id, d] of store.drivers.entries()) drivers.push({ driverId: id, ...d });
  ws.send(JSON.stringify({ type: "drivers_snapshot", drivers }));

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "ping") ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    } catch (_) {}
  });

  ws.on("close", () => clients.delete(ws));
});

// Render PORT FIX
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("PayTaksi backend listening on", PORT);

  // Start bots inside same service (FREE)
  try {
    const botsDir = path.join(__dirname, "..", "..", "bots");
    require(path.join(botsDir, "passenger_bot.js"));
    require(path.join(botsDir, "driver_bot.js"));
    require(path.join(botsDir, "admin_bot.js"));
    console.log("Telegram botları başladıldı ✅");
  } catch (e) {
    console.error("Bot start xətası:", e && e.message ? e.message : e);
  }
});
