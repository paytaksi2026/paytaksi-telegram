import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import path from 'path';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN || BOT_TOKEN.includes('PASTE_YOUR_TOKEN_HERE')) {
  console.error('❌ BOT_TOKEN boşdur. .env yaradıb BOT_TOKEN yazın.');
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;

const bot = new Telegraf(BOT_TOKEN);

// --- Simple persistence (JSON) ---
const DATA_DIR = path.resolve('./data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify({ lastId: 0, orders: [] }, null, 2), 'utf-8');
}
ensureData();

function loadOrders() {
  ensureData();
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
}
function saveOrders(obj) {
  ensureData();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

// --- Minimal address dataset for suggestions (Bakı) ---
const BAKU_PLACES = [
  '28 May metrosu',
  'Gənclik metrosu',
  'Nəriman Nərimanov metrosu',
  'Nizami metrosu',
  'Elmlər Akademiyası metrosu',
  'İçərişəhər metrosu',
  'Sahil metrosu',
  'Xalqlar Dostluğu metrosu',
  'Koroğlu metrosu',
  'Avtovağzal',
  'Həzi Aslanov metrosu',
  'Əhmədli metrosu',
  'Xətai metrosu',
  'Bakmil metrosu',
  'Dərnəgül metrosu',
  'Memar Əcəmi metrosu',
  '20 Yanvar metrosu',
  'Neftçilər metrosu',
  'Qara Qarayev metrosu',
  'Azadlıq prospekti metrosu',
  'Xırdalan (mərkəz)',
  'Binəqədi',
  'Yasamal',
  'Nəsimi',
  'Xətai rayonu',
  'Nərimanov rayonu',
  'Səbail',
  'Bakı Bulvarı',
  'Dənizkənarı Milli Park',
  'Heydər Əliyev Mərkəzi',
  'Tələbə şəhərciyi',
  'Bakı Olimpiya Stadionu',
  'Aeroport (Heydər Əliyev)',
  'Tarqovı (Nizami küçəsi)',
  'Fəvvarələr Meydanı',
  'Şəhidlər Xiyabanı',
  'Uluqbəy (8-ci km bazarı)',
];

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[ə]/g, 'e')
    .replace(/[ı]/g, 'i')
    .replace(/[ö]/g, 'o')
    .replace(/[ü]/g, 'u')
    .replace(/[ç]/g, 'c')
    .replace(/[ş]/g, 's')
    .replace(/[ğ]/g, 'g')
    .trim();
}

function suggestPlaces(query, limit = 5) {
  const q = normalize(query);
  if (!q) return [];
  // simple contains + startswith scoring
  const scored = BAKU_PLACES.map(p => {
    const pn = normalize(p);
    let score = 0;
    if (pn.startsWith(q)) score += 3;
    if (pn.includes(q)) score += 2;
    // token overlap
    const qTokens = q.split(/\s+/).filter(Boolean);
    for (const t of qTokens) if (pn.includes(t)) score += 1;
    return { p, score };
  }).filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score || a.p.localeCompare(b.p));
  return scored.slice(0, limit).map(x => x.p);
}

// --- Session state per user (memory) ---
/**
 * stages:
 *  - idle
 *  - waiting_pickup
 *  - choosing_pickup
 *  - waiting_dropoff
 *  - choosing_dropoff
 *  - confirming
 */
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      stage: 'idle',
      pickup: null,
      dropoff: null,
      pickupLoc: null,
      dropoffLoc: null,
      lastSuggestions: [],
      lastField: null, // 'pickup'|'dropoff'
    });
  }
  return sessions.get(userId);
}

function resetSession(userId) {
  sessions.set(userId, {
    stage: 'idle',
    pickup: null,
    dropoff: null,
    pickupLoc: null,
    dropoffLoc: null,
    lastSuggestions: [],
    lastField: null,
  });
}

function mainMenu() {
  return Markup.keyboard([
    ['🚕 Sifariş ver', '📍 Kömək'],
  ]).resize();
}

function orderKeyboard() {
  return Markup.keyboard([
    ['📍 Cari yerimi göndər', '✍️ Ünvanı yaz'],
    ['❌ Ləğv et'],
  ]).resize();
}

function cancelKeyboard() {
  return Markup.keyboard([['❌ Ləğv et']]).resize();
}

function suggestionsKeyboard(suggestions) {
  const rows = suggestions.map(s => [s]);
  rows.push(['✍️ Başqa ünvan yaz']);
  rows.push(['❌ Ləğv et']);
  return Markup.keyboard(rows).resize();
}

function confirmKeyboard() {
  return Markup.keyboard([
    ['✅ Təsdiqlə', '🔁 Yenidən'],
    ['❌ Ləğv et'],
  ]).resize();
}

async function promptPickup(ctx) {
  const s = getSession(ctx.from.id);
  s.stage = 'waiting_pickup';
  s.lastField = 'pickup';
  await ctx.reply(
    '📍 *Götürülmə ünvanı* seçin:\n\n• “📍 Cari yerimi göndər” (GPS)\n• və ya “✍️ Ünvanı yaz”',
    { parse_mode: 'Markdown', ...orderKeyboard() }
  );
}

