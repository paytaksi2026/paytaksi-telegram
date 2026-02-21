// PayTaksi v2 Enterprise — One Bot (Passenger + Driver + Admin)
// Uses Telegram WebApp buttons to open passenger/driver/admin mini apps.
// Env:
//   TELEGRAM_BOT_TOKEN
//   WEBAPP_PASSENGER_URL
//   WEBAPP_DRIVER_URL
//   WEBAPP_ADMIN_URL

const { Telegraf, Markup } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is missing');
  module.exports = null;
  return;
}

const passengerUrl = process.env.WEBAPP_PASSENGER_URL || (process.env.WEBAPP_URL ? `${process.env.WEBAPP_URL}/passenger` : null);
const driverUrl = process.env.WEBAPP_DRIVER_URL || (process.env.WEBAPP_URL ? `${process.env.WEBAPP_URL}/driver` : null);
const adminUrl = process.env.WEBAPP_ADMIN_URL || (process.env.WEBAPP_URL ? `${process.env.WEBAPP_URL}/admin` : null);

const bot = new Telegraf(token);

function mainKeyboard() {
  const rows = [];
  if (passengerUrl) rows.push([Markup.button.webApp('🧭 Sərnişin (Xəritə)', passengerUrl)]);
  if (driverUrl) rows.push([Markup.button.webApp('🚗 Sürücü Paneli', driverUrl)]);
  if (adminUrl) rows.push([Markup.button.webApp('🛠 Admin Panel', adminUrl)]);
  rows.push([
    Markup.button.callback('ℹ️ Kömək', 'help'),
    Markup.button.callback('🔄 Yenilə', 'refresh'),
  ]);
  return Markup.inlineKeyboard(rows);
}

const WELCOME = `PayTaksi 🚕\n\nSeçim et:\n• Sərnişin: xəritədən sifariş\n• Sürücü: online ol, sifariş qəbul et\n• Admin: sürücü təsdiqlə, gəlir/withdraw\n\nQeyd: Mini App-lar Telegram daxilində açılır.`;

bot.start(async (ctx) => {
  await ctx.reply(WELCOME, mainKeyboard());
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'İstifadə: \n' +
      '1) 🧭 Sərnişin (Xəritə) → ünvan seç → qiymət/ETA → sifariş\n' +
      '2) 🚗 Sürücü Paneli → qeydiyyat/təsdiq → Online\n' +
      '3) 🛠 Admin Panel → login → sürücü approval\n\nƏgər düymə açılmırsa: Telegram-ı yenilə və /start yaz.',
    mainKeyboard()
  );
});

bot.action('refresh', async (ctx) => {
  await ctx.answerCbQuery('Yeniləndi ✅');
  await ctx.editMessageReplyMarkup(mainKeyboard().reply_markup).catch(() => {});
});

bot.on('message', async (ctx) => {
  // Keep chat clean; guide user to buttons.
  if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) return;
  await ctx.reply('Düymələrdən istifadə et 👇', mainKeyboard());
});

bot.launch().then(() => console.log('OneBot started ✅')).catch((e) => console.error('OneBot launch error:', e));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
