# Quick Deploy (Render + 3 bot)

## Niyə səndə `package.json` tapılmır?
Render **repo root**-dan `npm start` işlədir. Əgər root-da `package.json` yoxdursa, `ENOENT ... /package.json` xətası çıxır.

Bu paketdə artıq **root package.json** var və `npm start` həm **backend**, həm də **bots** proseslərini paralel qaldırır.

## Render-də necə qurulur?
1) GitHub repo-nu Render-ə bağla (**Web Service**).
2) Build Command: `npm install`
3) Start Command: `npm start`
4) Environment variables:
   - `PASSENGER_BOT_TOKEN`
   - `DRIVER_BOT_TOKEN`
   - `ADMIN_BOT_TOKEN`
   - `ADMIN_PASSWORD`
   - `DATABASE_URL` (Render Postgres-dan gələn)
   - `PUBLIC_BASE_URL` = sənin render domenin

## URL-lər
- Passenger Mini App: `https://<domain>/passenger`
- Driver Mini App: `https://<domain>/driver`
- Admin Panel (web): `https://<domain>/admin`

