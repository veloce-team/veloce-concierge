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

**Статика `veloce.team` (с 16.05.2026):** обслуживается Caddy file-server'ом из `/opt/veloce-site` на Moscow VPS. Это отдельный приватный репо [`AlexBurkovRus/veloce`](https://github.com/AlexBurkovRus/veloce) (vanilla HTML/CSS/JS + WebGL), склонированный на VPS по deploy key:

- Приватный ключ: `/root/.ssh/veloce_site_deploy` (ed25519, read-only deploy key в GitHub).
- SSH-alias в `/root/.ssh/config`: `github-veloce-site` → `git@github.com` с этим ключом.
- Обновление сайта на VPS: `cd /opt/veloce-site && git pull` (через alias). В `docker-compose.yml` каталог смонтирован как `/opt/veloce-site:/srv/veloce-site:ro` в сервис `caddy`.
- Бренд-ассеты `/branding/*` остаются на старом месте — bind `./branding:/srv/branding:ro` из этого репо, отдельный handle в Caddyfile с `Cache-Control: public, max-age=86400`.

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

## 6.1 Deep-link start_param → SOURCE_ID

Telegram deep-link `https://t.me/veloce_concierge_bot?start=XXX` приходит в бота как
`/start XXX`. Параметр парсится в `adapters/tg/mappers.ts` → `IncomingMessage.startParam`,
и в `scenarios/start.ts` резолвится через `config/sources.ts::resolveSourceId(startParam)`
в External ID источника в Битрикс24. Результат «прилипает» к `DialogContext.sourceId`
до следующего `/start` и проставляется в `CrmPayload.sourceId` при создании Сделки.

Схема имён источников в Б24: **«Откуда → через что добрался»** (TG-канал; MAX появится
в Блоке 2б отдельной таблицей `* → MAX Concierge`).

| `?start=` | Источник в Б24                | External ID                      |
|-----------|-------------------------------|----------------------------------|
| (нет)     | `TG Concierge (direct)`       | `TG_CONCIERGE_DIRECT`            |
| `phon`    | `Phon → TG Concierge`         | `PHON_TG_CONCIERGE`              |
| `veloce`  | `Veloce.team → TG Concierge`  | `VELOCE_TG_CONCIERGE`            |
| `site`    | `Veloce.team → TG Concierge`  | `VELOCE_TG_CONCIERGE` (алиас)    |
| `kwork`   | `Kwork → TG Concierge`        | `KWORK_TG_CONCIERGE`             |

Все 4 источника созданы в Б24 (Настройки → CRM → Справочники → Источники) — External ID
проставлены в `bot/src/config/sources.ts`. Дополнительно остаётся `Тильда (Phon) — CTA-форма`
для формы на лендинге Phon (отдельный канал, не через Concierge).

Неизвестный `start_param` → fallback на `DEFAULT_SOURCE_ID` + `warn` в логах
(поле `start_param`), чтобы заметить новый канал.

---

## 6.2 Микросервис `web/` — POST /api/lead

Stand-alone Node-микросервис в директории `web/` (параллельно `bot/`, `ai-service/`, `mini-app/`). Принимает заявки с формы на сайте `veloce.team` и создаёт пару Контакт + Сделка в Битрикс24. Развёрнут 16.05.2026 на Moscow VPS как `concierge-web` (image `veloce-concierge-concierge-web`, named volume `web_data`, healthcheck wget `/health`).

**Стек:** Node 20 LTS + TS 5.x ESM, **Hono** (HTTP-фреймворк), **Zod** (валидация), **better-sqlite3** (outbox + idempotency), **pino** (logs), **undici** через нативный `fetch` (Б24-клиент).

**Эндпоинты:**
- `POST /api/lead` — приём заявок. `LeadSchema` (Zod): `name`, `email`, `phone`, `message` (min 10 символов), `source`, `channel`. Поле `website` — honeypot (любое значение → 200 с фейковым `ref`, реальная заявка не создаётся; решение до Zod-валидации).
- `GET /health` — `{ "status": "ok", "uptime_s": N }`. HEAD не поддерживается (Hono default); внутренний Docker healthcheck использует wget GET.

**Маппинг в Б24** (см. `web/src/services/crm/bitrix24.ts`):

