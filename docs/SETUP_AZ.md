# PayTaksi (Telegram Mini App) — Render + GitHub Qurulum

Bu paket: **Live map + Live location (3 saniyə)** + 3 bot (Passenger/Driver/Admin) + Admin panel.

## 1) GitHub
- New repo aç
- ZIP-i açıb içindəkiləri repo-ya yüklə (commit/push)

## 2) Postgres (Supabase pulsuz)
- Supabase-də project aç
- Connection string götür (`DATABASE_URL`)

## 3) Render Deploy
Render → New → Web Service → repo seç

Environment:
- DATABASE_URL = (Supabase)
- PUBLIC_BASE_URL = https://SENIN-SERVICE.onrender.com
- PASSENGER_BOT_TOKEN = ...
- DRIVER_BOT_TOKEN = ...
- ADMIN_BOT_TOKEN = ...
- ADMIN_TG_IDS = sənin telegram id (məs: 123456789)
- RUN_MIGRATIONS = 1 (ilk dəfə)

Deploy bitəndən sonra RUN_MIGRATIONS=0 et.

## 4) Webhook qur (409 bitir)
PASSENGER:
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SENIN-SERVICE.onrender.com/tg/passenger
DRIVER:
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SENIN-SERVICE.onrender.com/tg/driver
ADMIN:
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SENIN-SERVICE.onrender.com/tg/admin

## 5) BotFather Menu Button (app kimi açılsın)
Hər botda BotFather → Menu Button URL:
https://SENIN-SERVICE.onrender.com

Sonra botda /open yazıb da appı aça bilərsən.
