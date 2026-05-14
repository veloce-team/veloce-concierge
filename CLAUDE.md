# CLAUDE.md — veloce-concierge

Этот файл — единственный источник истины для Claude Code (CC) при работе в этом репо.
По Регламенту Aleksey ↔ Claude.ai §1.4: CC в Notion не ходит; что нужно знать — должно быть здесь.

При расхождении этого файла с Notion — обновляется CLAUDE.md под Notion, не наоборот.

---

## 1. Что это

**Veloce Concierge** — AI-консультант в Telegram + Mini App-обёртка как «лицо» студии Veloce.
Внутренний продукт студии и одновременно кейс №2 в портфеле после Phon. Цель — продукт,
которым не стыдно представить студию: AI реально полезен, тон в стиле Veloce, UI на уровне Phon.

Цели — две оси, идут параллельно:

- **AI-консультант** (мозги): v0 роутер → v1 диалог → v2 контекст → v3 RAG+публичный сервис
- **UI** (лицо): Tier 1 InlineKeyboard → Tier 2 request_contact/прогрессы → Tier 3 Mini App → Tier 4 inline mode

Публичный вывод — когда (а) AI v1+ работает в проде, (б) Mini App в эстетике Veloce развёрнут,
(в) UI бота на Tier 2.

---

## 2. Фазы

