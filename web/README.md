# concierge-web

Веб-микросервис для приёма заявок с двух сайтов:
- **veloce.team** → `POST /api/lead` (source=`veloce_site`, SOURCE_ID=`VELOCE_SITE`).
- **maxbot-pro.ru** (max-microsite, master_source — vault `06-projects/max-microsite/`) → `POST /api/lead/maxbot` (source=`maxbot_pro`, SOURCE_ID=`MAXBOT_PRO`).

Сегрегация route'ов через `expectedSource` в `createLeadHandler` — payload на «не свой» route отбивается 400 'unexpected source for this route'.

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

- `POST /api/lead` — приём заявки c veloce.team (JSON, см. `src/schema/lead.ts`).
- `POST /api/lead/maxbot` — приём заявки c maxbot-pro.ru (та же schema +
  опциональные `landing`/`intent`/`product` для контекста гос-посадочной).
- `GET /health` — статус + uptime.

## Доставка в Б24

Через входящий webhook (`BITRIX24_WEBHOOK_URL`):
1. `crm.contact.add` — Контакт с EMAIL + PHONE + SOURCE_ID (`VELOCE_SITE`/`MAXBOT_PRO`).
2. `crm.deal.add` — Сделка с CONTACT_ID + UF_CRM_CHANNEL + SOURCE_ID + TITLE/COMMENTS,
   сформированными через `services/crm/format.ts` (лейбл сайта в TITLE, для
   `maxbot_pro` в COMMENTS — структурный префикс с лейблами Сайт/Лендинг/Запрос/Интерес).

При сбое — запись падает в SQLite outbox, фоновый воркер досылает с экспоненциальным backoff
(5s → 30s → 2m → 10m → 1h → 6h → 24h, 7 попыток).
