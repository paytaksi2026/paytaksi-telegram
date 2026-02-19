require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { post, get } = require("./api");

// Driver order notifications (avoid repeating same order)
const seenOrdersByDriver = new Map(); // driverId -> Set(orderId)
const onlineDrivers = new Set();

function kbOrderActions(orderId){
  return Markup.inlineKeyboard([
    Markup.button.callback("✅ Qəbul et", `acc:${orderId}`),
    Markup.button.callback("📍 Çatdı", `arr:${orderId}`),
    Markup.button.callback("🏁 Bitdi", `done:${orderId}`),
  ], { columns: 2 });
}

async function registerDriver(ctx){
  const driverId = String(ctx.chat.id);
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined;
  await post('/api/driver/register', { driverId, chatId: ctx.chat.id, name });
}

async function pollOrders(){
  for (const driverId of Array.from(onlineDrivers)){
    try{
      const data = await get(`/api/driver/orders?driverId=${encodeURIComponent(driverId)}`);
      if (!data || !data.ok || !Array.isArray(data.orders)) continue;
      const seen = seenOrdersByDriver.get(driverId) || new Set();
      for (const o of data.orders){
        if (!o || !o.id) continue;
        if (o.status !== 'SEARCHING') continue; // only new orders here
        if (seen.has(o.id)) continue;
        seen.add(o.id);

        const text = `🆕 Yeni sifariş #${o.id}\n\n📍 Haradan: ${o.from?.label || '-'}\n📍 Haraya: ${o.to?.label || '-'}\n📏 ${(o.distanceKm ?? '-')} km\n💰 ${(o.priceAzn ?? '-')} AZN\n\nQəbul etmək üçün düyməyə bas.`;
        await bot.telegram.sendMessage(Number(driverId), text, kbOrderActions(o.id));
      }
      seenOrdersByDriver.set(driverId, seen);
    }catch(e){
      // ignore
    }
  }
}

// Free-tier friendly polling (no Background Worker needed)
setInterval(pollOrders, 5000);

const token = process.env.DRIVER_BOT_TOKEN;
if(!token){ console.error("DRIVER_BOT_TOKEN yoxdur"); process.exit(1); }
const bot = new Telegraf(token);

const state = new Map(); // chatId -> {online, name, car, lastOrderId}

function mainKeyboard(){
  return Markup.keyboard([
    ["🟢 Onlayn ol","🔴 Oflayn ol"],
    ["📍 Yer göndər"],
    ["ℹ️ Qəbul: /accept ID"]
  ]).resize();
}

bot.start((ctx)=>{
  if(!state.has(ctx.chat.id)) state.set(ctx.chat.id,{online:false,name:ctx.from.first_name||"",car:"Toyota Aqua"});
  onlineDrivers.add(String(ctx.chat.id));
  registerDriver(ctx).catch(()=>{});
  ctx.reply("Sürücü paneli 🚕", mainKeyboard());
});

bot.hears("🟢 Onlayn ol",(ctx)=>{
  const st=state.get(ctx.chat.id)||{};
  st.online=true; state.set(ctx.chat.id,st);
  onlineDrivers.add(String(ctx.chat.id));
  registerDriver(ctx).catch(()=>{});
  ctx.reply("Onlayn ✅ İndi location göndər: '📍 Yer göndər'", mainKeyboard());
});

bot.hears("🔴 Oflayn ol",(ctx)=>{
  const st=state.get(ctx.chat.id)||{};
  st.online=false; state.set(ctx.chat.id,st);
  onlineDrivers.delete(String(ctx.chat.id));
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

// Inline buttons support (used by automatic order notifications)
bot.action(/^(acc|arr|done):(.*)$/, async (ctx)=>{
  const action = ctx.match[1];
  const orderId = (ctx.match[2]||'').trim();
  if(!orderId) return ctx.answerCbQuery('Order yoxdur');
  const st=state.get(ctx.chat.id)||{car:"Toyota Aqua"};

  try{
    if(action==='acc'){
      const j=await post(`/api/order/${orderId}/accept`,{driverId:String(ctx.chat.id),name:st.name||ctx.from.first_name||"",car:st.car||"Car"});
      await ctx.answerCbQuery(j.ok ? 'Qəbul edildi' : 'Xəta');
      if(j.ok){
        st.lastOrderId=orderId; state.set(ctx.chat.id,st);
        await ctx.reply(`✅ Qəbul edildi #${orderId}`);
      }
    }
    if(action==='arr'){
      await post(`/api/order/${orderId}/status`,{status:"ARRIVED"});
      await ctx.answerCbQuery('Çatdı');
      await ctx.reply(`📍 Çatdı #${orderId}`);
    }
    if(action==='done'){
      await post(`/api/order/${orderId}/status`,{status:"DONE"});
      await ctx.answerCbQuery('Bitdi');
      await ctx.reply(`🏁 Bitdi #${orderId}`);
    }
  }catch(e){
    try{ await ctx.answerCbQuery('Xəta'); }catch(_e){}
  }
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
