# concierge-web

Веб-микросервис для приёма заявок с сайта veloce.team на `POST /api/lead`.

Stand-alone: Node 20 + TypeScript ESM + Hono + Zod + better-sqlite3 + pino. Деплоится в Moscow VPS, проксируется через Caddy на `api.veloce.team`.

## Локальная разработка

```bash
cp .env.example .env
# заполнить BITRIX24_WEBHOOK_URL (значение из bot/.env)
npm install
npm run dev
```

## Тесты

```bash
npm test
npm run typecheck
```

## Эндпоинты

- `POST /api/lead` — приём заявки (JSON, см. `src/schema/lead.ts`).
- `GET /health` — статус + uptime.

## Доставка в Б24

Через входящий webhook (`BITRIX24_WEBHOOK_URL`):
1. `crm.contact.add` — Контакт с EMAIL + PHONE + SOURCE_ID=VELOCE_SITE.
2. `crm.deal.add` — Сделка с CONTACT_ID + UF_CRM_CHANNEL + SOURCE_ID=VELOCE_SITE.

При сбое — запись падает в SQLite outbox, фоновый воркер досылает с экспоненциальным backoff
(5s → 30s → 2m → 10m → 1h → 6h → 24h, 7 попыток).