| Этап / Блок | Статус | Что внутри |
|---|---|---|
| Этап 1 — инфра и база | **закрыт 12.05.2026** | VPS TimeWeb, Docker+Caddy+HTTPS на 5 поддоменах, GitHub Org veloce-team, TG-бот @veloce_concierge_bot, GigaChat Freemium, Битрикс24 webhook, email hello@veloce.team. МАКС-регистрация — ждёт ИП |
| Блок 2а — TG-бот MVP | **закрыт 13.05.2026 (ch4)** | core/dialog + adapters/tg, SQLite-сессии, 3 сценария (контакт/портфолио/смета), 5 качественных паттернов, миграция на Aeza |
| Блок 2б — MAX-адаптер | отложен до ИП | adapters/max, request_contact (HMAC), open_app в Mini App, публикация в каталоге МАКС |
| Этап 3 — AI-сервис | not started | ai-service/: FastAPI + GigaChat SDK, /quote и /chat. Развёртывание — Москва |
| Этап 4 — Битрикс24 | частично в Блоке 2а | crm.deal.add из сценария «Связаться» работает; кастомизация полей и UF — в Этапе 4 |
| Этап 5 — Mini App | not started | mini-app/: React+Vite+max-ui, MAX Bridge. Развёртывание — Москва, [app.veloce.team](http://app.veloce.team) |
| Этап 6 — кейс и сдача | not started | Loom-демо, Kwork-описание, статья на VC.ru, обновление футера Phon |

---

## 3. Стек (фикс)

- **Node.js** 20 LTS, **TypeScript** 5.x, ESM (`"type": "module"`)
- **Webhook-фреймворк:** Hono
- **Telegram:** grammy
- **MAX:** maxbot-api-client-ts (Блок 2б)
- **Storage:** better-sqlite3 в Docker volume (`/data/concierge.sqlite`)
- **Логи:** pino + child-логгеры; в проде — JSON, в dev — pino-pretty
- **Env-валидация:** Zod
- **Тесты:** vitest
- **AI (Этап 3):** Python 3.11 + FastAPI + gigachat SDK
- **Mini App (Этап 5):** React 18 + Vite + @maxhub/max-ui + MAX Bridge
- **Контейнеры:** Docker + docker-compose, образы alpine где возможно
- **Прокси:** Caddy 2-alpine (авто Let's Encrypt)
- **CRM:** Битрикс24 бесплатный, REST входящий webhook. Работаем со Сделками (crm.deal.add), не Лидами — в бесплатном тарифе режим «простой CRM», лидов нет
- **AI:** GigaChat Freemium (1 млн токенов/год на физлицо)

---

## 4. Архитектура

Мессенджер-независимое ядро + адаптеры.

```
bot/src/
  core/dialog/            — мессенджер-независимая state machine + сценарии
    state-machine.ts        транзиции по DialogContext
    types.ts                BotAdapter, DialogContext, CRMClient
    menu.ts                 главное меню
    scenarios/
      start.ts              /start
      contact.ts            имя → телефон → описание → crm.deal.add
      portfolio.ts          Phon-кейс
      estimate.ts           автоответ из прайса (AI-версия — Этап 3)
  adapters/
    tg/                     grammy + Hono webhook (боевой)
      adapter.ts            BotAdapter реализация
      mappers.ts            grammy ↔ DialogContext
      webhook.ts            POST /webhook/tg
    max/                    стабы под Блок 2б
  services/
    crm/bitrix24.ts         клиент Битрикс24
    outbox/                 retry-очередь для CRM
      queue.ts              SQLite-backed
      worker.ts             фоновый воркер
    sessions/
      db.ts                 better-sqlite3 connection
      store.ts              sessions + idempotency
      migrations/001-init.sql
  infra/
    http/
      server.ts             Hono-сервер
      health.ts             GET /health
      metrics.ts            GET /metrics (только внутри veloce-net)
    cleanup.ts              TTL для idempotency и старых сессий
    logger.ts               pino root + child-логгеры
  config/env.ts             Zod-схема env
  main.ts                   composition root
```

**Правило расширения:** новые мессенджеры — только новые `adapters/<name>/`, ядро не трогаем.
Сценарии — в `core/dialog/scenarios/`, общие для всех адаптеров.

---

## 5. Инфра / деплой

**Раздельная инфраструктура** (с 13.05.2026, после блокировки Telegram Bot API ТСПУ из РФ):

| Домены | VPS | Compose-файл |
|---|---|---|
| `veloce.team`, `www`, `api.veloce.team`, `app.veloce.team` | Moscow TimeWeb (85.239.61.176) | `docker-compose.yml` + `infra/caddy/Caddyfile` |
| `bot.veloce.team` (только TG-бот) | Helsinki Aeza (193.29.225.31) | `docker-compose.aeza.yml` + `infra/caddy/Caddyfile.aeza` |

Сеть `veloce-net` — external, создаётся на каждом VPS однократно (`docker network create veloce-net`).
Окружения изолированы — общего состояния нет.

**Деплой на Moscow:**
```bash
ssh veloce-vps           # ~/.ssh/id_ed25519_veloce (WSL)
cd /opt/veloce-concierge
git pull
docker compose up -d --build
```

**Деплой на Helsinki (TG-бот):**
```bash
ssh veloce-aeza          # ~/.ssh/id_ed25519 (WSL, тот же что для GitHub)
cd /opt/veloce-concierge
git pull
docker compose -f docker-compose.aeza.yml up -d --build
```

**Регистрация webhook'а в TG** (после деплоя):
```bash
# Способ 1 (рекомендуемый в проде) — curl напрямую:
curl -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook" \
  -d "url=${PUBLIC_URL}/webhook/tg" \
  -d "secret_token=${TG_WEBHOOK_SECRET}"

# Способ 2 (dev) — npm script через tsx, не работает в production-образе (npm ci --omit=dev):
docker compose exec concierge-bot npm run set-webhook
```

**SSH-aliases** в WSL (на компьютере Aleksey):
- `veloce-vps` → Moscow TimeWeb, ключ `~/.ssh/id_ed25519_veloce`
- `veloce-aeza` → Helsinki Aeza, ключ `~/.ssh/id_ed25519` (тот же, что для GitHub)

Все git-операции — из WSL, не из cmd.exe. CC запускать из WSL-терминала.

---

## 6. Правила разработки

**Стиль:**
- TypeScript strict, ESM
- Никаких `any` без явного `// reason:`
- Структурированные ошибки — пробрасываем как `Result<T, E>`-подобные объекты или throw с тегом
- pino + child-логгеры в каждом модуле: поля `chat_id`, `update_id`, `scenario`, `step`, `latency_ms`
- Env читается только через `config/env.ts` (Zod-схема), импорт из любого места — через него

**5 обязательных качественных паттернов Блока 2а** (см. handover ch3+ch4):
1. **Idempotency** — храним `update_id` в SQLite с TTL 24ч; дубликаты TG игнорируются
2. **Outbox + retry** — при недоступности Битрикс лид сохраняется в `outbox`-таблице, фоновый воркер досылает
3. **Structured logging** — pino JSON, child-логгер на каждый scenario, поля выше
4. **/health + /metrics** — health публично через Caddy, metrics только внутри `veloce-net`
5. **Env-валидация** — Zod, бот не стартует без обязательных переменных

**Workflow для CC:**
- Паттерн «аудит → проект контракта → подтверждение → код» — стандарт
- Git-операции (commit/push/PR/merge) — Aleksey делает сам; CC код пишет, не пушит
- CI на момент 13.05.2026 не настроен — тесты прогоняем локально через `npm test`
- ADR в репо не заводим (проект небольшой; фиксации в Notion достаточно)

**Что НЕ применимо к этому репо:**
- Запреты НИОКР-формулировок — это правило только для Taxi Fleet ERP (см. Регламент §1.5)

---

## 7. Известные грабли (зафиксированы по ch3+ch4)

Подробно — в Notion-странице «🐳 Инфра-стек» (справочник). Сжато здесь:

- **`apt install iptables-persistent` удаляет `ufw`** на Ubuntu 24.04 (пакеты конфликтуют). Решение — выбрать один инструмент и не менять. Для Veloce — ufw везде.
- **`tsx` в devDependencies не попадает в production-образ** при `npm ci --omit=dev`. `scripts/set-webhook.ts` работает только в dev. В проде — curl-команда (см. §5).
- **`tsconfig` без явного `rootDir`** — TS выводит вывод под `dist/<input-path>/`. У нас `rootDir: "./src"` + `include: ["src/**/*.ts"]` — это must.
- **bind-mount в docker сохраняет ownership хоста** — для контейнера под uid 1000 нужен `chown -R 1000:1000 ./data` на хосте.
- **better-sqlite3 prebuild нестабилен** — в `bot/Dockerfile` добавлены npm fetch-timeouts (`NPM_CONFIG_FETCH_TIMEOUT=600000` + retry mintimeout/maxtimeout) в стадиях builder и prod-deps. Закрыто 14.05.2026.
- **ТСПУ блокирует Telegram Bot API из дата-центров РФ** с марта 2026 — поэтому TG-бот на Aeza Хельсинки. MSS PMTU-clamp — частичный фикс, не системное решение.
- **Windows-git и WSL-git имеют разные SSH-ключи** — все git-операции из WSL.

---

## 8. Технический долг

Из handover ch4. Не блокирует разработку, но разбираем в проходе «гигиены».

**Блокирует публичный вывод:**
- Реальные фото Phon вместо placeholder'ов 1×1 в `bot/src/assets/portfolio/`
- Этот файл (CLAUDE.md) — создан 14.05.2026, поддерживаем актуальным

**Код:**
- ~~`bot/.env.example` `PUBLIC_URL=https://api.veloce.team` — устарел~~ — закрыто 14.05.2026, дефолт переведён на `https://bot.veloce.team` (Helsinki), Москва — в комментарии как fallback/dev.
- ~~`set-webhook` — задокументировать как dev-only + curl-альтернатива~~ — закрыто 14.05.2026 в `bot/README.md` и корневом `README.md`.
- `data/.gitkeep` — убрать из репо (директория создаётся compose-mount'ом с правильным uid). Требуется `git rm data/.gitkeep`.

**Инфра (Moscow):**
- Сиротские `caddy_data`/`caddy_config` volumes от standalone-caddy эпохи — `docker volume prune` через сутки после подтверждения стабильности Aeza
- UFW удалён при `apt install iptables-persistent` — вернуть UFW, iptables-persistent больше не нужен (MSS-clamp убран)
- Старый московский контейнер бота — fallback 24–48ч, потом `docker compose rm concierge-bot`

**Инфра (оба VPS):**
- `caddy fmt --overwrite` на обоих VPS (warning при reload)

**Битрикс24:**
- Выяснить лимиты `crm.deal.add` в сутки на бесплатном тарифе

**Критично по сроку:**
- **Aeza VPS — оплата до 28.05.2026.** Баланс €0.00, автопродление выключено. Без продления TG-бот ляжет.

---

## 9. Открытые вопросы

- **Регистрация ИП** — общий блокер для Блока 2б (MAX), тендеров, dev.max.ru, GigaChat B2B-оферты
- **Этап 3 (AI-сервис)** — стартуем после наполнения Прайса Veloce (без него AI v1 угадывает) и сборки промпта AI-сметы (см. Notion: 🤖 Дорожная карта AI-консультанта)
- **Этап 5 (Mini App)** — после Этапа 3, эстетика Veloce (slate #0B1220 + electric blue #3B82F6 + amber #F59E0B + Manrope/Inter)

---

## 10. Связанный контекст в Notion (только для Aleksey/claude.ai, не для CC)

CC по Регламенту §1.4 в Notion не ходит. Эти ссылки — для Aleksey, когда он готовит промпт CC,
чтобы сверить контекст. Если CC просят что-то, что зависит от информации ниже — она должна быть
явно процитирована в промпте.

- 🤖 Veloce Concierge — AI-консультант в Telegram + Mini App (главная страница продукта)
- 🐳 Инфра-стек (Справочник) — детально про грабли инфры
- 📦 Handover 13.05.2026 (ch3) — проектирование Блока 2а
- 📦 Handover 13.05.2026 (ch4) — деплой, ТСПУ, миграция на Aeza
- 📖 Регламент работы Aleksey ↔ Claude.ai

---

*Создано 14.05.2026 при разборе техдолга после контрольной точки ch4. Обновляется при изменении стека, фаз, правил разработки или архитектуры.*