async function promptDropoff(ctx) {
  const s = getSession(ctx.from.id);
  s.stage = 'waiting_dropoff';
  s.lastField = 'dropoff';
  await ctx.reply(
    '🏁 *Gedəcəyiniz ünvanı* seçin:\n\n• Ünvanı yazın (məs: 28 May metrosu, Tarqovı)\n• və ya GPS göndərin',
    { parse_mode: 'Markdown', ...orderKeyboard() }
  );
}

function formatOrderSummary(s) {
  const pickup = s.pickupLoc ? `📍 GPS: ${s.pickupLoc.lat.toFixed(6)}, ${s.pickupLoc.lng.toFixed(6)}` : `📍 ${s.pickup || '—'}`;
  const dropoff = s.dropoffLoc ? `🏁 GPS: ${s.dropoffLoc.lat.toFixed(6)}, ${s.dropoffLoc.lng.toFixed(6)}` : `🏁 ${s.dropoff || '—'}`;
  return `Sifariş xülasəsi:\n\n${pickup}\n${dropoff}\n\nÖdəniş: Nağd\nŞəhər: Bakı\n\nTəsdiqləyirsiniz?`;
}

function newOrderId() {
  const db = loadOrders();
  db.lastId += 1;
  saveOrders(db);
  return db.lastId;
}

function addOrder(order) {
  const db = loadOrders();
  db.orders.push(order);
  saveOrders(db);
}

function escapeMd(s) {
  return (s || '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

bot.start(async (ctx) => {
  resetSession(ctx.from.id);
  await ctx.reply(
    'Salam! 🚕 *PayTaksi* botuna xoş gəldiniz.\n\nSifariş üçün “🚕 Sifariş ver” seçin.',
    { parse_mode: 'Markdown', ...mainMenu() }
  );
});

bot.hears('📍 Kömək', async (ctx) => {
  await ctx.reply(
    'ℹ️ *Kömək*\n\n• “🚕 Sifariş ver” — taksi sifarişi.\n• Ünvanı özünüz yaza bilərsiniz və bot alternativlər göstərəcək.\n• Başqası üçün çağırırsınızsa: pickup-u ayrıca yazın.\n\nKomandalar:\n/order — sifariş ver\n/cancel — ləğv et',
    { parse_mode: 'Markdown', ...mainMenu() }
  );
});

bot.command('order', async (ctx) => {
  resetSession(ctx.from.id);
  await promptPickup(ctx);
});

bot.hears('🚕 Sifariş ver', async (ctx) => {
  resetSession(ctx.from.id);
  await promptPickup(ctx);
});

bot.command('cancel', async (ctx) => {
  resetSession(ctx.from.id);
  await ctx.reply('❌ Ləğv edildi. Əsas menyu.', mainMenu());
});

bot.hears('❌ Ləğv et', async (ctx) => {
  resetSession(ctx.from.id);
  await ctx.reply('❌ Ləğv edildi. Əsas menyu.', mainMenu());
});

bot.hears('🔁 Yenidən', async (ctx) => {
  resetSession(ctx.from.id);
  await promptPickup(ctx);
});

bot.hears('📍 Cari yerimi göndər', async (ctx) => {
  const s = getSession(ctx.from.id);
  // Ask user to share location using special keyboard button
  await ctx.reply('Zəhmət olmasa lokasiyanızı göndərin:', Markup.keyboard([
    [Markup.button.locationRequest('📍 Lokasiyanı göndər')],
    ['❌ Ləğv et']
  ]).resize());
});

bot.on('location', async (ctx) => {
  const s = getSession(ctx.from.id);
  const loc = ctx.message.location;

  if (s.stage === 'waiting_pickup' || s.lastField === 'pickup') {
    s.pickupLoc = { lat: loc.latitude, lng: loc.longitude };
    s.pickup = null;
    await ctx.reply('✅ Pickup lokasiyası alındı.');
    await promptDropoff(ctx);
    return;
  }

  if (s.stage === 'waiting_dropoff' || s.lastField === 'dropoff') {
    s.dropoffLoc = { lat: loc.latitude, lng: loc.longitude };
    s.dropoff = null;
    s.stage = 'confirming';
    await ctx.reply(formatOrderSummary(s), { ...confirmKeyboard() });
    return;
  }

  // If idle, treat as pickup by default
  s.pickupLoc = { lat: loc.latitude, lng: loc.longitude };
  s.pickup = null;
  await ctx.reply('✅ Pickup lokasiyası alındı.');
  await promptDropoff(ctx);
});

bot.hears('✍️ Ünvanı yaz', async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.stage === 'waiting_pickup') {
    await ctx.reply('📍 Pickup ünvanını yazın (məs: 28 May metrosu, Yasamal):', cancelKeyboard());
    return;
  }
  if (s.stage === 'waiting_dropoff') {
    await ctx.reply('🏁 Dropoff ünvanını yazın (məs: Tarqovı, Gənclik metrosu):', cancelKeyboard());
    return;
  }
  // default
  await ctx.reply('Ünvanı yazın:', cancelKeyboard());
});

