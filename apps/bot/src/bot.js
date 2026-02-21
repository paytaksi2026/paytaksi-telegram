require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error('Missing BOT_TOKEN or WEBAPP_URL');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply(
    '🚕 PayTaksi Mini App\n\nDaxil olmaq üçün düyməyə bas:',
    Markup.inlineKeyboard([
      Markup.button.webApp('Mini App aç', WEBAPP_URL)
    ])
  );
});

bot.command('app', async (ctx) => {
  await ctx.reply('Mini App:', Markup.inlineKeyboard([Markup.button.webApp('Aç', WEBAPP_URL)]));
});

bot.launch().then(() => console.log('Bot started')).catch(console.error);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
