import fetch from 'node-fetch';

function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export async function tgSendMessage(token, chatId, text, extra = {}) {
  if (!token) return { ok: false, skipped: true };
  const res = await fetch(apiUrl(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra })
  });
  const data = await res.json().catch(() => ({}));
  return data;
}
