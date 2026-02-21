# PayTaksi v2 Enterprise (OneBot) — Passenger + Driver + Admin

Bu paket **1 tək Telegram bot** ilə işləyir (Uber/Bolt üslubu):
- **Passenger Mini App**: xəritə, marşrut (OSRM polyline), qiymət/ETA, sifariş, chat
- **Driver Mini App**: online/offline, real-time tracking, sifariş qəbul/status, chat
- **Admin Web Panel**: login, driver approval/reject səbəbi, monetizasiya skeleti

> Qeyd: Cloudinary/S3, real payment gateway, PostgreSQL/Redis bu paketdə **hazır “yer” (placeholder/skelet)** kimi saxlanıb. Sonra açarlar (keys) əlavə edib aktiv edəcəyik.

## Qovluqlar
- `backend/` — Express API + WebSocket (real-time order/channel/log)
- `web/` — Mini App UI (passenger/driver/admin) — premium UI
- `bots/` — **one_bot.js** (tək bot)
- `docs/` — quraşdırma qeydləri

## Render (FREE) quraşdırma
1) GitHub-a yüklə.
2) Render → **New Web Service** → repo seç.
3) Build command: `npm install` (root)
4) Start command: `npm start`
5) Environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `WEBAPP_PASSENGER_URL`, `WEBAPP_DRIVER_URL`, `WEBAPP_ADMIN_URL`

## Lokal işə salma
```bash
npm install
cp .env.example .env
# .env-də TELEGRAM_BOT_TOKEN və URL-ləri yaz
npm start
```

## Telegram bot button / mini app
BotFather-da bu bot üçün:
- `/setdomain` → `https://your-service.onrender.com`
- `/setmenubutton` → URL: `https://your-service.onrender.com/passenger`

Sonra botda `/start` yaz — düymələr çıxacaq.