bot.hears('✍️ Başqa ünvan yaz', async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.lastField === 'pickup') {
    s.stage = 'waiting_pickup';
    await ctx.reply('📍 Pickup ünvanını yazın:', cancelKeyboard());
    return;
  }
  if (s.lastField === 'dropoff') {
    s.stage = 'waiting_dropoff';
    await ctx.reply('🏁 Dropoff ünvanını yazın:', cancelKeyboard());
    return;
  }
  await ctx.reply('Ünvanı yazın:', cancelKeyboard());
});

bot.hears('✅ Təsdiqlə', async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.stage !== 'confirming') {
    await ctx.reply('Əvvəl sifarişi tamamlayın. /order');
    return;
  }

  const orderId = newOrderId();
  const now = new Date().toISOString();

  const order = {
    id: orderId,
    created_at: now,
    passenger: {
      telegram_id: ctx.from.id,
      name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim() || null,
      username: ctx.from.username ? `@${ctx.from.username}` : null,
    },
    city: 'Bakı',
    payment: 'CASH',
    pickup: s.pickup ? { type: 'text', value: s.pickup } : (s.pickupLoc ? { type: 'gps', value: s.pickupLoc } : null),
    dropoff: s.dropoff ? { type: 'text', value: s.dropoff } : (s.dropoffLoc ? { type: 'gps', value: s.dropoffLoc } : null),
    status: 'NEW',
  };

  addOrder(order);

  // Notify passenger
  await ctx.reply(`✅ Sifariş qəbul edildi! #${orderId}\n\nSürücü tərəfi/dispatch inteqrasiyası növbəti mərhələdə əlavə olunacaq.`, mainMenu());

  // Notify admin if set
  if (ADMIN_CHAT_ID) {
    const p = order.pickup?.type === 'gps' ? `GPS: ${order.pickup.value.lat}, ${order.pickup.value.lng}` : (order.pickup?.value || '—');
    const d = order.dropoff?.type === 'gps' ? `GPS: ${order.dropoff.value.lat}, ${order.dropoff.value.lng}` : (order.dropoff?.value || '—');
    const userLine = order.passenger.username || order.passenger.name || String(order.passenger.telegram_id);

    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🚕 *Yeni sifariş* #${orderId}\n\n👤 ${escapeMd(userLine)}\n📍 Pickup: ${escapeMd(p)}\n🏁 Dropoff: ${escapeMd(d)}\n💵 Nağd\n🕒 ${escapeMd(now)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  resetSession(ctx.from.id);
});

bot.on('text', async (ctx) => {
  const s = getSession(ctx.from.id);
  const text = (ctx.message.text || '').trim();

  // ignore menu texts handled above
  if (!text) return;

  // If choosing from suggestions
  if (s.stage === 'choosing_pickup' && s.lastSuggestions.includes(text)) {
    s.pickup = text;
    s.pickupLoc = null;
    await ctx.reply(`✅ Pickup seçildi: ${text}`);
    await promptDropoff(ctx);
    return;
  }
  if (s.stage === 'choosing_dropoff' && s.lastSuggestions.includes(text)) {
    s.dropoff = text;
    s.dropoffLoc = null;
    s.stage = 'confirming';
    await ctx.reply(formatOrderSummary(s), { ...confirmKeyboard() });
    return;
  }

  // When waiting pickup/dropoff address
  if (s.stage === 'waiting_pickup') {
    s.lastField = 'pickup';
    const suggestions = suggestPlaces(text, 6);
    if (suggestions.length) {
      s.stage = 'choosing_pickup';
      s.lastSuggestions = suggestions;
      await ctx.reply('Alternativ ünvanlar:', suggestionsKeyboard(suggestions));
      return;
    }
    // no suggestions - accept raw
    s.pickup = text;
    s.pickupLoc = null;
    await ctx.reply(`✅ Pickup: ${text}`);
    await promptDropoff(ctx);
    return;
  }

  if (s.stage === 'waiting_dropoff') {
    s.lastField = 'dropoff';
    const suggestions = suggestPlaces(text, 6);
    if (suggestions.length) {
      s.stage = 'choosing_dropoff';
      s.lastSuggestions = suggestions;
      await ctx.reply('Alternativ ünvanlar:', suggestionsKeyboard(suggestions));
      return;
    }
    s.dropoff = text;
    s.dropoffLoc = null;
    s.stage = 'confirming';
    await ctx.reply(formatOrderSummary(s), { ...confirmKeyboard() });
    return;
  }

  // If idle: treat as /order shortcut
  if (s.stage === 'idle') {
    resetSession(ctx.from.id);
    await promptPickup(ctx);
    return;
  }

  // fallback
  await ctx.reply('Başa düşmədim. /order yazın və ya “🚕 Sifariş ver” seçin.', mainMenu());
});

bot.catch((err, ctx) => {
  console.error('Bot error', err);
});

bot.launch().then(() => console.log('✅ PayTaksi bot started'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
