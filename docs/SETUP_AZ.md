# PayTaksi Telegram Mini App (3 bot + web app) — Qurulum (AZ)

Bu paket **Telegram Mini App (WebApp)** kimi işləyən taksi sistemi üçün **tam sıfırdan start layihəsidir**:
- **3 ayrı bot:** Sərnişin, Sürücü, Admin
- **Web App:** xəritə, sifariş yaratma, sürücüyə təklif, qəbul, statuslar, admin topup təsdiqi
- **Hesablama:** 3.50 AZN + 3 km-dən sonra hər 1 km = 0.40 AZN
- **Komissiya:** sürücü hər gedişdə 10% komissiya (gediş bitəndə sürücü balansından çıxılır)
- **Balans blok:** sürücü balansı **-15 AZN və ya aşağı** olduqda sifariş qəbul edilmir və səbəb göstərilir
- **Balans artırma:** sürücü qəbz fotosu göndərir (Telegram file_id kimi DB-də saxlanır), admin approve edəndə balans artır

> Qeyd: Xəritə **OpenStreetMap + Leaflet** (pulsuz). Marşrut məsafəsi üçün **OSRM public server** istifadə olunur (pulsuz, amma limit ola bilər). İstəsəniz sonra ORS/Mapbox kimi alternativlərə keçə bilərsiniz.

---

## 1) GitHub repo yarat
1. GitHub → **New repository**
2. Bu layihənin fayllarını repo-ya yüklə (zip-i aç, hamısını push et)

---

## 2) Database — pulsuz (Supabase tövsiyə)
Render-in pulsuz planında disk/DB stabilliyi problem ola bilər. Ona görə **Supabase Free Postgres** daha yaxşıdır.

1. Supabase → New project
2. **Database URL** götür (Postgres connection string)
3. Bu URL-ni Render environment variables-a qoyacağıq: `DATABASE_URL`

---

## 3) Render-də deploy (pulsuz)
1. Render → **New +** → **Web Service**
2. GitHub repo seç
3. Build & Start:
   - Build: `npm install`
   - Start: `npm start`
4. Environment Variables (Render → Environment):
   - `PASSENGER_BOT_TOKEN` = (BotFather-dən)
   - `DRIVER_BOT_TOKEN` = (BotFather-dən)
   - `ADMIN_BOT_TOKEN` = (BotFather-dən)
   - `PUBLIC_BASE_URL` = Render URL (məs: `https://paytaksi.onrender.com`)
   - `DATABASE_URL` = Supabase connection string
   - İstəyə görə pricing env-lər (defaultlar var)

Deploy bitəndən sonra **PUBLIC_BASE_URL** artıq dəqiq olacaq.

---

## 4) BotFather — 3 bot yaratma
Telegram-da @BotFather:

### A) Sərnişin bot
- `/newbot`
- Ad: `PayTaksi Sifariş Ver`
- Username: məsələn `PayTaksiPassenger_bot`
- Tokeni götür → `PASSENGER_BOT_TOKEN`

### B) Sürücü bot
- `/newbot`
- Ad: `PayTaksi Sürücü Ol`
- Username: məsələn `PayTaksiDriver_bot`
- Tokeni götür → `DRIVER_BOT_TOKEN`

### C) Admin bot
- `/newbot`
- Ad: `PayTaksi Admin`
- Username: məsələn `PayTaksiAdmin_bot`
- Tokeni götür → `ADMIN_BOT_TOKEN`

### Bot menu / WebApp düyməsi
Bu layihə botun içində düymə göstərir (WebApp düyməsi). Yəni əlavə ayar tələb etmir.

---

## 5) Sürücü qeydiyyatı necə olur?
1. Driver bot → `/start`
2. Bot addım-addım soruşacaq:
   - Ad, Soyad
   - Telefon (contact ilə)
   - Operator
   - Avto marka/model/nömrə
   - Avto şəkli
   - Şəxsiyyət vəsiqəsi (üz/arxa)
   - Sürücülük vəsiqəsi
   - Texniki pasport (üz/arxa)
3. Qeydiyyat **pending** olur.
4. Admin bot → **"Sürücüləri təsdiq et"** → Approve

---

## 6) Balans artırma (qəbz)
1. Driver bot → **"Balans artır"**
2. Məbləğ yaz
3. Metod seç: `card_to_card` / `terminal` / `m10`
4. Qəbz şəkli göndər
5. Admin bot → **"TopUp-lar"** → Approve

---

## 7) Naviqasiya (Waze)
Sürücü panelində **Waze** düyməsi var.
Telefonunuzda Waze quraşdırılıbsa açılır.

---

## 8) “Bolt stili” render barədə
Bu MVP dizaynı sadə “Bolt-a oxşar” tünd UI verir. Sonra eyni bu baza üzərində:
- Daha çox ekranlar
- Real-time xəritədə maşın ikonları
- Zona/surge
- Promo/kupon
- Tam admin panel modulları
əlavə edə bilərik.

---

## Tez yoxlama (checklist)
- [ ] Render deploy oldu
- [ ] PUBLIC_BASE_URL düz yazıldı
- [ ] 3 bot tokeni env-ə qoyuldu
- [ ] Supabase DATABASE_URL işləyir
- [ ] Driver botda qeydiyyat tamamlandı
- [ ] Admin botda sürücü approve edildi
- [ ] Passenger botda web app açılıb sifariş yaradıla bilir

