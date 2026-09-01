# Offline analytics worker — contract v1

Источник acceptance: `memory://staging/staging/05-projects/veloce24/05-technical/veloce-bitrix24-yandex-offline-analytics-design-2026-09-01`.

Статус: executable contract для дочерних реализаций CRM и Yandex. Это не разрешение на deploy, live-записи, платный трафик или изменение Direct-кампаний.

## Границы модулей

| Модуль | Владеет | Не владеет |
|---|---|---|
| `analytics/bitrix.ts` | read-only REST pagination и canonical mapping сделки/истории | семантика KPI, SQLite, Yandex |
| `analytics/semantic.ts` | чистая детерминированная функция CRM facts → state/events/order/alerts | сеть, SQL, retries |
| `analytics/repository.ts` | транзакции, milestones, latest desired delivery и reconciliation cursor | HTTP и бизнес-классификация |
| `analytics/yandex.ts` | CSV, Simple Orders HTTP, upload status pages, goals seam | CRM semantics и durable retry state |
| `analytics/worker.ts` | orchestration, интервалы, backoff, alerts, at-least-once execution | миграции и exactly-once обещания |
| `sessions/db.ts` + migrations | единственный physical schema/migration authority | runtime auto-migration |

Сетевые вызовы выполняются только вне SQLite-транзакций. Обычный runtime принимает только schema version 3; миграция выполняется отдельным deployment gate.

## Конфигурация

Worker выключен по умолчанию. Для `ANALYTICS_ENABLED=true` обязательны:

- `BITRIX24_WEBHOOK_URL` — read-only incoming webhook;
- `BITRIX24_PORTAL_ID` — стабильный Bitrix24 `member_id`, полученный и проверенный до enable;
- `YANDEX_METRIKA_COUNTER_ID`;
- `YANDEX_OAUTH_TOKEN`;
- `ANALYTICS_POLL_INTERVAL_MS` (default 300000);
- `ANALYTICS_UPLOAD_INTERVAL_MS` (default 30000);
- `ANALYTICS_RECONCILE_INTERVAL_MS` (default 60000);
- `ANALYTICS_OUTBOX_ALERT_THRESHOLD` (default 100).

Секреты не входят в payload, SQLite, логи или test fixtures.

## Внутренние форматы

### Canonical Bitrix fact

`AnalyticsDeal` содержит только `portalId`, `dealId`, `contactId`, `categoryId`, `stageId`, `createdAt`, `modifiedAt`, `opportunity`, `currencyId`, `ymClientId`. История — `id`, `categoryId`, `stageId`, `createdAt`. Имя, телефон, email, комментарии и текст заявки запрещены на границе mapping.

### Immutable milestone

```json
{"type":"qualified_lead|won_deal","occurredAt":"ISO-8601 event time","contractVersion":1}
```

Idempotency key: `(portal_id, deal_id, event_type, contract_version)`. Время берётся из `crm.stagehistory.list`, не из poll/upload clock.

### Desired Yandex order

```json
{
  "id":"b24:{portal_id}:deal:{deal_id}",
  "createDateTime":"qualified transition time",
  "clientUniqId":"b24:{portal_id}:contact:{contact_id} or deal fallback",
  "clientIds":"Yandex ClientID",
  "status":"qualified_lead|won_deal|CANCELLED",
  "revenue":"decimal string",
  "currency":"ISO-4217 code"
}
```

PII-поля `emails` и `phones` в CSV всегда пусты. Один order id имеет одну latest desired delivery; A→B→A схлопывается в актуальное A и не создаёт новые заказы.

## Семантика

- `qualified_lead`: только первый исторический переход category `0` → `2|4|6`.
- Category `10` и `12` всегда дают exclusion tombstone и гасят доставку; неизвестная категория fail-closed + alert.
- Повторный выход после возврата в category `0` не создаёт второй milestone.
- Revenue становится активным после исторически подтверждённого `C2|C4|C6:FINAL_INVOICE`, но не снапшотится: на каждом poll используется текущая `OPPORTUNITY + CURRENCY_ID`.
- Изменение суммы обновляет тот же order. Допустима только положительная десятичная строка `digits[.digits]` без пробелов, exponent/hex notation и знака. Невалидная текущая сумма после signing переводит delivery в durable `held`, блокирует stale refresh и снимается следующим валидным poll; выдуманный `0` запрещён.
- `won_deal`: только `C2|C4|C6:WON`; revenue берётся из текущей сделки.
- Loss/cancel обновляет тот же order в `CANCELLED` с revenue `0`.
- Первичная привязка старше 21 дня и update старше 111 дней становятся `UNMATCHABLE_WINDOW_EXPIRED` + alert.

## SQLite physical contract

Schema authority: `src/services/sessions/migrations/003-offline-analytics.sql`, `PRAGMA user_version=3`.

