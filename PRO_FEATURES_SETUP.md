# Pro Features Setup (Admin Auth + Cloudinary + Rejection + Performance + Stripe)

## 1) Admin Auth
Set in Render ENV:
- ADMIN_KEY=your_secret_key

Admin WebApp:
- click "Admin Key" button and paste the same key (stored in localStorage)
Admin API requires header:
- x-admin-key: <ADMIN_KEY>

## 2) Cloudinary Upload (real file storage)
ENV:
- CLOUDINARY_CLOUD_NAME=...
- CLOUDINARY_API_KEY=...
- CLOUDINARY_API_SECRET=...

Driver WebApp uploads images directly to Cloudinary using signed params from:
- POST /api/upload/sign

## 3) Driver Rejection Reason
Admin can Reject with a reason (stored in DB):
- POST /api/admin/driver/reject { driverId, reason }

Driver sees:
- GET /api/driver/status/:id -> { status, rejectedReason }

## 4) Driver Performance
(Next step) Add endpoints that compute trips/rating/acceptance from DB.
This build adds DB fields and foundation; performance endpoints can be extended.

## 5) Stripe (real payments)
ENV:
- STRIPE_SECRET_KEY=sk_live_or_test...
- STRIPE_CURRENCY=azn (optional)
Optional webhook:
- STRIPE_WEBHOOK_SECRET=whsec_...

Passenger Pay button:
- calls POST /api/pay/checkout and opens returned Checkout URL.
