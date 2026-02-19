RENDER-də BOTLAR NIYƏ CAVAB VERMİR?

1) Botlar backend web-service ilə bir yerdə avtomatik başlamır.
   Botlar üçün ayrıca "Background Worker" açmaq lazımdır.

2) Hər bot üçün yalnız 1 polling instance ola bilər.
   Əgər bot səndə kompüterdə də işləyirsə, Render-də cavab verməz.

BU PATCH NƏ EDİR?
- bots/index.js əlavə edir: 3 botu bir processdə başladır.
- bots/package.json-a "start" scripti əlavə edir.

RENDER QURULUMU (tövsiyə):
- New -> Background Worker
- Root Directory: bots
- Build Command: npm install
- Start Command: npm start
- Environment Variables:
  PASSENGER_BOT_TOKEN=...
  DRIVER_BOT_TOKEN=...
  ADMIN_BOT_TOKEN=...
  BACKEND_URL=https://paytaksi-telegram-....onrender.com
  WEBAPP_URL=https://SENIN_HOSTUN/web/passenger.html  (HTTPS olmalıdır)

Sonra Telegramda hər 3 bota /start yaz.