1. **`crm.contact.add`** — поля:
   - `NAME` = lead.name
   - `EMAIL` = `[{ VALUE: lead.email, VALUE_TYPE: 'WORK' }]`
   - `PHONE` = `[{ VALUE: lead.phone, VALUE_TYPE: 'WORK' }]`
   - `SOURCE_ID` = `VELOCE_SITE` (External ID, отдельный канал — не алиас `VELOCE_TG_CONCIERGE`)
   - `OPENED: 'Y'`, `ASSIGNED_BY_ID` из env

2. **`crm.deal.add`** — поля:
   - `TITLE` = `"Заявка с сайта veloce.team — ${name}"`
   - `CONTACT_ID` = id из шага 1
   - `COMMENTS` = lead.message
   - `SOURCE_ID` = `VELOCE_SITE`
   - `UF_CRM_CHANNEL` = lead.channel (для site-формы всегда `form`)
   - `OPENED: 'Y'`, `ASSIGNED_BY_ID` из env

3. **`CrmPartialError`** — если контакт создан, но deal.add упал, contactId сохраняется в outbox-запись, на retry deal.add вызывается с готовым `CONTACT_ID` (не дублируем контакт).

**Защита:**
- **CORS allow-list** через env `CORS_ORIGINS` (JSON-массив; по умолчанию `["https://veloce.team","https://www.veloce.team"]`).
- **Rate-limit** 5 запросов / 10 мин на IP (`RATE_LIMIT_WINDOW_MS=600000`, `RATE_LIMIT_MAX=5`).
- **Honeypot** `website` — проверка до Zod, чтобы дешевле отбрасывать ботов.
- **Idempotency** через SHA256 от `name|email|phone|message`, TTL 10 мин (`IDEMPOTENCY_TTL_MS=600000`). Повторный submit идентичного payload в течение TTL возвращает тот же `ref` без второй записи.

**Outbox + retry** (`web/src/services/outbox/worker.ts`):
- При успехе синхронного call'а в Б24 → 200 с реальным `ref`, запись в outbox помечается `sent`.
- При недоступности Б24 → 200 с outbox-ref (для пользователя успех), запись в outbox остаётся `pending`. Фоновый воркер каждые 30s забирает due-записи.
- Backoff: **5s → 30s → 2m → 10m → 1h → 6h → 24h**, `MAX_ATTEMPTS=7`. После 7 неудач — `markFailed`, лог `crm: gave up after max attempts`.
- Тайм-аут единичного запроса к Б24 — 10s (`AbortController`).

**Б24 reqs:**
- `BITRIX24_WEBHOOK_URL` в `web/.env` — копируется из `bot/.env` (общий портал).
- `ASSIGNED_BY_ID=1` — получено через `crm.deal.list?select[]=ASSIGNED_BY_ID` (см. `Vault/02-references/bitrix24.md` Г8: `user.current` через webhook возвращает `{ID: null}`).
- Источник `VELOCE_SITE` создан в Настройки → CRM → Справочники → Источники.
- UF_CRM_CHANNEL — пользовательское поле сделки, должно существовать в портале (тип строка).

**Контейнер и сеть:**
- `concierge-web` в `docker-compose.yml`, named volume `web_data:/data` (SQLite).
- Caddy `api.veloce.team` reverse_proxy на `concierge-web:3000` для `/api/lead` и `/health` (объединённый matcher `@web`).
- Сервис не светит порты наружу — только `expose: 3000` в `veloce-net`.

**Деплой и smoke:**
```bash
ssh veloce-vps
cd /opt/veloce-concierge && git pull
# первый раз — подготовить web/.env (BITRIX24_WEBHOOK_URL + ASSIGNED_BY_ID=1)
docker compose up -d --build concierge-web
docker compose restart caddy        # подхватить блок api.veloce.team
docker compose logs concierge-web   # ожидаем "http: listening"
curl -s https://api.veloce.team/health
```

**Тесты:** 35/35 vitest (7 файлов), `tsc --noEmit` clean. Локальный `npm test` обязателен перед коммитом.

---

## 7. Известные грабли (зафиксированы по ch3+ch4)

Подробно — в Notion-странице «🐳 Инфра-стек» (справочник). Сжато здесь:

