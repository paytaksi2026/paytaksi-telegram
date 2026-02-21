// PayTaksi - single-service MVP (0 AZN)
// NOTE: Render free instances can restart and memory will reset. For real persistence use external DB (Supabase/Neon).

const path = require("path");
const fs = require("fs");
const express = require("express");

const app = express();
app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Simple cookie helpers (no extra deps) ----
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const p = part.trim();
    if (!p) return;
    const i = p.indexOf("=");
    const k = p.slice(0, i);
    const v = decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  // On Render we are HTTPS, so it's safe to set Secure
  parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

// ---- In-memory stores (demo) ----
const users = new Map(); // key: `${role}:${phone}` -> { id, role, phone, name, passHash, status, createdAt }
let userAutoId = 1;

const sessions = new Map(); // token -> { role, phone, createdAt }
const adminSessions = new Map(); // token -> { createdAt }

function sha256(s) {
  return require("crypto").createHash("sha256").update(String(s)).digest("hex");
}
function cleanPhone(phone) {
  return String(phone || "").trim();
}
function cleanRole(role) {
  role = String(role || "").trim().toLowerCase();
  if (role === "passenger" || role === "musteri" || role === "müştəri") return "passenger";
  if (role === "driver" || role === "surucu" || role === "sürücü") return "driver";
  return "";
}

function userKey(role, phone) {
  return `${role}:${phone}`;
}

// Seed: keep working even if ENV missing
const ADMIN_USER = process.env.ADMIN_USER || "Ratik";
const ADMIN_PASS = process.env.ADMIN_PASS || "Sevenler1984";

// ---- Static files ----
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

// ---- Health ----
app.get("/health", (req, res) => res.type("text").send("OK"));

// ---- Auth API ----
app.post("/api/register", (req, res) => {
  const role = cleanRole(req.body.role);
  const phone = cleanPhone(req.body.phone);
  const password = String(req.body.password || "");
  const name = String(req.body.name || "").trim();

  if (!role) return res.status(400).json({ ok: false, code: "ROLE_REQUIRED" });
  if (!phone) return res.status(400).json({ ok: false, code: "PHONE_REQUIRED" });
  if (!password) return res.status(400).json({ ok: false, code: "PASSWORD_REQUIRED" });
  if (!name) return res.status(400).json({ ok: false, code: "NAME_REQUIRED" });

  const key = userKey(role, phone);
  if (users.has(key)) return res.status(409).json({ ok: false, code: "PHONE_EXISTS" });

  const status = role === "driver" ? "pending" : "approved";

  const u = {
    id: userAutoId++,
    role,
    phone,
    name,
    passHash: sha256(password),
    status,
    createdAt: Date.now(),
  };
  users.set(key, u);

  return res.json({
    ok: true,
    code: "REGISTERED",
    user: { id: u.id, role: u.role, phone: u.phone, name: u.name, status: u.status },
    message:
      role === "driver"
        ? "Qeydiyyat uğurlu oldu. Sürücü üçün admin təsdiqi gözlənilir (pending)."
        : "Qeydiyyat uğurlu oldu. Müştəri hesabı aktivdir.",
  });
});

app.post("/api/login", (req, res) => {
  const role = cleanRole(req.body.role);
  const phone = cleanPhone(req.body.phone);
  const password = String(req.body.password || "");

  if (!role) return res.status(400).json({ ok: false, code: "ROLE_REQUIRED" });
  if (!phone) return res.status(400).json({ ok: false, code: "PHONE_REQUIRED" });
  if (!password) return res.status(400).json({ ok: false, code: "PASSWORD_REQUIRED" });

  const key = userKey(role, phone);
  const u = users.get(key);
  if (!u) return res.status(401).json({ ok: false, code: "INVALID_CREDENTIALS" });

  if (u.passHash !== sha256(password)) return res.status(401).json({ ok: false, code: "INVALID_CREDENTIALS" });

  // Driver must be approved
  if (u.role === "driver" && u.status !== "approved") {
    return res.status(403).json({
      ok: false,
      code: "DRIVER_PENDING",
      message: "Sürücü hesabı admin təsdiqini gözləyir (pending).",
    });
  }

  const token = "u_" + require("crypto").randomBytes(24).toString("hex");
  sessions.set(token, { role: u.role, phone: u.phone, createdAt: Date.now() });

  setCookie(res, "pt_session", token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 7 });

  return res.json({
    ok: true,
    code: "LOGIN_OK",
    user: { id: u.id, role: u.role, phone: u.phone, name: u.name, status: u.status },
  });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.pt_session;
  if (token) sessions.delete(token);
  setCookie(res, "pt_session", "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 });
  return res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.pt_session;
  const sess = token ? sessions.get(token) : null;
  if (!sess) return res.status(401).json({ ok: false, code: "NO_SESSION" });

  const u = users.get(userKey(sess.role, sess.phone));
  if (!u) return res.status(401).json({ ok: false, code: "NO_SESSION" });

  return res.json({ ok: true, user: { id: u.id, role: u.role, phone: u.phone, name: u.name, status: u.status } });
});

// ---- Admin API ----
function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.pt_admin;
  if (!token || !adminSessions.has(token)) return res.status(401).json({ ok: false, code: "ADMIN_NO_SESSION" });
  next();
}

app.post("/api/admin/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || !password) return res.status(400).json({ ok: false, code: "REQUIRED" });

  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ ok: false, code: "LOGIN_ERROR" });
  }

  const token = "a_" + require("crypto").randomBytes(24).toString("hex");
  adminSessions.set(token, { createdAt: Date.now() });

  setCookie(res, "pt_admin", token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
  return res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.pt_admin;
  if (token) adminSessions.delete(token);
  setCookie(res, "pt_admin", "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 });
  return res.json({ ok: true });
});

app.get("/api/admin/drivers", requireAdmin, (req, res) => {
  const status = String(req.query.status || "all").toLowerCase();
  const out = [];
  for (const u of users.values()) {
    if (u.role !== "driver") continue;
    if (status !== "all" && u.status !== status) continue;
    out.push({ id: u.id, name: u.name, phone: u.phone, status: u.status });
  }
  out.sort((a, b) => a.id - b.id);
  res.json({ ok: true, drivers: out });
});

app.post("/api/admin/approve", requireAdmin, (req, res) => {
  const phone = cleanPhone(req.body.phone);
  if (!phone) return res.status(400).json({ ok: false, code: "PHONE_REQUIRED" });

  const key = userKey("driver", phone);
  const u = users.get(key);
  if (!u) return res.status(404).json({ ok: false, code: "NOT_FOUND" });

  u.status = "approved";
  users.set(key, u);
  res.json({ ok: true });
});

app.post("/api/admin/delete", requireAdmin, (req, res) => {
  const phone = cleanPhone(req.body.phone);
  if (!phone) return res.status(400).json({ ok: false, code: "PHONE_REQUIRED" });
  users.delete(userKey("driver", phone));
  res.json({ ok: true });
});

// ---- App pages (simple placeholders) ----
app.get("/app/passenger", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "app", "passenger.html")));
app.get("/app/driver", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "app", "driver.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin", "index.html")));

// fallback to index
app.get("*", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("PayTaksi server listening on", PORT));
