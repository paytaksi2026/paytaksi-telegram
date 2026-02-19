// Helper: build Telegram Mini App (WebApp) URLs for passenger/driver/admin
// Works on Render (RENDER_EXTERNAL_URL) or custom WEBAPP_URL, DRIVER_WEBAPP_URL, ADMIN_WEBAPP_URL

function normalizeBase(url) {
  if (!url) return '';
  // remove trailing slash
  return String(url).trim().replace(/\/+$/, '');
}

function pickBaseUrl() {
  // Prefer explicit WEBAPP_URL (full base), else Render external URL
  const env = process.env;
  return normalizeBase(env.WEBAPP_URL || env.RENDER_EXTERNAL_URL || env.RENDER_URL || '');
}

function join(base, path) {
  if (!base) return '';
  if (!path) return base;
  if (path.startsWith('/')) return base + path;
  return base + '/' + path;
}

function getPassengerWebAppUrl() {
  const env = process.env;
  if (env.PASSENGER_WEBAPP_URL) return normalizeBase(env.PASSENGER_WEBAPP_URL);
  // If WEBAPP_URL already ends with /passenger keep it, else append
  const base = pickBaseUrl();
  if (!base) return '';
  if (base.endsWith('/passenger')) return base;
  return join(base, '/passenger');
}

function getDriverWebAppUrl() {
  const env = process.env;
  if (env.DRIVER_WEBAPP_URL) return normalizeBase(env.DRIVER_WEBAPP_URL);
  const base = pickBaseUrl();
  if (!base) return '';
  if (base.endsWith('/driver')) return base;
  // If user stored passenger URL in WEBAPP_URL, replace
  if (base.endsWith('/passenger')) return base.replace(/\/passenger$/, '/driver');
  return join(base, '/driver');
}

function getAdminWebAppUrl() {
  const env = process.env;
  if (env.ADMIN_WEBAPP_URL) return normalizeBase(env.ADMIN_WEBAPP_URL);
  const base = pickBaseUrl();
  if (!base) return '';
  if (base.endsWith('/admin')) return base;
  return join(base, '/admin');
}

module.exports = {
  getPassengerWebAppUrl,
  getDriverWebAppUrl,
  getAdminWebAppUrl,
};