- **`apt install iptables-persistent` удаляет `ufw`** на Ubuntu 24.04 (пакеты конфликтуют). Решение — выбрать один инструмент и не менять. Для Veloce — ufw везде.
- **`ufw allow OpenSSH` падает сразу после `apt install ufw`** — профиль `OpenSSH` ещё не зарегистрирован, `ufw status` пишет `ERROR: problem running`. Fallback — `ufw allow 22/tcp` напрямую (эквивалент). Через минуту-две профиль OpenSSH появляется и его можно тоже добавить (два правила безопасны).
- **`tsx` в devDependencies не попадает в production-образ** при `npm ci --omit=dev`. `scripts/set-webhook.ts` работает только в dev. В проде — curl-команда (см. §5).
- **`tsconfig` без явного `rootDir`** — TS выводит вывод под `dist/<input-path>/`. У нас `rootDir: "./src"` + `include: ["src/**/*.ts"]` — это must.
- **bind-mount в docker сохраняет ownership хоста** — для контейнера под uid 1000 нужен `chown -R 1000:1000 ./data` на хосте.
- **better-sqlite3 prebuild нестабилен** — в `bot/Dockerfile` добавлены npm fetch-timeouts (`NPM_CONFIG_FETCH_TIMEOUT=600000` + retry mintimeout/maxtimeout) в стадиях builder и prod-deps. Закрыто 14.05.2026.
- **ТСПУ блокирует Telegram Bot API из дата-центров РФ** с марта 2026 — поэтому TG-бот на Aeza Хельсинки. MSS PMTU-clamp — частичный фикс, не системное решение.
- **WSL → российский VPS / WSL → GitHub SSH — иногда timeout** из российской сети (наблюдалось 14.05.2026). По умолчанию работаем из WSL, но при отказе — fallback на Windows-сторону. Подробнее — в Регламенте §1.2 «WSL vs Windows для git/SSH/docker». Кратко:
  - Git push: Windows-git + `gh auth setup-git` (HTTPS).
  - SSH к VPS: `C:\WINDOWS\System32\OpenSSH\ssh.exe`, ключи из `C:\Users\imbur\.ssh\`.
  - Docker (например `caddy fmt`): docker.exe (Docker Desktop), volume mapping через `wslpath -w`.
- **Ключи в обоих местах** — WSL `~/.ssh/` и Windows `C:\Users\imbur\.ssh\` синхронизированы. Новый ключ — сразу в оба места.
- **Volume-префикс compose определяется именем директории проекта** на момент первого `docker compose up`. После переименования директории старые volumes остаются с прежним префиксом и становятся сиротами. Наблюдалось 16.05.2026 — `infra_caddy_*` volumes сохранились от прошлого compose-проекта с именем директории `infra/`.

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
- ~~Сиротские `caddy_data`/`caddy_config` volumes от standalone-caddy эпохи — `docker volume prune` (часть B плана 14.05.2026, после ≥ 24 ч стабильности Aeza)~~ — закрыто 16.05.2026 ch1 (фактически висели как `infra_caddy_*` от старой директории проекта, см. §7).
- ~~UFW удалён при `apt install iptables-persistent` — вернуть UFW~~ — закрыто 14.05.2026 (часть A). UFW активен, 22/80/443 ALLOW, iptables-persistent удалён.
- ~~Старый московский контейнер бота — fallback (часть B плана 14.05.2026)~~ — закрыто 16.05.2026 ch1 (`docker compose rm` + образ удалён).
- ~~Блок `concierge-bot` в `docker-compose.yml` остаётся в файле, хотя на Moscow-боте не нужен (TG на Aeza). При `docker compose up -d` на Moscow контейнер вновь поднимается — после site-deploy 16.05.2026 пришлось делать `docker compose stop concierge-bot && docker compose rm -f` вручную. Закроется при merge WIP `concierge-web` (там этот блок заменён на блок web-сервиса). До тех пор — known, не блокер: контейнер слушает только internal `:3000`, TG webhook на Helsinki не трогается.~~ — закрыто 16.05.2026 ch4 (этот деплой `/api/lead`). Блок `concierge-bot` удалён из compose, заменён на `concierge-web`.

**Инфра (оба VPS):**
- ~~`caddy fmt --overwrite` на обоих VPS~~ — закрыто 14.05.2026 (часть A). Оба Caddyfile отформатированы, без warning при reload.

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
