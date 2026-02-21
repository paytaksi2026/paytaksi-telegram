const jwt = require('jsonwebtoken');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'NO_TOKEN' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'BAD_TOKEN' });
  }
}

function roleRequired(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'NO_AUTH' });
    if (req.user.role !== role) return res.status(403).json({ error: 'FORBIDDEN' });
    next();
  };
}

function adminAuthRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'NO_TOKEN' });
  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'BAD_TOKEN' });
  }
}

module.exports = { authRequired, roleRequired, adminAuthRequired };
