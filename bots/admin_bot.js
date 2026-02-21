require("dotenv").config();
const { Telegraf } = require("telegraf");
const { get } = require("./api");

const token = process.env.ADMIN_BOT_TOKEN;
if(!token){ console.error("ADMIN_BOT_TOKEN yoxdur"); process.exit(1); }
const bot = new Telegraf(token);

function adminWebAppUrl(){
  const explicit = (process.env.ADMIN_WEBAPP_URL||"").trim();
  if(explicit) return explicit;
  const base=(process.env.BACKEND_URL||process.env.BASE_URL||"").trim().replace(/\/$/,"");
  return base? (base+"/admin") : "";
}

function startMsg(){
  return "Admin bot 🛠️\n/health\n/drivers\n\n✅ Premium: Web admin panel düyməsi varsa, aşağıda görünəcək.";
}

bot.start((ctx)=>{
  const url=adminWebAppUrl();
  if(!url) return ctx.reply(startMsg());
  return ctx.reply(startMsg(), {
    reply_markup:{
      inline_keyboard:[[ {text:"🧩 Admin Panel (Web)", web_app:{url}} ]]
    }
  });
});

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
