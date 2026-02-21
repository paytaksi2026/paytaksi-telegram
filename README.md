# PayTaksi v2 Enterprise (3 Bot) — Render Ready

Bu paket **3 ayrı Telegram bot** + **1 backend** + **3 Mini App** (Passenger/Driver/Admin) ilə işləyən enterprise skeletidir.

## Nələr var?
- ✅ **3 bot**: Passenger (`PAYTAKSI_PASSENGER_BOT_TOKEN`), Driver (`PAYTAKSI_DRIVER_BOT_TOKEN`), Admin (`PAYTAKSI_ADMIN_BOT_TOKEN`)
- ✅ **PostgreSQL** (Render Postgres ilə)
- ✅ Mini App UI: **/passenger**, **/driver**, **/admin** (tək domain üzərində)
- ✅ Qeydiyyat:
  - Passenger: Ad Soyad + Telefon (contact)
  - Driver: geniş qeydiyyat (avto məlumatları + status **PENDING**) → Admin təsdiq etmədən online ola bilməz
- ✅ Sifariş axını: quote (OSRM) → create → driver-ə düşür → accept → statuslar
- ✅ Real-time: WS per-order channels (order otaqları)
- ✅ Log sistemi + connection indicator

> Qeyd: Selfie/OCR/Fraud modulları **skelet** kimi var (sonradan Cloudinary/S3 + OCR provider əlavə olunur).

---

## Render-də quruluş (1 Web Service + 1 PostgreSQL)
1) GitHub-a bu repo-nu yüklə
2) Render → New → **Blueprint** (render.yaml var)
3) Deploy bitəndə **WEB BASE URL** belə olacaq: `https://<app>.onrender.com`

### Render ENV (Web service)
Aşağıdakı ENV-ləri əlavə et:
- `PAYTAKSI_PASSENGER_BOT_TOKEN` = BotFather token
- `PAYTAKSI_DRIVER_BOT_TOKEN` = BotFather token
- `PAYTAKSI_ADMIN_BOT_TOKEN` = BotFather token
- `ADMIN_EMAIL` = admin email
- `ADMIN_PASSWORD` = admin parol
- `OSRM_BASE_URL` = `https://router.project-osrm.org`  (default)

Postgres avtomatik render.yaml ilə bağlanır.

---

## BotFather: Mini App necə açılır? (səndə “Mini Apps” menyusu görünməyə bilər)
Telegram-da bu **komandalar** həmişə işləyir:

### 1) Domain (hər bot üçün)
BotFather-da yaz:
- `/setdomain` → bot seç → **domain** yaz

Domain nümunə:
- `paytaksi-telegram-wlig.onrender.com`

> Burada **https:// yazmırsan**, yalnız domain.

### 2) Menu Button (hər bot üçün)
BotFather-da yaz:
- `/setmenubutton` → bot seç → `Web App`

**Passenger bot URL:**
- `https://paytaksi-telegram-wlig.onrender.com/passenger`

**Driver bot URL:**
- `https://paytaksi-telegram-wlig.onrender.com/driver`

**Admin bot URL:**
- `https://paytaksi-telegram-wlig.onrender.com/admin`

Button title: istədiyin (məs: “PayTaksi”, “Sürücü Paneli”, “Admin Paneli”).

---

## Lokal işə salmaq
```bash
cp backend/.env.example backend/.env
# .env içində tokenləri doldur
npm install
npm run start
```

---

## Qısa istifadə
- Passenger bot: `/start` → qeydiyyat → miniapp-dan sifariş
- Driver bot: `/start` → qeydiyyat → Admin təsdiqi → `/online`
- Admin bot: `/start` → `/pending` → `/approve <id>` və ya `/reject <id> <sebeb>`

