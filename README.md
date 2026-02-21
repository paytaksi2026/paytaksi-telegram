# PayTaksi Telegram MVP (Sürücü + Müştəri + Admin)

Bu paket **işlək MVP skeleti**dir:
- 3 ayrı Telegram bot: **Passenger**, **Driver**, **Admin**
- Müştəri üçün **Telegram Mini App** (xəritə + ünvan axtarışı + sifariş)
- Pulsuz xəritə: **OpenStreetMap + Leaflet**
- Waze naviqator: **deep-link** (telefonunda Waze varsa açılır)
- Chat: sifariş ID ilə (`#45 salam`) – backend mesajı digər tərəfə relay edir.

> Qeyd: Bu MVP real “Bolt” kimi tam deyil, amma əsas axın işləyir: müştəri sifariş verir → sürücüyə düşür → sürücü qəbul edir → tərəflər chat edir.

---

## 1) Nə lazımdır?
- Node.js 18+
- 3 bot token (BotFather):
  - `@PayTaksiPassenger_bot`
  - `@PayTaksiDriver_bot`
  - `@PayTaksiAdmin_bot`
- WebApp HTTPS ünvanı (GitHub Pages / Vercel / Netlify)
- Backend üçün hosting (Render / Railway / VPS)

---

## 2) Lokal işə salmaq

### Backend
```bash
cd backend
npm i
cp ../.env.example .env
# .env içində tokenləri yaz
npm run start
```

### Web (sadə statik server)
```bash
cd web
# istənilən statik server olar
npx http-server -p 8080
```

### Bots
```bash
cd bots
npm i
cp ../.env.example .env
# .env içində tokenləri + BACKEND_URL + WEBAPP_URL yaz
npm run start:passenger
npm run start:driver
npm run start:admin
```

---

## 3) İstifadə

### Müştəri
- Passenger bota gir → `/start` → “📍 Sifariş ver (xəritə)”
- Qarşılama seç (GPS / ünvan)
- Gediləcək ünvan yaz (alternativlər çıxır)
- “✅ Sifariş ver”

### Sürücü
- Driver bota gir → `/start`
- “📍 Yer göndər”
- “🟢 Onlayn ol”
- Sifariş gələndə “✅ Qəbul et”
- Naviqasiya düymələri Waze açır

### Chat
- Hər iki tərəf yazır: `#SIFARIS_ID mesaj`
  - Məs: `#45 salam, 3 dəq sonra çatıram`

---

## 4) Waze inteqrasiyası
Bu MVP Waze-in içində naviqasiyanı **deep-link** ilə açır:
- `waze://?ll=LAT,LON&navigate=yes`

Telegram içində düyməni basanda Waze (quruludursa) açılır.

---

## 5) Növbəti addımlar (sənin istədiyin kimi “tam Bolt”a yaxınlaşdırmaq)
- WebSocket real-time: sürücü canlı hərəkət etsin (müştəri xəritədə görsün)
- “Gedişə başla / Gedişi bitir” status axını (UI + backend)
- Sürücü tətbiqində “avtomatik qəbul” qaydaları
- Admin panel (web) – bütün funksiyalar (sifarişlər, istifadəçilər, qadağa, tariflər)
- Ödəniş sistemləri və balans
- OSRM self-host (dəqiq məsafə və marşrut)

