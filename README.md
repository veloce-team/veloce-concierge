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

# регистрация webhook'а в TG (в проде — curl, см. bot/README.md «Регистрация webhook'а»):
set -a; . ./bot/.env; set +a
curl -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook" \
  -d "url=${PUBLIC_URL%/}/webhook/tg" \
  -d "secret_token=${TG_WEBHOOK_SECRET}"
```

## Production deployment

Боевая инфра разнесена по двум VPS:

| Домены | Локация | Compose-файл |
|---|---|---|
| `veloce.team`, `www.veloce.team`, `api.veloce.team`, `app.veloce.team` | Moscow VPS (`85.239.61.176`) | `docker-compose.yml` + `infra/caddy/Caddyfile` |
| `bot.veloce.team` (Telegram-бот) | Helsinki VPS (`193.29.225.31`) | `docker-compose.aeza.yml` + `infra/caddy/Caddyfile.aeza` |

TG-бот вынесен в Helsinki по причине регионально-специфичной связности Telegram Bot API; остальные сервисы остаются в Москве. Окружения изолированы — у каждого свой `veloce-net` (external), общего состояния нет.

Статика `veloce.team` обслуживается Caddy file-server'ом из `/opt/veloce-site` на Moscow VPS — это отдельный приватный репо [`AlexBurkovRus/veloce`](https://github.com/AlexBurkovRus/veloce), смонтированный в контейнер caddy как read-only bind (`/opt/veloce-site:/srv/veloce-site:ro`). Подробности (deploy key, ssh-config) — `CLAUDE.md` §5.

Деплой на Helsinki:
```bash
docker compose -f docker-compose.aeza.yml up -d --build
```

## Эндпоинты

| URL | Доступ | Назначение |
|---|---|---|
| `https://bot.veloce.team/webhook/tg` | публично (Helsinki) | приём апдейтов от Telegram |
| `https://bot.veloce.team/health` | публично (Helsinki) | liveness, минимальный `{status, uptime_s}` |
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