- `crm_deal_state`: canonical snapshot, independent milestone timestamps и текущий payload hash.
- `analytics_events`: immutable milestones, unique semantic key, FK to deal state.
- `yandex_outbox`: одна строка на order id; current desired payload, отдельно in-flight payload, statuses `dirty|sending|accepted|clean|retry|dead|unmatchable|suppressed|held`, attempts, upload id и durable reconciliation cursor.
- `yandex_order_state`: latest terminal processed Yandex state.

`applyTransition` атомарно обновляет state + milestone + latest desired delivery. При crash в `sending` single-instance worker повторяет тот же deterministic order id. Если desired payload изменился во время in-flight upload, он отправляется только после terminal read-back предыдущего upload. Если во время in-flight наступили exclusion или invalid-amount hold, принятый upload завершается read-back, затем строка сходится в `suppressed`/`held`; orphaned `sending` восстанавливается при restart. External delivery остаётся at-least-once; terminal read-back обязателен.

Clean payload планово повторяется раз в сутки. Это простой eventual-convergence механизм на случай, если provider завершил старый upload после более нового вследствие crash между HTTP и локальной фиксацией результата.

Exact physical oracle: `tests/analytics-schema-contract.test.ts`.

## Внешние интерфейсы

### Bitrix24

`BitrixAnalyticsClient`:

- `listTrackedDeals()` → полностью пагинированные tracked deals через `crm.deal.list`;
- `getStageHistory(dealId)` → полностью пагинированный `crm.stagehistory.list`.

Тесты используют injected `fetchImpl`; production URL не вызывается.

### Yandex

`YandexSimpleOrdersClient`:

- `upload(order)` → `POST /cdp/api/v1/counter/{counterId}/data/simple_orders?merge_mode=SAVE&delimiter_type=COMMA`;
- `getUploadStatusPage(uploadId, datetimeCursor)` → одна bounded history page и durable continuation cursor.

`YandexGoalsClient` фиксирует provider-neutral seam `listGoals()` + `createActionGoal(name)` для exact read-back целей `qualified_lead` и `won_deal`. Конкретные endpoint/auth mapping реализует Yandex-модуль по официальному API; создание идемпотентно по имени, конфликт имени/type — terminal error. Accepted upload без terminal `PASSED` не считается доставленным.

Concrete goals mapping: `GET|POST /management/v1/counter/{counterId}/goals`, OAuth header, `type=action` и единственное condition `{type:"exact",url:<goal name>}`. Provisioning сначала читает цели, создаёт только отсутствующие и после любой записи обязательно повторяет полный read-back; совпадение имени с другим type/condition считается terminal conflict.

Одна latest-state строка загружается одним CSV и одним upload id. Worker забирает не более 10 строк за tick; официальный file-size cap 1 GB проверяется до HTTP. HTTP `420`, `429`, `5xx` и transport failures повторяются с durable backoff, остальные `4xx`, malformed/unknown status и неверный `elements_count` terminal. Provider response body и transport exception text не попадают в durable errors/логи; quota exhaustion, backlog/dead rows и attribution-window expiry дают структурированные alerts без payload.

## TDD-матрица

| Контракт | Executable evidence |
|---|---|
| 0→2/4/6 и исключение 10/12 | `analytics-contract-red.test.ts`, `analytics-semantic.test.ts` |
| FINAL_INVOICE value и WON | `analytics-contract-red.test.ts` |
| повторный polling + atomic rollback | `analytics-contract-red.test.ts`, `analytics-repository.test.ts` |
| latest desired state, crash replay, in-flight update | `analytics-contract-red.test.ts`, `analytics-repository.test.ts`, `analytics-lifecycle.test.ts` |
| retries/permanent failures/windows | `analytics-worker.test.ts` |
| Simple Orders CSV/status/cursor, goals/read-back, quotas/size/redaction | `analytics-yandex.test.ts`, `analytics-worker.test.ts` |
| Bitrix pagination/boundary | `analytics-bitrix.test.ts` |
| exact SQLite shape | `analytics-schema-contract.test.ts` |
| PII boundary→persistence | `analytics-contract-red.test.ts` |

Детерминированные fixtures: `tests/fixtures/offline-analytics.ts`.

## Контролируемый E2E (отдельный gate)

1. Preconditions: source/build/tests/deploy gates green; schema migration rehearsed; goals created and exact-read-back; worker limits/alerts enabled; paid traffic remains off.
2. Создать одну явно помеченную test deal с synthetic ClientID, сохранить все созданные CRM IDs.
3. Выполнить 0→2, повторный poll ×10, restart, FINAL_INVOICE, WON и проверить один order id, semantic uniqueness, terminal Yandex read-back и отсутствие PII.
4. В `finally` удалить/закрыть только записанные test IDs, убрать связанные local ledger/outbox rows через отдельную scoped cleanup-команду, затем read-back подтвердить отсутствие тестовых данных.
5. Любая ошибка cleanup — NO-GO и ручная эскалация с точными test IDs. Production rows не редактировать.

Этот документ не выполняет E2E и не разрешает live mutation.
