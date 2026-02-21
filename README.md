# PayTaksi — Telegram Mini App (MVP / 0 AZN)

Bu paket 1 bot + Mini App + API + Admin panel skeleton-dur.

## Nə var?
- `/app/` → Mini App (müştəri + sürücü)
- `/admin/` → Admin panel (yalnız sürücü təsdiqi)
- `/api/*` → Backend API
- `/ws` → WebSocket (order:new / order:accepted / order:status / driver:approval)

## Lokal start

### 1) API
```bash
cd apps/api
cp .env.example .env
npm install
npm start
```

Sonra aç:
- Mini App: http://localhost:3000/app/
- Admin: http://localhost:3000/admin/

### 2) Bot (istəyə bağlı)
```bash
cd apps/bot
cp .env.example .env
# .env içində BOT_TOKEN və WEBAPP_URL yaz
npm install
npm start
```

## Deploy (qısa)
- Render / VPS-də `apps/api` qovluğunu web service kimi qaldır.
- `JWT_SECRET` və `ADMIN_JWT_SECRET` mütləq yaz.
- Domen HTTPS olmalıdır (Telegram Mini App üçün).

## Qeyd
- Xəritə: MapLibre demo style istifadə edir. Sonra öz OSM tile/style-ınla dəyişə bilərsən.
- Nominatim public limitlidir: debounce+cache var, amma çox trafikli layihədə öz geocoding lazımdır.
