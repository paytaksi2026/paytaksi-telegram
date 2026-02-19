// Helper: build WebApp URL for Passenger button
// Usage: const { getWebAppUrl } = require("./webapp_url");
//        const url = getWebAppUrl();

function getWebAppUrl() {
  const web = process.env.WEBAPP_URL;
  const backend = process.env.BACKEND_URL || "";

  // If WEBAPP_URL is missing or equals backend root, default to /passenger served by backend
  if (!web || (backend && (web === backend || web === backend + "/"))) {
    if (!backend) return "";
    return backend.replace(/\/$/, "") + "/passenger";
  }
  return web;
}

module.exports = { getWebAppUrl };


function getDriverWebAppUrl(ctx){
  const base = process.env.WEBAPP_DRIVER_URL
    || process.env.DRIVER_WEBAPP_URL
    || (process.env.WEBAPP_URL ? process.env.WEBAPP_URL.replace(/\/passenger\/?$/,'/driver') : null);
  return pickUrl(ctx, base || (process.env.WEBAPP_URL ? (process.env.WEBAPP_URL.replace(/\/?$/,'') + '/driver') : null));
}

function getAdminWebAppUrl(ctx){
  const base = process.env.WEBAPP_ADMIN_URL
    || process.env.ADMIN_WEBAPP_URL
    || (process.env.WEBAPP_URL ? process.env.WEBAPP_URL.replace(/\/passenger\/?$/,'/admin') : null);
  return pickUrl(ctx, base || (process.env.WEBAPP_URL ? (process.env.WEBAPP_URL.replace(/\/?$/,'') + '/admin') : null));
}

module.exports.getDriverWebAppUrl = getDriverWebAppUrl;
module.exports.getAdminWebAppUrl = getAdminWebAppUrl;
