require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

const token = process.env.PASSENGER_BOT_TOKEN;
if(!token){ console.error("PASSENGER_BOT_TOKEN yoxdur"); process.exit(1); }

const bot = new Telegraf(token);

// Long Polling istifadə edirik. Webhook qalıbsa bot cavab verməyə bilər.
async function ensureLongPolling(){
  try{
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  }catch(e){
    console.warn("Passenger bot webhook silinmədi (normal ola bilər):", e?.message || e);
  }
}

function buildWebUrl(ctx){
  // Prefer WEBAPP_URL, fallback to BACKEND_URL + /passenger
  let webUrl = (process.env.WEBAPP_URL || "").trim();
  if(!webUrl){
    const backend = (process.env.BACKEND_URL || "").trim();
    if(backend) webUrl = backend.replace(/\/+$/,"") + "/passenger";
  }
  if(!webUrl) return null;

  let u;
  try { u = new URL(webUrl); } catch(e){ return null; }

  const backend = (process.env.BACKEND_URL || "").trim();
  if(backend) u.searchParams.set("backend", backend);

  // Fix: correct param name (was broken with leading quote)
  u.searchParams.set("chat_id", String(ctx.chat.id));
  return u.toString();
}

bot.start(async (ctx)=>{
  const url = buildWebUrl(ctx);
  if(!url) return ctx.reply("WEBAPP_URL və ya BACKEND_URL düzgün deyil (.env).");
  return ctx.reply("PayTaksi 🚕\nSifariş üçün düyməni bas:", Markup.inlineKeyboard([
    Markup.button.webApp("🚕 Sifariş ver (Xəritə)", url)
  ]));
});

bot.on("text",(ctx)=>ctx.reply("Xəritə üçün /start yaz."));
ensureLongPolling()
  .then(()=>bot.launch())
  .then(()=>console.log("Passenger bot started"))
  .catch((e)=>console.error("Passenger bot launch error:", e));
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));
