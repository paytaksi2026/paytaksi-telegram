# Render quick setup

## Backend (Web Service)
- Root Directory: backend
- Build Command: npm i
- Start Command: npm start
- Env Vars:
  - PUBLIC_BASE_URL = Render URL
  - PRICE_PER_KM, BASE_FEE
  - CORS_ORIGINS = * (test) və ya web host url

## Bots (Background Worker)
Hər bot üçün ayrı worker:
- Root Directory: bots
- Build: npm i
- Start:
  - passenger: npm run start:passenger
  - driver: npm run start:driver
  - admin: npm run start:admin
- Env:
  - BACKEND_URL = backend render url
  - token-lər
  - WEBAPP_URL = passenger.html host linki (HTTPS)
