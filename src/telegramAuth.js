import crypto from 'node:crypto';

// Verify Telegram WebApp initData
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, error: 'missing_initdata_or_token' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'missing_hash' };
  params.delete('hash');

  // Build data check string
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push([k, v]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (computed !== hash) return { ok: false, error: 'bad_hash' };

  // Parse user
  const userJson = params.get('user');
  let user;
  try { user = userJson ? JSON.parse(userJson) : null; } catch { user = null; }

  return { ok: true, user, params };
}
