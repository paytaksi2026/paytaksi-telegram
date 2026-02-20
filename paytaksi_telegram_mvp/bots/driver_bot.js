import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { apiClient } from './api.js';

const BOT_TOKEN = process.env.DRIVER_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('DRIVER_BOT_TOKEN is missing');

const api = apiClient();
const bot = new Telegraf(BOT_TOKEN);

const state = new Map(); // telegram_id -> { online, lat, lon, pollTimer }

function getState(id) {
  if (!state.has(id)) state.set(id, { online: false, lat: null, lon: null, pollTimer: null });
  return state.get(id);
}

async function startPolling(ctx) {
  const telegramId = String(ctx.from.id);
  const st = getState(telegramId);
  if (st.pollTimer) return;

  st.pollTimer = setInterval(async () => {
    try {
      if (!st.online || st.lat == null || st.lon == null) return;
      const { data } = await api.get('/api/orders/nearby', { params: { driver_telegram_id: telegramId, radius_km: 5 } });
      if (!data?.ok) return;

      for (const o of data.orders) {
        // simple dedupe: only send once per poll run by caching lastSent in memory
        if (st.lastSentOrderId === o.id) continue;
        st.lastSentOrderId = o.id;

        const pickup = o.pickup_text ? `📍 ${o.pickup_text}` : `📍 (${o.pickup_lat.toFixed(5)}, ${o.pickup_lon.toFixed(5)})`;
        const dropoff = o.dropoff_text ? `🏁 ${o.dropoff_text}` : `🏁 (${o.dropoff_lat.toFixed(5)}, ${o.dropoff_lon.toFixed(5)})`;

        await ctx.telegram.sendMessage(
          telegramId,
          `🆕 Yeni sifariş #${o.id}\n\n${pickup}\n${dropoff}\n\n📏 ~${o.distance_km?.toFixed(1) || '?'} km | 💰 ${Number(o.price_azn || 0).toFixed(2)} ₼\n\nSizə qədər: ${o.pickup_distance_km.toFixed(1)} km`,
          Markup.inlineKeyboard([
            Markup.button.callback(`✅ Qəbul et #${o.id}`, `accept_${o.id}`)
          ])
        );
      }
    } catch {
      // ignore
    }
  }, 5000);
}

bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  await api.post('/api/register', { telegram_id: telegramId, role: 'driver', full_name: ctx.from.first_name });

  await ctx.reply(
    '🚖 PayTaksi Sürücü\n\n1) “📍 Yer göndər” edin\n2) “🟢 Onlayn ol” edin\n\nSifariş gələndə “Qəbul et” basın.',
    Markup.keyboard([
      [Markup.button.locationRequest('📍 Yer göndər')],
      ['🟢 Onlayn ol', '🔴 Oflayn ol']
    ]).resize()
  );

  startPolling(ctx);
});

bot.hears('🟢 Onlayn ol', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const st = getState(telegramId);
  st.online = true;
  await api.post('/api/location/update', { telegram_id: telegramId, role: 'driver', lat: st.lat ?? 0, lon: st.lon ?? 0, is_online: true });
  await ctx.reply('✅ Onlayn oldunuz');
});

bot.hears('🔴 Oflayn ol', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const st = getState(telegramId);
  st.online = false;
  await api.post('/api/location/update', { telegram_id: telegramId, role: 'driver', lat: st.lat ?? 0, lon: st.lon ?? 0, is_online: false });
  await ctx.reply('✅ Oflayn oldunuz');
});

bot.on('location', async (ctx) => {
  const telegramId = String(ctx.from.id);
  const st = getState(telegramId);
  st.lat = ctx.message.location.latitude;
  st.lon = ctx.message.location.longitude;

  await api.post('/api/location/update', { telegram_id: telegramId, role: 'driver', lat: st.lat, lon: st.lon });
  await ctx.reply(`✅ Yer yadda saxlandı: ${st.lat.toFixed(5)}, ${st.lon.toFixed(5)}`);
});

bot.action(/accept_(\d+)/, async (ctx) => {
  const telegramId = String(ctx.from.id);
  const orderId = Number(ctx.match[1]);

  try {
    const { data } = await api.post('/api/order/accept', { order_id: orderId, driver_telegram_id: telegramId });
    if (!data?.ok) throw new Error('not_ok');

    const o = data.order;
    const pickup = o.pickup_text ? o.pickup_text : `${o.pickup_lat},${o.pickup_lon}`;
    const dropoff = o.dropoff_text ? o.dropoff_text : `${o.dropoff_lat},${o.dropoff_lon}`;

    const wazePickup = `waze://?ll=${o.pickup_lat},${o.pickup_lon}&navigate=yes`;
    const wazeDropoff = `waze://?ll=${o.dropoff_lat},${o.dropoff_lon}&navigate=yes`;

    await ctx.editMessageText(
      `✅ Sifariş qəbul edildi #${o.id}\n\n📍 Qarşılama: ${pickup}\n🏁 Gediləcək: ${dropoff}\n\n💬 Chat: sürücüdən yazmaq üçün: #${o.id} mesajınız\n\nNaviqasiya:`,
      Markup.inlineKeyboard([
        [Markup.button.url('🧭 Waze - Qarşılama', wazePickup)],
        [Markup.button.url('🧭 Waze - Gediləcək', wazeDropoff)]
      ])
    );

  } catch (e) {
    await ctx.answerCbQuery('Sifariş qəbul edilə bilmədi (artıq tutulub ola bilər).', { show_alert: true });
  }
});

// Driver chat messages: #45 salam
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const m = text.match(/^#(\d+)\s+([\s\S]+)/);
  if (!m) return;

  const order_id = Number(m[1]);
  const msg = m[2];

  try {
    await api.post('/api/chat/send', { order_id, from_role: 'driver', text: msg });
    await ctx.reply('✅ Göndərildi');
  } catch {
    await ctx.reply('❌ Xəta: mesaj göndərilmədi');
  }
});

bot.launch();
console.log('✅ Driver bot started');
