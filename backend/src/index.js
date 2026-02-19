const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

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

// --- In-memory store (MVP) ---
const store = {
  drivers: new Map(), // driverId -> {lat, lon, ts, online, name, car}
  orders: new Map(),  // orderId -> {status, pickup, dropoff, price, distanceKm, passengerChatId, driverId}
  chats: new Map(),   // orderId -> [{from, text, ts}]
};

// Haversine distance in km
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
  const base = Number(process.env.BASE_FEE || 1.0);
  const per = Number(process.env.PRICE_PER_KM || 0.5);
  return Math.max(0, +(base + km * per).toFixed(2));
}

app.get("/", (req, res) => {
  res.type("text/plain").send("PayTaksi backend işləyir ✅");
});
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("PayTaksi backend listening on", PORT);
});
