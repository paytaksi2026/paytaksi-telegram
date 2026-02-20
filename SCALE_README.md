# PayTaksi — Scale/Production

## Required ENV (Render)
- DATABASE_URL=postgres://...   (Render Postgres or Neon/Supabase)
- PGSSL=1                      (often needed on managed Postgres)
- REDIS_URL=redis://...        (Upstash/Render Redis)
- REDIS_CHANNEL=PAYTAKSI_EVENTS (optional)
- SENTRY_DSN=...               (optional)
- SENTRY_TRACES_SAMPLE_RATE=0.05 (optional)

## Healthcheck
GET /health

## Notes
- If DATABASE_URL is not set, system continues with in-memory behavior (demo mode).
- Redis Pub/Sub enables horizontal scaling (multi instance) by sharing WS events.
