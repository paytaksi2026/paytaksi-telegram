# PayTaksi ZERO (Sıfırdan tam paket)

Bu paket: **backend (Node.js + Express + PostgreSQL)** və **web (HTML + JS + Leaflet)**.

## Funksiyalar (MVP, işlək)
- Müştəri qeydiyyat/login
- Sürücü qeydiyyat/login
- Admin login panel (0000 / admin1234)
- Sürücü admin tərəfindən **approve** olunmadan online ola bilmir
- GPS ilə başlanğıc nöqtəni götürür və **ünvan adını** yazır (reverse geocode)
- Ünvan yazanda **alternativlər** çıxır (autocomplete)
- Məsafə + qiymət (Açılış **3.50 AZN**, **0.40 AZN/km**)
- Sifariş yaradılır, sistem ən yaxın online+approved sürücünü tapıb təyin edir
- Sürücü: qəbul et / çatdım / başlat / bitir
- Naviqasiya linkləri (Google Maps)

## 1) DB-ni DBeaver ilə sıfırlamaq

### Variant A (ən rahat): BAZANI TAM SİL və yenidən yarat
1. DBeaver → sol tərəfdə **Databases**
2. Sənin DB bağlantısını seç
3. **SQL Editor** aç
4. Aşağıdakıları çalışdır:

```sql
-- Diqqət: bütün cədvəllər silinəcək!
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
```

5. Sonra `sql/init.sql` faylını aç və **Run** et.

### Variant B: Yalnız bu cədvəlləri sil
```sql
DROP TABLE IF EXISTS ride_events CASCADE;
DROP TABLE IF EXISTS rides CASCADE;
DROP TABLE IF EXISTS driver_locations CASCADE;
DROP TABLE IF EXISTS drivers CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS app_meta CASCADE;
```
Sonra yenə `sql/init.sql` Run.

## 2) Backend run

### Lokal
```bash
cd backend
cp .env.example .env
# .env içində DATABASE_URL və JWT_SECRET doldur
npm install
npm start
```

Backend default: `http://localhost:3000`

## 3) Web run
Sadəcə `web/` qovluğunu hosta at.

Əgər backend başqa domain-dədirsə, web-də bir dəfə console-da bunu yaz:
```js
localStorage.setItem('API_BASE','https://SENIN_BACKEND_DOMAIN');
location.reload();
```

## 4) Admin login
- Phone: **0000**
- Pass: **admin1234**

Admin paneldən sürücüləri approve et.

## Qeyd
Nominatim və OSRM public servislərdir. Çox yükləmə etmə. İstəsən sonra öz servisinə keçirərik.
