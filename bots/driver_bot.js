require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { post } = require("./api");

const token = process.env.DRIVER_BOT_TOKEN;
if(!token){ console.error("DRIVER_BOT_TOKEN yoxdur"); process.exit(1); }
const bot = new Telegraf(token);

function driverWebAppUrl(){
  const explicit = (process.env.DRIVER_WEBAPP_URL||"").trim();
  if(explicit) return explicit;
  const base=(process.env.BACKEND_URL||process.env.BASE_URL||"").trim().replace(/\/$/,"");
  return base? (base+"/driver") : "";
}

const state = new Map(); // chatId -> {online, name, car, lastOrderId}

function mainKeyboard(){
  const rows=[];
  const w=driverWebAppUrl();
  if(w){
    rows.push([Markup.button.webApp("🚖 Sürücü Paneli (Web)", w)]);
  }
  rows.push(["🟢 Onlayn ol","🔴 Oflayn ol"]);
  rows.push(["📍 Yer göndər"]);
  rows.push(["ℹ️ Qəbul: /accept ID"]);
  return Markup.keyboard(rows).resize();
}

bot.start((ctx)=>{
  if(!state.has(ctx.chat.id)) state.set(ctx.chat.id,{online:false,name:ctx.from.first_name||"",car:"Toyota Aqua"});
  ctx.reply("Sürücü paneli 🚕\n\n✅ Premium: Web panel düyməsi yuxarıda görünür (varsa).", mainKeyboard());
});

bot.hears("🟢 Onlayn ol",(ctx)=>{
  const st=state.get(ctx.chat.id)||{};
  st.online=true; state.set(ctx.chat.id,st);
  ctx.reply("Onlayn ✅ İndi location göndər: '📍 Yer göndər'", mainKeyboard());
});

bot.hears("🔴 Oflayn ol",(ctx)=>{
  const st=state.get(ctx.chat.id)||{};
  st.online=false; state.set(ctx.chat.id,st);
  ctx.reply("Oflayn ✅", mainKeyboard());
});

bot.hears("📍 Yer göndər",(ctx)=>{
  ctx.reply("Telegram-da Location göndər (Attach -> Location).");
});

bot.on("location", async (ctx)=>{
  const st=state.get(ctx.chat.id)||{online:true,car:"Toyota Aqua"};
  const lat=ctx.message.location.latitude;
  const lon=ctx.message.location.longitude;
  await post("/api/driver/update",{driverId:String(ctx.chat.id),lat,lon,online:!!st.online,name:st.name||ctx.from.first_name||"",car:st.car||"Car"});
  ctx.reply("Yer yeniləndi ✅");
});

bot.command("accept", async (ctx)=>{
  const parts=(ctx.message.text||"").trim().split(" ");
  const orderId=parts[1];
  if(!orderId) return ctx.reply("İstifadə: /accept ORDER_ID");
  const st=state.get(ctx.chat.id)||{car:"Toyota Aqua"};
  const j=await post("/api/order/"+orderId+"/accept",{driverId:String(ctx.chat.id),name:st.name||ctx.from.first_name||"",car:st.car||"Car"});
  if(!j.ok) return ctx.reply("Xəta: "+(j.error||""));
  st.lastOrderId=orderId; state.set(ctx.chat.id,st);
  const p=j.order.pickup, d=j.order.dropoff;
  const w1=`waze://?ll=${p.lat},${p.lon}&navigate=yes`;
  const w2=`waze://?ll=${d.lat},${d.lon}&navigate=yes`;
  ctx.reply(`Qəbul edildi ✅ #${orderId}\nQiymət: ${j.order.price} ₼\n\nQarşılama Waze: ${w1}\nGediləcək Waze: ${w2}\n\n/status: /arrived /starttrip /endtrip`, mainKeyboard());
});

bot.command("arrived", async (ctx)=>{
  const st=state.get(ctx.chat.id)||{};
  if(!st.lastOrderId) return ctx.reply("Aktiv sifariş yoxdur.");
  await post("/api/order/"+st.lastOrderId+"/status",{status:"ARRIVED"});
  ctx.reply("Status: Çatıb ✅");
});
bot.command("starttrip", async (ctx)=>{
  const st=state.get(ctx.chat.id)||{};
  if(!st.lastOrderId) return ctx.reply("Aktiv sifariş yoxdur.");
  await post("/api/order/"+st.lastOrderId+"/status",{status:"TRIP_STARTED"});
  ctx.reply("Status: Gedişə başla ✅");
});
bot.command("endtrip", async (ctx)=>{
  const st=state.get(ctx.chat.id)||{};
  if(!st.lastOrderId) return ctx.reply("Aktiv sifariş yoxdur.");
  await post("/api/order/"+st.lastOrderId+"/status",{status:"TRIP_ENDED"});
  ctx.reply("Status: Gediş bitdi ✅");
});

bot.launch().then(()=>console.log("Driver bot started"));
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));
