# PayTaksi Telegram Bot (Bakı)

Bu ZIP içində minimal işlək Telegram bot var:
- Sifariş axını: pickup -> dropoff -> təsdiq
- Pickup/Dropoff: GPS göndərmək və ya ünvanı yazmaq
- Ünvan yazanda alternativ yerlər (Bakı üçün preset siyahıdan)
- Sifarişlər `data/orders.json` faylına yazılır
- İstəsəniz `ADMIN_CHAT_ID` verərək yeni sifarişləri adminə də göndərə bilərsiniz.

## Quraşdırma
1) Kompüter/VPS-də Node.js 18+ olsun
2) Qovluğu açın və daxil olun:
```bash
cd paytaksi-telegram-bot
npm install
```

3) `.env` yaradın:
- `.env.example` faylını kopyalayın:
```bash
cp .env.example .env
```
- `.env` içində `BOT_TOKEN` yazın (BotFather-dan)

4) İşə salın:
```bash
npm start
```

## Bot komandaları
- /start
- /order
- /cancel

## Deploy
- VPS / Render / Railway kimi Node host olan yerdə işləyir.
- Shared hosting (php-only) adətən Node dəstəkləmir.

## Növbəti mərhələ (istəsəniz)
- Sürücü botu + qəbul/imtina
- Admin panel
- Xəritə API ilə real axtarış (Google Places) — alternativlər real olacaq
