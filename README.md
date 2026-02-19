# PayTaksi Telegram (FULL working starter)

Bu paket Render + GitHub üçün hazır, işlək bir bazadır:
- backend (Express + WebSocket) -> Render Web Service
- 3 bot (Telegraf): passenger / driver / admin -> Render Background Worker (və ya VPS)
- web mini-app (Leaflet/OSM) -> GitHub Pages / Netlify / Render Static

## Qısa qurulum
1) BotFather ilə 3 bot yaradın və tokenləri götürün.
2) `backend/.env.example` və `bots/.env.example` fayllarını `.env` edin və dəyərləri yazın.
3) Backend:
   - `cd backend && npm i && npm start`
4) Bots:
   - `cd bots && npm i`
   - `npm run start:passenger`
   - `npm run start:driver`
   - `npm run start:admin`
5) Web miniapp:
   - `web/passenger.html` faylını host edin (HTTPS olmalıdır)
   - `WEBAPP_URL` olaraq həmin linki yazın.

## Render
- backend service: Root Directory = `backend`, Start Command = `npm start`
- bots service (worker): Root Directory = `bots`, Start Command = məsələn `npm run start:driver` (hər bot üçün ayrı worker tövsiyə olunur)

Əsas Render problemi (PORT) bu bazada həll edilib: server `process.env.PORT` ilə açılır.
