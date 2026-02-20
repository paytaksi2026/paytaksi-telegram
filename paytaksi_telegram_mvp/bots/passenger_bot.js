import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { apiClient } from './api.js';

const BOT_TOKEN = process.env.PASSENGER_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('PASSENGER_BOT_TOKEN is missing');

const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:8080';
const api = apiClient();

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  await api.post('/api/register', { telegram_id: telegramId, role: 'passenger', full_name: ctx.from.first_name });

  return ctx.reply(
    '🚕 PayTaksi\n\nSifariş vermək üçün aşağıdakı düyməni basın:',
    Markup.inlineKeyboard([
      Markup.button.webApp('📍 Sifariş ver (xəritə)', `${WEBAPP_URL}/passenger.html`)
    ])
  );
});

bot.command('help', (ctx) => ctx.reply('Sifariş üçün /start -> "Sifariş ver"'));

// Relay chat messages: passenger -> driver (order_id prefix)
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  // format: #45 salam
  const m = text.match(/^#(\d+)\s+([\s\S]+)/);
  if (!m) return;

  const order_id = Number(m[1]);
  const msg = m[2];

  try {
    await api.post('/api/chat/send', { order_id, from_role: 'passenger', text: msg });
    await ctx.reply('✅ Göndərildi');
  } catch (e) {
    await ctx.reply('❌ Xəta: mesaj göndərilmədi');
  }
});

bot.launch();
console.log('✅ Passenger bot started');
