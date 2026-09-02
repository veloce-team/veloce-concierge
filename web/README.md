# concierge-web

Веб-микросервис для приёма заявок и production offline analytics:
- **veloce.team** → текущий strict `POST /api/lead/v1` (Analytics Contract v1,
  durable `lead_event_id`, успешный ответ только после подтверждения Сделки в CRM).
- `POST /api/lead` сохранён как compatibility route для `source=veloce_site`, но не является
  текущим контрактом публичной формы veloce.team.
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
- `POST /api/lead/v1` — strict Analytics Contract v1 (см. `src/schema/lead-v1.ts`).
  Повтор с тем же `lead_event_id` возвращает сохранённый подтверждённый deal ID;
  временная ошибка CRM возвращает retryable `503` и оставляет запись в outbox.
- `POST /api/lead/maxbot` — приём заявки c maxbot-pro.ru (та же schema +
  опциональные `landing`/`intent`/`product` для контекста гос-посадочной).
- `GET /health` — статус + uptime.
- `GET /ready` — bounded operational readiness без PII/секретов. Возвращает `503` при
  stale/failing analytics workers, retry/dead/unmatchable rows, backlog/quota либо
  semantic/lineage alert; внешний Uptime Kuma проверяет этот endpoint отдельно от liveness.

## Доставка в Б24

Через входящий webhook (`BITRIX24_WEBHOOK_URL`):
1. `crm.contact.add` — Контакт с EMAIL + PHONE + SOURCE_ID (`VELOCE_SITE`/`MAXBOT_PRO`).
2. `crm.deal.add` — Сделка с CONTACT_ID + UF_CRM_CHANNEL + SOURCE_ID + TITLE/COMMENTS,
   сформированными через `services/crm/format.ts` (лейбл сайта в TITLE, для
   `maxbot_pro` в COMMENTS — структурный префикс с лейблами Сайт/Лендинг/Запрос/Интерес).

При сбое — запись падает в SQLite outbox, фоновый воркер досылает с экспоненциальным backoff
(5s → 30s → 2m → 10m → 1h → 6h → 24h, 7 попыток).

## CRM schema v1

Manifest находится в `src/tools/crm-schema.ts`. По умолчанию команда выполняет
read-only dry-run. `--apply` создаёт только отсутствующие поля и затем делает
полный exact read-back; несовпадающий тип/XML_ID/label/list visibility завершает
команду ошибкой.

```bash
BITRIX24_WEBHOOK_URL='…' npm run crm:schema
BITRIX24_WEBHOOK_URL='…' npm run crm:schema -- --apply
```

## Offline analytics worker

Executable module/event/SQLite/API contract, TDD matrix and controlled E2E cleanup plan:
[`docs/offline-analytics-contract-v1.md`](docs/offline-analytics-contract-v1.md).

При `ANALYTICS_ENABLED=true` сервис каждые пять минут перечитывает tracked-сделки
и их `crm.stagehistory.list`, формирует только разрешённые milestones
`qualified_lead`/`won_deal` и доставляет один обновляемый заказ через Yandex
Metrika Simple Orders API. Категории `10` (Фриланс) и `12` (test) исключены.
Revenue становится активным после исторически достигнутого `C2/C4/C6:FINAL_INVOICE`,
но не снапшотится: каждый poll использует текущие `OPPORTUNITY` и `CURRENCY_ID`,
а изменение суммы обновляет тот же order. Outbox хранит одну latest desired delivery
на order id и отдельно текущий in-flight upload. После crash `sending` безопасно
повторяется с тем же deterministic order id; если desired payload изменилась во
время отправки, новая версия остаётся dirty до terminal read-back предыдущей.
Даже clean payload повторно сверяется раз в сутки, чтобы late provider processing
в итоге сходилось к текущему состоянию Bitrix24.
Read-back обрабатывает не более одной страницы истории на заказ за tick и сохраняет
`datetime_offset` в SQLite, поэтому поиск exact `uploading_id` продолжается без
фиксированного cap. Успех требует `api_validation_status=PASSED` и ровно один
элемент; непроходящий cursor и неизвестный статус завершаются fail-closed.
PII в analytics state/outbox не сохраняется.

Миграции выполняются отдельным deployment gate; обычный runtime только проверяет
точную версию и целостность схемы:

```bash
npm run build
npm run db:migrate -- /path/to/web.sqlite
npm start
```

Сначала миграция репетируется на SQLite Backup API snapshot. Worker активируется
только после создания CRM-целей и установки `BITRIX24_PORTAL_ID`,
`YANDEX_METRIKA_COUNTER_ID`, `YANDEX_OAUTH_TOKEN`.

## Production status

На 2026-09-02 worker production-enabled. Controlled live E2E подтвердил strict form
attribution, copied-deal lineage, один deterministic root order, `qualified_lead`,
`FINAL_INVOICE` revenue и `won_deal`; все три Yandex upload read-back получили
`api_validation_status=PASSED`. Test CRM objects удалены по identity guard, immutable
analytics evidence сохранено. Технический контур — **GO**; paid traffic остаётся
отдельным owner-approved launch gate.

Каноническая карта текущего source/live-состояния:
Basic Memory `05-projects/veloce24/01-context/veloce24 — текущая карта сайта и документации`.
