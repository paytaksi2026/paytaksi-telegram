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
