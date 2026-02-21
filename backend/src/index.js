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
const { Pool } = require("pg");
require("dotenv").config();

// Optional Postgres (Render/Neon/etc). If DATABASE_URL is set we will use DB for nearby drivers.
let pgPool = null;
if (process.env.DATABASE_URL) {
  try {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    });
  } catch (e) {
    console.warn("PG init failed:", e.message);
    pgPool = null;
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}


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

// Route info (distance + duration) using OSRM public server
// GET /api/route?pickup_lat=..&pickup_lon=..&drop_lat=..&drop_lon=..
app.get("/api/route", async (req, res) => {
  try {
    const pl = parseFloat(req.query.pickup_lat);
    const plo = parseFloat(req.query.pickup_lon);
    const dl = parseFloat(req.query.drop_lat);
    const dlo = parseFloat(req.query.drop_lon);
    if (![pl, plo, dl, dlo].every((v) => Number.isFinite(v))) {
      return res.status(400).json({ ok: false, error: "pickup/drop coords required" });
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${plo},${pl};${dlo},${dl}?overview=false&alternatives=false&steps=false`;
    const r = await fetch(url, { headers: { "user-agent": "PayTaksi" } });
    const j = await r.json();
    if (!j || j.code !== "Ok" || !j.routes || !j.routes[0]) {
      return res.status(502).json({ ok: false, error: "route service error" });
    }
    const meters = j.routes[0].distance || 0;
    const seconds = j.routes[0].duration || 0;
    res.json({
      ok: true,
      distance_km: +(meters / 1000).toFixed(3),
      duration_min: +(seconds / 60).toFixed(2),
    });
  } catch (e) {
    console.error("/api/route error", e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// Same route endpoint but for WebApp (POST) - returns price too
// POST /api/route { pickup:{lat,lon}, dropoff:{lat,lon} }
app.post("/api/route", async (req, res) => {
  try {
    const pickup = req.body?.pickup;
    const dropoff = req.body?.dropoff;
    const pl = parseFloat(pickup?.lat);
    const plo = parseFloat(pickup?.lon);
    const dl = parseFloat(dropoff?.lat);
    const dlo = parseFloat(dropoff?.lon);
    if (![pl, plo, dl, dlo].every((v) => Number.isFinite(v))) {
      return res.status(400).json({ ok: false, error: "pickup/drop coords required" });
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${plo},${pl};${dlo},${dl}?overview=false&alternatives=false&steps=false`;
    const r = await fetch(url, { headers: { "user-agent": "PayTaksi" } });
    const j = await r.json();
    if (!j || j.code !== "Ok" || !j.routes || !j.routes[0]) {
      return res.status(502).json({ ok: false, error: "route service error" });
    }
    const meters = j.routes[0].distance || 0;
    const seconds = j.routes[0].duration || 0;
    const distanceKm = +(meters / 1000).toFixed(3);
    const durationMin = +(seconds / 60).toFixed(2);

    const price = computePrice(distanceKm, durationMin);

    res.json({
      ok: true,
      distanceKm,
      durationMin,
      price,
    });
  } catch (e) {
    console.error("/api/route POST error", e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// Nearest drivers (for passenger map)
// GET /api/nearby-drivers?lat=..&lon=..&limit=5
app.get("/api/nearby-drivers", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit || "5", 10)));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "lat/lon required" });
    }

    let candidates = [];

    if (pgPool) {
      // Expecting tables: drivers(id uuid, name, is_online, is_approved, ...), live_driver_locations(driver_id uuid, lat, lon, updated_at)
      const q = `
        SELECT d.id, COALESCE(d.name,'') AS name, l.lat, l.lon, l.updated_at
        FROM live_driver_locations l
        JOIN drivers d ON d.id = l.driver_id
        WHERE COALESCE(d.is_online,false) = true
          AND COALESCE(d.is_approved,false) = true
          AND l.updated_at > (NOW() - INTERVAL '10 minutes')
      `;
      const { rows } = await pgPool.query(q);
      candidates = rows
        .map((r) => ({
          driver_id: String(r.id),
          name: r.name,
          lat: Number(r.lat),
          lon: Number(r.lon),
          updated_at: r.updated_at,
        }))
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    } else {
      // Fallback to in-memory driverLocations (demo mode)
      candidates = Array.from(store.driverLocations.entries()).map(([driverId, loc]) => ({
        driver_id: String(driverId),
        name: store.drivers.get(String(driverId))?.name || "",
        lat: loc.lat,
        lon: loc.lon,
        updated_at: loc.ts,
      }));
    }

    for (const c of candidates) {
      c.distance_m = haversineMeters(lat, lon, c.lat, c.lon);
    }
    candidates.sort((a, b) => a.distance_m - b.distance_m);
    res.json({ ok: true, drivers: candidates.slice(0, limit) });
  } catch (e) {
    console.error("/api/nearby-drivers error", e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

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
