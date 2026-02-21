# Render.com üçün sadə deploy (backend + bots)

Render free plan dəyişə bilər, amma ümumi ideya:

1) GitHub-a bu repozitoriyanı push edin.
2) Render-də 2 servis yaradın:
   - **Web Service**: `backend` qovluğu
   - **Worker**(lər): `bots` qovluğu (3 worker və ya 1 servisdə 3 process manager)

### Backend Start Command
`npm i && npm start`

### Bots Start Command (ayrı servis üçün)
- Passenger: `npm i && npm run start:passenger`
- Driver: `npm i && npm run start:driver`
- Admin: `npm i && npm run start:admin`

ENV dəyişənləri Render-də əlavə edin (tokenlər, BACKEND_URL, WEBAPP_URL).
