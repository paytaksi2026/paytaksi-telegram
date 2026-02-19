function normalizeBase(base) {
  if (!base) return null;
  base = String(base).trim();
  if (!base) return null;
  return base.replace(/\/+$/, "");
}

function baseFromEnv() {
  return (
    normalizeBase(process.env.RENDER_EXTERNAL_URL) ||
    normalizeBase(process.env.PUBLIC_URL) ||
    null
  );
}

function getPassengerWebAppUrl() {
  const env = normalizeBase(process.env.WEBAPP_URL);
  if (env) return env;
  const base = baseFromEnv();
  if (base) return base + "/passenger";
  return null;
}

function getDriverWebAppUrl() {
  const env = normalizeBase(process.env.DRIVER_WEBAPP_URL);
  if (env) return env;
  const base = baseFromEnv();
  if (base) return base + "/driver";
  return null;
}

function getAdminWebAppUrl() {
  const env = normalizeBase(process.env.ADMIN_WEBAPP_URL);
  if (env) return env;
  const base = baseFromEnv();
  if (base) return base + "/admin";
  return null;
}

// Backward compat with older code
function getWebAppUrl() {
  return getPassengerWebAppUrl();
}

module.exports = {
  getWebAppUrl,
  getPassengerWebAppUrl,
  getDriverWebAppUrl,
  getAdminWebAppUrl,
};
