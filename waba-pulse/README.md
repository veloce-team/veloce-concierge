# waba-pulse

Stub-вебхук Meta-пульса — этап 1 backlog `waba-connect`. Цель: снять **сырой
payload** реального входящего WhatsApp-сообщения (Meta Cloud API) для таблицы
маппинга типов в `most-kontur.md`. **НЕ боевой шлюз**, выбрасываемый сервис.

Plain Node (`node:http` + `crypto` + `fs`), без зависимостей — `npm install` не нужен.

## Эндпоинты

- `GET /webhook` — verify-handshake Meta. `hub.mode=subscribe` И
  `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN` → `200` + тело `hub.challenge`
  (`text/plain`, без кавычек). Иначе → `403`.
- `POST /webhook` — приём вебхука. Сырое тело собирается в `Buffer` до парсинга,
  считается `sha256=HMAC_SHA256(rawBody, META_APP_SECRET)`, сверяется с заголовком
  `X-Hub-Signature-256` (constant-time). **Дамп сырья пишется ДО ветвления** в
  `/data/meta-pulse/<ISO-ts>.json` (`:` → `-` в имени). Подпись валидна → `200`
  `EVENT_RECEIVED`; невалидна → `401` (дамп уже записан в обоих случаях).
- `GET /health` — `200 ok`.

Формат дампа: `{ receivedAt, method, headers, rawBody, receivedSig, computedSig,
signatureValid, parsed }`.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `META_WEBHOOK_VERIFY_TOKEN` | произвольная строка, та же вводится в Meta App Dashboard |
| `META_APP_SECRET` | App Secret из Meta (Settings → Basic) — ключ HMAC |
| `PORT` | порт прослушивания, default `3000` |

Секреты держит Aleksey в `.env` на хосте. В vault и в код значения не пишутся.

## Локальный smoke (без Meta)

```bash
cd waba-pulse
META_WEBHOOK_VERIFY_TOKEN=tok META_APP_SECRET=sec PORT=3000 node server.js &

# 1) handshake
curl -s 'http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=test123'
# → test123

# 2) POST с валидной подписью
BODY='{"object":"whatsapp_business_account"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac sec | awk '{print $2}')
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/webhook \
  -H "X-Hub-Signature-256: sha256=$SIG" -H 'content-type: application/json' -d "$BODY"
# → 200, дамп с signatureValid:true

# 3) POST с битой подписью
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/webhook \
  -H 'X-Hub-Signature-256: sha256=deadbeef' -H 'content-type: application/json' -d "$BODY"
# → 401, дамп с signatureValid:false
```

Дампы локально пишутся в `/data/meta-pulse/` (нужен доступ на запись; в smoke
можно временно подставить путь или гонять в контейнере).

## Deploy (зона Aleksey)

Хост — **финский Aeza** (`veloce-aeza`, 193.29.225.31). Контур — монорепо
`veloce-concierge`, aeza-стек. Домен `wa.maxbot-pro.ru` (A-запись на 193.29.225.31).
Дампы лежат на хосте в `/opt/waba-pulse-data/meta-pulse/` (bind-mount, вне дерева
репо) — забираются напрямую `scp`/`cat`, без `docker cp`.

```bash
# 0) ОДИН раз перед первым up — создать каталог bind-mount на хосте:
mkdir -p /opt/waba-pulse-data

# 1) задать секреты:
cp waba-pulse/.env.example waba-pulse/.env   # заполнить META_WEBHOOK_VERIFY_TOKEN, META_APP_SECRET

# 2) поднять стек:
docker compose -f docker-compose.aeza.yml up -d --build

# 3) ОБЯЗАТЕЛЬНО — reload Caddy. Caddyfile.aeza смонтирован bind'ом :ro, правка
#    файла сама не перечитывается. Без reload wa.maxbot-pro.ru не поднимется и
#    Let's Encrypt-сертификат не выпустится:
docker compose -f docker-compose.aeza.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Reload Caddy = секундный блип для живого `bot.veloce.team` на том же хосте — норма.
TLS выдаётся автоматически, когда A-запись резолвится на Aeza и порт 80 доступен.

После прогона — забрать дамп с хоста:
```bash
cat /opt/waba-pulse-data/meta-pulse/*.json   # на veloce-aeza
```

## Забор payload

После пойманного входящего сообщения сырой дамп отдаётся в следующую сессию:
он становится основой раздела «Эндпоинты» / «К наполнению» в `most-kontur.md`.
