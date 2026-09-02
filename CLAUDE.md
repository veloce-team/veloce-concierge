# CLAUDE.md — правила работы в `veloce-team/veloce-concierge`

Этот monorepo содержит production-контур Veloce: Caddy/infra, lead API, Bitrix24-интеграции, durable SQLite/outbox, offline analytics и отдельные bot/supporting packages. Файл задаёт repo-specific правила для coding agents, а не хранит быстро устаревающий release status.

## Источники истины

1. Реализованное поведение: текущая revision, исходники, миграции и тесты.
2. Текущая карта проекта: Basic Memory project `staging`, заметка `05-projects/veloce24/01-context/veloce24 — текущая карта сайта и документации`.
3. Repo docs: [`README.md`](README.md), [`web/README.md`](web/README.md), [`web/docs/offline-analytics-contract-v1.md`](web/docs/offline-analytics-contract-v1.md).
4. Операционный статус задач: Hermes Kanban board `veloce24`.
5. Live-факты: прямой runtime/API/database/log read-back. Не фиксируй current SHA вручную здесь.

Notion, старый vault, `/opt/veloce-site`, ручной `git pull` и исторические IP/SSH-рецепты не являются текущим authority или deploy-моделью.

## Компоненты и границы

- `web/` — production lead intake, Bitrix24 delivery, SQLite/outbox и Bitrix24→Yandex offline analytics.
- `infra/caddy/` — shared production front door; изменение может затронуть несколько сервисов.
- `bot/` — отдельный Telegram/МАХ-контур; следуй его README и не переноси автоматически web-инструкции.
- `waba-pulse/`, `mini-app/`, `ai-service/` — отдельные packages/contours; не считай их частью текущего публичного сайта без прямого source/runtime evidence.
- Публичный Astro-сайт находится в отдельном репозитории `AlexBurkovRus/veloce`.

## Public web contract

Текущий контракт формы veloce.team:

```text
POST https://api.veloce.team/api/lead/v1
GET  https://api.veloce.team/health
GET  https://api.veloce.team/ready
```

- `/api/lead/v1` использует durable `lead_event_id`; retry возвращает сохранённый подтверждённый deal ID.
- Временная ошибка CRM возвращает retryable response и сохраняет durable outbox state согласно коду/tests.
- `/api/lead` — compatibility route, не текущий контракт публичной формы.
- Valid submission создаёт реальные CRM-объекты. Production E2E требует test-only identity, cleanup guards и сохранения immutable analytics evidence.
- Не добавляй PII в analytics events, logs, readiness, SQLite analytics state/outbox или Yandex payloads.

## Offline analytics contract

- Canonical copied-deal lineage key: `UF_CRM_1780724113` (`ID исходной сделки`).
- Одна logical lifecycle/state/order identity на `portal + root deal`.
- Current stage/revenue/currency берутся по контракту из актуального физического descendant.
- Разрешённые milestones и excluded categories определяются executable contract/tests, а не догадкой.
- Deterministic Yandex order ID должен оставаться стабильным для lineage.
- SQLite migrations и schema version — deployment gate; runtime не должен тихо мигрировать production DB.
- Никаких ручных production SQLite edits.

При изменении этих правил сначала обнови failing contract test, затем minimal implementation и contract docs.

## Локальная работа с `web/`

```bash
cd web
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
```

Дополнительно выполни `git diff --check`. Для schema/deploy изменений запускай focused migration/deploy-workflow tests и репетируй миграцию только на копии/snapshot, никогда на live DB вручную.

## Change control

1. Начинай от чистого `origin/main` в отдельной branch/worktree.
2. Проверь `git status`, workflow, package scripts, миграции и затрагиваемые runtime contracts.
3. Для поведения соблюдай RED → GREEN → regression.
4. Не расширяй scope до CRM/Yandex/Caddy/live mutations без явного решения.
5. Перед commit/push проверь staged diff и отсутствие секретов.
6. PR CI не deployит. Merge в `main` — отдельный production gate.
7. Для критичных lifecycle/persistence/deploy изменений требуется пропорциональный независимый review exact candidate bytes.

## Deployment и rollback

Production `web`/Caddy deployment выполняется только `.github/workflows/web-ci-deploy.yml`:

```text
branch → gates → PR CI без deploy → explicit merge
→ immutable /opt/veloce-concierge/releases/<sha>
→ Caddy validation + DB snapshot/migration rehearsal + rollback smoke
→ migration/promotion → atomic current switch → readiness/integrity/public smoke
```

Запрещено:

- ручной production `git pull`;
- ручная замена image/release/current;
- обход pipeline migration/rollback gates;
- прямое редактирование production SQLite;
- вывод секретов или токенов в команды, логи, PR и документацию.

После одобренного deploy проверь exact live release SHA, container image/readiness, SQLite schema/integrity и публичные `/health`/`/ready`. Для provider delivery нужен terminal Yandex API read-back, а не только локальный статус outbox.

## Definition of done

- Согласованный scope и acceptance закрыты.
- Tests/typecheck/build/audit/diff-check зелёные.
- Миграции и rollback проверены применимыми executable gates.
- PR/CI проверены по exact head SHA.
- При production scope подтверждены live release/runtime/API/DB/provider evidence и scoped cleanup.
- Kanban содержит короткие ссылки на PR/CI/evidence, а durable contract отражён в Basic Memory/repo docs.
- Paid traffic/Direct — отдельный owner-approved gate; технический GO не запускает рекламу автоматически.
