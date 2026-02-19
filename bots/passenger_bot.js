require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const token = process.env.PASSENGER_BOT_TOKEN;
if(!token){ console.error("PASSENGER_BOT_TOKEN yoxdur"); process.exit(1); }

const bot = new Telegraf(token);

bot.start(async (ctx)=>{
  const webUrl = process.env.WEBAPP_URL;
  if(!webUrl) return ctx.reply("WEBAPP_URL yoxdur (.env)");
  const u = new URL(webUrl);
  if(process.env.BACKEND_URL) u.searchParams.set("backend", process.env.BACKEND_URL);
  u.searchParams.set("chat_id", String(ctx.chat.id));
  return ctx.reply("PayTaksi 🚕\nSifariş üçün düyməni bas:", Markup.inlineKeyboard([
    Markup.button.webApp("🚕 Sifariş ver (Xəritə)", u.toString())
  ]));
});

bot.on("text",(ctx)=>ctx.reply("Xəritə üçün /start yaz."));
bot.launch().then(()=>console.log("Passenger bot started"));
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));
