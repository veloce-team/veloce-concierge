# veloce-concierge

AI-консьерж студии Veloce — Telegram + МАКС + Mini App + GigaChat + Битрикс24.

Монорепо. Сервисы оркеструются через `docker-compose.yml` в корне.

## Структура

| Папка | Что внутри | Статус |
|---|---|---|
| `bot/`         | Concierge-бот (TS, grammy, Hono, SQLite). Блок 2а. | в работе |
| `ai-service/`  | Сервис генерации AI-смет на GigaChat. Этап 3.       | not started |
| `mini-app/`    | Telegram Mini App + витрина-портфолио. Этап 5.       | not started |
| `infra/caddy/` | Caddyfile + сниппет reverse-proxy для Concierge.     | боевой |
| `branding/`    | Логотипы, аватары, OG-изображения, палитра.          | актуально |
| `data/`        | Docker volume под SQLite и persistent state.         | пусто, монтируется |

## Деплой на VPS

VPS уже настроен (Этап 1 закрыт 12.05.2026): Docker, Caddy, HTTPS на 5 поддоменах,
сеть `veloce-net` создана как external.

```bash
# на VPS, из корня репо:
git pull
cd bot && cp .env.example .env  # первый раз — заполнить значения
cd ..

# первый запуск или сборка после правок bot/:
docker compose up -d --build concierge-bot

# рестарт Caddy при правке Caddyfile:
docker compose restart caddy

# регистрация webhook'а в TG:
docker compose exec concierge-bot npm run set-webhook
```

## Эндпоинты

| URL | Доступ | Назначение |
|---|---|---|
| `https://api.veloce.team/webhook/tg` | публично | приём апдейтов от Telegram |
| `https://api.veloce.team/health` | публично | liveness, минимальный `{status, uptime_s}` |
| `concierge-bot:3000/metrics` | только внутри `veloce-net` | счётчики диалогов, лидов, outbox |

## Сеть

Контейнеры подключены к external-сети `veloce-net`. Создаётся однократно на VPS:

```bash
docker network create veloce-net
```

## Локальная разработка бота

См. `bot/README.md`.

## Лицензия

UNLICENSED — internal, see `LICENSE`.
