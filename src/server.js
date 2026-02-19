require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { Telegraf } = require('telegraf');
const { q } = require('./db');

// --- schema helpers (cached) ---
const __colCache = new Map();
async function userHasColumn(col){
  const key = 'users.'+col;
  if(__colCache.has(key)) return __colCache.get(key);
  try{
    const r = await q(
      `SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name=$1 LIMIT 1`,
      [col]
    );
    const ok = (r.rowCount||0) > 0;
    __colCache.set(key, ok);
    return ok;
  }catch(e){
    __colCache.set(key, false);
    return false;
  }
}

async function upsertUser({id, role, first_name, last_name, phone}){
  const hasTgId = await userHasColumn('tg_id');
  if(hasTgId){
    await q(
      `INSERT INTO users (id, tg_id, role, first_name, last_name, phone)
       VALUES ($1,$1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         tg_id=EXCLUDED.tg_id,
         role=EXCLUDED.role,
         first_name=EXCLUDED.first_name,
         last_name=EXCLUDED.last_name,
         phone=EXCLUDED.phone`,
      [id, role, first_name, last_name, phone]
    );
  }else{
    await upsertUser({id, role:'passenger', first_name, last_name, phone});

    }
}
const { runMigrations } = require('./migrate');

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const ADMIN_TG_IDS = (process.env.ADMIN_TG_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('tiny'));
app.use(express.json({ limit: '5mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/p', (_, res)=> res.sendFile(path.join(__dirname,'public','passenger.html')));
app.get('/d', (_, res)=> res.sendFile(path.join(__dirname,'public','driver.html')));
app.get('/a', (_, res)=> res.sendFile(path.join(__dirname,'public','admin.html')));

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

function isAdminId(tgId){ return ADMIN_TG_IDS.includes(String(tgId)); }

// pricing
function haversineKm(a,b){
  const toRad = (d)=> d*Math.PI/180, R=6371;
  const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  const c = 2*Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
  return R*c;
}
function priceFromKm(km){
  const base=3.50;
  if(!km || km<=3) return base;
  return base + (km-3)*0.40;
}
app.post('/api/pricing/estimate', (req,res)=>{
  const { pickup, drop } = req.body || {};
  if(!pickup||!drop) return res.json({ok:false,error:'pickup/drop missing'});
  const distKm = haversineKm(pickup, drop);
  const price = priceFromKm(distKm);
  res.json({ok:true, distance_km: distKm, price_azn: Number(price.toFixed(2))});
});

// users
app.post('/api/users/upsert', async (req,res)=>{
  try{
    const { id, role, first_name, last_name, phone } = req.body || {};
    if(!id || !role) return res.json({ok:false,error:'id/role missing'});
    await upsertUser({id, role:'passenger', first_name, last_name, phone});

    if(role==='driver'){
      await q(`INSERT INTO drivers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [id]);
    }
    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

app.get('/api/user/me', async (req,res)=>{
  try{
    const id = req.query.id;
    if(!id) return res.json({ok:false,error:'id missing'});
    const r = await q(`SELECT id, role, first_name, last_name, phone FROM users WHERE id=$1`, [id]);
    if(!r.rowCount) return res.json({ok:true, phone:null});
    res.json({ok:true, ...r.rows[0]});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

app.post('/api/passenger/register', async (req,res)=>{
  try{
    const { id, first_name, last_name, phone } = req.body || {};
    if(!id||!first_name||!last_name||!phone) return res.json({ok:false,error:'missing'});
    if(!String(phone).startsWith('+994')) return res.json({ok:false,error:'phone must start with +994'});

    await upsertUser({id, role:'passenger', first_name, last_name, phone});

    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

// driver
app.get('/api/driver/me', async (req,res)=>{
  try{
    const driver_id = req.query.driver_id;
    if(!driver_id) return res.json({ok:false,error:'driver_id missing'});
    const r = await q(`SELECT d.*, u.phone FROM drivers d JOIN users u ON u.id=d.user_id WHERE d.user_id=$1`, [driver_id]);
    if(!r.rowCount) return res.json({ok:false,error:'driver not found'});
    const d=r.rows[0];
    const blocked = Number(d.balance) <= -15;
    res.json({ok:true, status:d.status, balance:d.balance, blocked,
      block_reason: blocked ? 'Balans -15 AZN-dən aşağıdır. Topup edin.' : null,
      phone:d.phone, car_make:d.car_make, car_model:d.car_model, plate:d.plate});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

app.post('/api/driver/register', async (req,res)=>{
  try{
    const { id, first_name, last_name, phone, car_make, car_model, plate } = req.body || {};
    if(!id||!first_name||!last_name||!phone||!car_make||!car_model||!plate) return res.json({ok:false,error:'missing'});
    if(!String(phone).startsWith('+994')) return res.json({ok:false,error:'phone must start with +994'});

    // IMPORTANT: upsert into users first, so drivers.user_id foreign key is always valid
    await upsertUser({id, role:'driver', first_name, last_name, phone});

    await q(`UPDATE drivers SET car_make=$2,car_model=$3,plate=$4,status='pending' WHERE user_id=$1`, [id, car_make, car_model, plate]);

    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

app.post('/api/driver/set_online', async (req,res)=>{
  try{
    const { driver_id, is_online } = req.body || {};
    const r = await q(`UPDATE drivers SET is_online=$2, last_seen=now() WHERE user_id=$1 RETURNING balance,status,is_online`, [driver_id, !!is_online]);
    if(!r.rowCount) return res.json({ok:false,error:'driver not found'});
    const d=r.rows[0];
    const blocked = Number(d.balance) <= -15;
    res.json({ok:true, balance:d.balance, status:d.status, is_online:d.is_online, blocked, block_reason: blocked ? 'Balans -15 AZN-dən aşağıdır. Topup edin.' : null});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

// multipart helper
function parseMultipart(req){
  return new Promise((resolve, reject)=>{
    const ct = req.headers['content-type'] || '';
    if(!ct.includes('multipart/form-data')) return reject(new Error('multipart required'));
    const boundary = '--' + ct.split('boundary=')[1];
    let buf = Buffer.alloc(0);
    req.on('data', (c)=> buf = Buffer.concat([buf,c]));
    req.on('end', ()=>{
      try{
        const parts = buf.toString('binary').split(boundary).slice(1,-1);
        const fields={}; let file=null;
        for(const part of parts){
          const p = part.replace(/^\r\n/,'').replace(/\r\n$/,'');
          const [rawH, rawB] = p.split('\r\n\r\n');
          const cd = (rawH.split('\r\n').find(h=>h.toLowerCase().startsWith('content-disposition'))||'');
          const nameMatch=/name="([^"]+)"/.exec(cd); if(!nameMatch) continue;
          const name=nameMatch[1];
          const fnMatch=/filename="([^"]*)"/.exec(cd);
          if(fnMatch && fnMatch[1]){
            const bodyBuf=Buffer.from(rawB,'binary').slice(0,-2);
            file={name, filename: fnMatch[1], bytes: bodyBuf};
          } else fields[name]=rawB.replace(/\r\n$/,'');
        }
        resolve({fields,file});
      }catch(e){ reject(e); }
    });
  });
}

app.post('/api/driver/docs/upload', async (req,res)=>{
  try{
    const { fields, file } = await parseMultipart(req);
    const driver_id = fields.driver_id;
    const doc_type = fields.doc_type;
    if(!driver_id || !doc_type || !file) return res.json({ok:false,error:'driver_id/doc_type/file required'});
    const safe = `doc_${driver_id}_${doc_type}_${Date.now()}_${file.filename.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, safe), file.bytes);
    const fileUrl = `${PUBLIC_BASE_URL}/uploads/${safe}`;
    await q(`INSERT INTO driver_documents (driver_id, doc_type, file_url) VALUES ($1,$2,$3)`, [driver_id, doc_type, fileUrl]);
    res.json({ok:true, url:fileUrl});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

// trips
app.post('/api/trips/create', async (req,res)=>{
  try{
    const { passenger_id, pickup, drop } = req.body || {};
    if(!passenger_id || !pickup || !drop) return res.json({ok:false,error:'missing fields'});
    const me = await q(`SELECT phone FROM users WHERE id=$1`, [passenger_id]);
    if(!me.rowCount || !me.rows[0].phone) return res.json({ok:false,error:'Passenger qeydiyyatı yoxdur (telefon).'});
    const trip_id = uuidv4();
    const distKm = haversineKm(pickup, drop);
    const price = priceFromKm(distKm);
    await q(
      `INSERT INTO trips (id, passenger_id, pickup_lat,pickup_lng,drop_lat,drop_lng,distance_km,price_azn,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'searching')`,
      [trip_id, passenger_id, pickup.lat, pickup.lng, drop.lat, drop.lng, distKm, Number(price.toFixed(2))]
    );
    io.emit('trip:request', { trip_id, passenger_id, pickup, drop });
    res.json({ok:true, trip_id});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

app.post('/api/trips/accept', async (req,res)=>{
  try{
    const { trip_id, driver_id } = req.body || {};
    const d = await q(`SELECT balance,status,car_make,car_model,plate FROM drivers WHERE user_id=$1`, [driver_id]);
    if(!d.rowCount) return res.json({ok:false,error:'driver not found'});
    if(!d.rows[0].car_make || !d.rows[0].car_model || !d.rows[0].plate) return res.json({ok:false,error:'Driver qeydiyyatı tamam deyil.'});
    if(d.rows[0].status!=='approved') return res.json({ok:false,error:'Sürücü pending-dir. Admin təsdiqləməlidir.'});
    if(Number(d.rows[0].balance) <= -15) return res.json({ok:false,error:'Balans -15 AZN-dən aşağıdır. Sifariş qəbul edilmir.'});
    const r = await q(
      `UPDATE trips SET driver_id=$2, status='assigned', accepted_at=now()
       WHERE id=$1 AND status='searching'
       RETURNING passenger_id`,
      [trip_id, driver_id]
    );
    if(!r.rowCount) return res.json({ok:false,error:'Trip artıq götürülüb və ya yoxdur.'});
    io.to('trip:'+trip_id).emit('trip:assigned', { trip_id, driver_id, passenger_id: r.rows[0].passenger_id });
    io.to('trip:'+trip_id).emit('trip:status:update', { trip_id, status:'assigned' });
    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

app.post('/api/trips/status', async (req,res)=>{
  try{
    const { trip_id, driver_id, status } = req.body || {};
    const allowed = ['arrived','in_trip','arriving'];
    if(!allowed.includes(status)) return res.json({ok:false,error:'bad status'});
    const r = await q(`UPDATE trips SET status=$3,
      started_at = CASE WHEN $3='in_trip' THEN now() ELSE started_at END
      WHERE id=$1 AND driver_id=$2 RETURNING id`, [trip_id, driver_id, status]);
    if(!r.rowCount) return res.json({ok:false,error:'trip not found'});
    io.to('trip:'+trip_id).emit('trip:status:update', { trip_id, status });
    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

app.post('/api/trips/finish', async (req,res)=>{
  try{
    const { trip_id, driver_id } = req.body || {};
    const t = await q(`SELECT price_azn FROM trips WHERE id=$1 AND driver_id=$2`, [trip_id, driver_id]);
    if(!t.rowCount) return res.json({ok:false,error:'trip not found'});
    const price = Number(t.rows[0].price_azn || 0);
    const commission = Number((price * 0.10).toFixed(2));
    await q(`UPDATE trips SET status='finished', finished_at=now() WHERE id=$1 AND driver_id=$2`, [trip_id, driver_id]);
    const d = await q(`UPDATE drivers SET balance = balance - $2 WHERE user_id=$1 RETURNING balance`, [driver_id, commission]);
    const bal = d.rowCount ? Number(d.rows[0].balance) : null;
    const blocked = bal!=null && bal <= -15;
    io.emit('driver:balance:update', { driver_id, balance: bal, blocked, block_reason: blocked ? 'Balans -15 AZN-dən aşağıdır. Topup edin.' : null });
    io.to('trip:'+trip_id).emit('trip:status:update', { trip_id, status:'finished' });
    res.json({ok:true, price_azn: price, commission, driver_balance: bal});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

app.post('/api/trips/cancel', async (req,res)=>{
  try{
    const { trip_id } = req.body || {};
    await q(`UPDATE trips SET status='canceled' WHERE id=$1 AND status IN ('searching','assigned','arriving')`, [trip_id]);
    io.to('trip:'+trip_id).emit('trip:status:update', { trip_id, status:'canceled' });
    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

// topup
app.post('/api/topup/create', async (req,res)=>{
  try{
    const { fields, file } = await parseMultipart(req);
    const driver_id = fields.driver_id;
    const amount = Number(fields.amount||0);
    if(!driver_id || !amount || !file) return res.json({ok:false,error:'driver_id/amount/receipt required'});
    const safe = `receipt_${driver_id}_${Date.now()}_${file.filename.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, safe), file.bytes);
    const receiptUrl = `${PUBLIC_BASE_URL}/uploads/${safe}`;
    await q(`INSERT INTO topup_requests (driver_id, amount, receipt_file_url) VALUES ($1,$2,$3)`, [driver_id, amount, receiptUrl]);
    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});

// admin endpoints (unchanged core)
app.get('/api/admin/pending_drivers', async (req,res)=>{
  try{
    if(!isAdminId(req.query.admin_id)) return res.json({ok:false,error:'not admin'});
    const r=await q(`SELECT user_id,status,balance,plate FROM drivers WHERE status='pending' ORDER BY user_id DESC LIMIT 200`);
    res.json({ok:true, items:r.rows});
  }catch(e){ res.json({ok:false,error:e.message}); }
});
app.post('/api/admin/driver_status', async (req,res)=>{
  try{
    const { admin_id, driver_id, status } = req.body||{};
    if(!isAdminId(admin_id)) return res.json({ok:false,error:'not admin'});
    await q(`UPDATE drivers SET status=$2 WHERE user_id=$1`, [driver_id, status]);
    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});
app.get('/api/admin/topups', async (req,res)=>{
  try{
    if(!isAdminId(req.query.admin_id)) return res.json({ok:false,error:'not admin'});
    const r=await q(`SELECT id,driver_id,amount,receipt_file_url,status FROM topup_requests WHERE status='pending' ORDER BY id DESC LIMIT 200`);
    res.json({ok:true, items:r.rows});
  }catch(e){ res.json({ok:false,error:e.message}); }
});
app.post('/api/admin/topup_decide', async (req,res)=>{
  try{
    const { admin_id, topup_id, decision } = req.body||{};
    if(!isAdminId(admin_id)) return res.json({ok:false,error:'not admin'});
    const r=await q(`SELECT driver_id,amount,status FROM topup_requests WHERE id=$1`, [topup_id]);
    if(!r.rowCount) return res.json({ok:false,error:'not found'});
    if(r.rows[0].status!=='pending') return res.json({ok:false,error:'already decided'});
    if(decision==='approve'){
      await q(`UPDATE topup_requests SET status='approved', admin_id=$2, decided_at=now() WHERE id=$1`, [topup_id, admin_id]);
      const d=await q(`UPDATE drivers SET balance=balance+$2 WHERE user_id=$1 RETURNING balance`, [r.rows[0].driver_id, r.rows[0].amount]);
      const bal=Number(d.rows[0].balance);
      const blocked = bal<=-15;
      io.emit('driver:balance:update', { driver_id:r.rows[0].driver_id, balance: bal, blocked, block_reason: blocked?'Balans -15 AZN-dən aşağıdır. Topup edin.':null });
    } else {
      await q(`UPDATE topup_requests SET status='rejected', admin_id=$2, decided_at=now() WHERE id=$1`, [topup_id, admin_id]);
    }
    res.json({ok:true});
  }catch(e){ res.json({ok:false,error:e.message}); }
});


// geocode (OpenStreetMap Nominatim) - free
app.get('/api/geocode/search', async (req,res)=>{
  try{
    const qtext = String(req.query.q||'').trim();
    if(!qtext) return res.json({ok:true, items:[]});
    // Respect Nominatim usage policy: identify app
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=' + encodeURIComponent(qtext);
    const r = await fetch(url, { headers: { 'User-Agent': 'PayTaksiTelegram/1.0', 'Accept-Language': 'az,en' }});
    if(!r.ok) return res.json({ok:false,error:'geocode failed'});
    const data = await r.json();
    const items = (data||[]).map(x=>({
      display: x.display_name,
      lat: Number(x.lat),
      lng: Number(x.lon)
    }));
    res.json({ok:true, items});
  }catch(e){
    res.json({ok:false,error:e.message});
  }
});

// socket
const server=http.createServer(app);
const io=new Server(server, { cors:{origin:'*'} });

io.on('connection', (socket)=>{
  socket.on('passenger:join_trip', ({trip_id})=>{ if(trip_id) socket.join('trip:'+trip_id); });
  socket.on('admin:join', ()=> socket.join('admins'));
  socket.on('driver:location', async (p)=>{
    try{
      const { driver_id, lat, lng, speed, heading, trip_id } = p||{};
      if(!driver_id || typeof lat!=='number' || typeof lng!=='number') return;
      await q(`INSERT INTO driver_locations (driver_id,lat,lng,speed,heading) VALUES ($1,$2,$3,$4,$5)`, [driver_id,lat,lng,speed||null,heading||null]);
      io.to('admins').emit('admin:driver_location', {driver_id, lat, lng});
      if(trip_id) io.to('trip:'+trip_id).emit('driver:location:update', {trip_id, driver_id, lat, lng});
    }catch(e){}
  });
});

// bots
function createBot(token, kind, webPath){
  if(!token) return null;
  const bot=new Telegraf(token);
  bot.start((ctx)=> ctx.reply(`PayTaksi • ${kind}\n/open yaz və appı aç.`));
  bot.command('open', (ctx)=> ctx.reply('PayTaksi aç', {reply_markup:{inline_keyboard:[[{text:'Open PayTaksi', web_app:{url: PUBLIC_BASE_URL + webPath}}]]}}));
  bot.command('id', (ctx)=> ctx.reply('Sənin ID: '+ctx.from.id));
  return bot;
}
const passengerBot=createBot(process.env.PASSENGER_BOT_TOKEN,'Passenger','/p');
const driverBot=createBot(process.env.DRIVER_BOT_TOKEN,'Driver','/d');
const adminBot=createBot(process.env.ADMIN_BOT_TOKEN,'Admin','/a');

app.post('/tg/passenger', (req,res)=> passengerBot ? passengerBot.handleUpdate(req.body, res) : res.sendStatus(404));
app.post('/tg/driver', (req,res)=> driverBot ? driverBot.handleUpdate(req.body, res) : res.sendStatus(404));
app.post('/tg/admin', (req,res)=> adminBot ? adminBot.handleUpdate(req.body, res) : res.sendStatus(404));

async function boot(){
  if(process.env.RUN_MIGRATIONS==='1'){
    console.log('Running migrations...');
    await runMigrations();
    console.log('Migrations OK.');
  }
  server.listen(PORT, ()=> console.log('PayTaksi running:', PUBLIC_BASE_URL));
}
boot().catch(e=>{ console.error(e); process.exit(1); });
