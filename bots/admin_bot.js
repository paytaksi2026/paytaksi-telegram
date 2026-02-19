require("dotenv").config();
const { Telegraf } = require("telegraf");
const { getAdminWebAppUrl } = require("./webapp_url");
const { get } = require("./api");

const token = process.env.ADMIN_BOT_TOKEN;
if(!token){ console.error("ADMIN_BOT_TOKEN yoxdur"); process.exit(1); }
const bot = new Telegraf(token);

bot.start((ctx)=>ctx.reply("Admin bot 🛠️\n/health\n/drivers"));

bot.command("health", async (ctx)=>{
  try{ const r=await get("/health"); ctx.reply(r.ok?"Backend OK ✅":"Backend Xəta"); }
  catch(e){ ctx.reply("Backendə qoşulma xətası"); }
});

bot.command("drivers", async (ctx)=>{
  try{
    const r=await get("/api/drivers");
    if(!r.ok) return ctx.reply("Xəta");
    if(!r.drivers.length) return ctx.reply("Driver yoxdur.");
    const lines=r.drivers.slice(0,20).map(d=>`• ${d.driverId} ${d.online?"🟢":"🔴"} ${d.car||""}`);
    ctx.reply("Sürücülər:\n"+lines.join("\n"));
  }catch(e){ ctx.reply("Xəta"); }
});

bot.launch().then(()=>console.log("Admin bot started"));
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));


bot.command('panel', async (ctx) => {
  const adminWebAppUrl = getAdminWebAppUrl();
  return ctx.reply('🧰 Admin panelini aç:', {
    reply_markup: {
      keyboard: [[{ text: '🧰 Admin Paneli (App)', web_app: { url: adminWebAppUrl } }]],
      resize_keyboard: true
    }
  });
});
