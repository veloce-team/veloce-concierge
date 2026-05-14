# @veloce/concierge-bot

Telegram-бот Veloce Concierge — приём лидов, портфолио, авто-смета, выгрузка в Битрикс24.
Блок 2а MVP. См. `../veloce-concierge-block-2a.md`.

## Структура

```
src/
  core/dialog/        — мессенджер-независимое ядро (state machine, сценарии)
  adapters/tg/        — grammy + Hono webhook
  adapters/max/       — стабы под Блок 2б
  services/crm/       — Битрикс24-клиент
  services/outbox/    — очередь с retry для исходящих в CRM
  services/sessions/  — SQLite + миграции
  infra/http/         — Hono-сервер: /webhook/tg, /health, /metrics
  infra/logger.ts     — pino + child-логгеры
  config/env.ts       — Zod-валидация env
  main.ts             — composition root
tests/                — vitest: state machine + outbox
scripts/set-webhook.ts — регистрация webhook'а в TG
```

## Быстрый старт (локально)

```bash
cp .env.example .env
# заполнить TG_BOT_TOKEN, BITRIX24_WEBHOOK_URL, TG_WEBHOOK_SECRET (32+ символа), PUBLIC_URL
npm install
npm run dev
```

## Тесты

```bash
npm test
```

## Сборка / прод

```bash
npm run build
npm start
```

В Docker — см. корневой `docker-compose.yml`.

## Регистрация webhook'а в TG

Скрипт `npm run set-webhook` — **dev-only**. Он запускается через `tsx`, а `tsx` лежит в `devDependencies` и не попадает в production-образ (`npm ci --omit=dev`). В проде зовём Telegram API напрямую:

```bash
# дев (локально или в контейнере dev-build):
npm run set-webhook

# production — curl (берём TG_BOT_TOKEN/TG_WEBHOOK_SECRET/PUBLIC_URL из bot/.env):
set -a; . ./bot/.env; set +a
curl -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook" \
  -d "url=${PUBLIC_URL%/}/webhook/tg" \
  -d "secret_token=${TG_WEBHOOK_SECRET}"
```

Скрипт читает `PUBLIC_URL` и `TG_WEBHOOK_SECRET` из env, ставит `${PUBLIC_URL}/webhook/tg`. curl делает ровно то же.

## Эндпоинты

| Path | Доступ | Содержимое |
|---|---|---|
| `POST /webhook/tg` | публично через Caddy | приём TG-апдейтов; требует заголовок `X-Telegram-Bot-Api-Secret-Token` |
| `GET /health` | публично через Caddy | `{status, uptime_s}` — для liveness-проверок |
| `GET /metrics` | только внутри `veloce-net` | `{sessions_count, dialogs_today, deals_sent_today, outbox_pending, ...}` |
