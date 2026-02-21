import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { apiClient } from './api.js';

const BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('ADMIN_BOT_TOKEN is missing');

const api = apiClient();
const bot = new Telegraf(BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id));
}

bot.start(async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ İcazə yoxdur');
  await api.post('/api/register', { telegram_id: String(ctx.from.id), role: 'admin', full_name: ctx.from.first_name });
  return ctx.reply('🛠 PayTaksi Admin\n\nKomandalar:\n/stats\n/online_drivers');
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  // simple stats via sqlite raw endpoint not implemented; do quick queries through /health + drivers
  const health = await api.get('/health');
  const drivers = await api.get('/api/drivers/online');
  await ctx.reply(`✅ Backend: ${health.data?.ok ? 'OK' : 'NO'}\n🟢 Onlayn sürücülər: ${drivers.data?.drivers?.length || 0}`);
});

bot.command('online_drivers', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data } = await api.get('/api/drivers/online');
  if (!data?.drivers?.length) return ctx.reply('Onlayn sürücü yoxdur');
  const lines = data.drivers.map(d => `• ${d.full_name || 'Sürücü'} | ${d.car_model || '-'} | ${d.car_plate || '-'} | (${Number(d.lat).toFixed(5)}, ${Number(d.lon).toFixed(5)})`);
  return ctx.reply(lines.join('\n'));
});

bot.launch();
console.log('✅ Admin bot started');
