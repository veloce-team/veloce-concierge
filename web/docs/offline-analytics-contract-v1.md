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

Сетевые вызовы выполняются только вне SQLite-транзакций. Обычный runtime принимает только schema version 4; миграция выполняется отдельным deployment gate.

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

`AnalyticsDeal` содержит только `portalId`, physical `dealId`, canonical `sourceDealId`, `contactId`, `categoryId`, `stageId`, `createdAt`, `modifiedAt`, `opportunity`, `currencyId`, `ymClientId`. `sourceDealId` читается из обязательного integer-поля Bitrix24 `UF_CRM_1780724113` (`ID исходной сделки`). История — `id`, `categoryId`, `stageId`, `createdAt`. Имя, телефон, email, комментарии и текст заявки запрещены на границе mapping.

### Immutable milestone

```json
{"type":"qualified_lead|won_deal","occurredAt":"ISO-8601 event time","contractVersion":1}
```

Idempotency key: `(portal_id, source_deal_id, event_type, contract_version)`. В SQLite `deal_id` означает canonical root/source deal ID. Время берётся из объединённой хронологии сделок lineage, не из poll/upload clock.

### Desired Yandex order

```json
{
  "id":"b24:{portal_id}:deal:{source_deal_id}",
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

- Bitrix24 переносит сделку из квалификации копированием: root остаётся в category `0`, а новая physical deal сразу создаётся в `2|4|6`. Worker группирует все physical deals по `(portalId, sourceDealId)` и хранит один logical state/order на root ID. Для qualification history учитываются только category-`0` строки root и working-category строки non-root descendants; interposed excluded/unknown history не меняет первое время квалификации. Актуальной считается newest physical deal по `DATE_CREATE` (tie-break: `DATE_MODIFY`, затем numeric deal ID), и только её stage history определяет signed/won/cancelled status; поэтому root или старая копия не могут переопределить status, а более новая excluded/unknown копия не может оставить активной stale working delivery. Lineage без существующего root или без category-`0` history root fail-closed.
- `qualified_lead`: только первое появление потомка root-сделки category `0` в `2|4|6`; physical target ID не меняет identity заказа.
- Category `10` и `12` всегда дают exclusion tombstone и гасят доставку; неизвестная категория fail-closed + alert.
- Повторный выход после возврата в category `0` не создаёт второй milestone.
- Revenue становится активным после исторически подтверждённого `C2|C4|C6:FINAL_INVOICE`, но не снапшотится: на каждом poll используется текущая `OPPORTUNITY + CURRENCY_ID`.
- Изменение суммы обновляет тот же order. Допустима только положительная десятичная строка `digits[.digits]` без пробелов, exponent/hex notation и знака. Невалидная текущая сумма после signing переводит delivery в durable `held`, блокирует stale refresh и снимается следующим валидным poll; выдуманный `0` запрещён.
- `won_deal`: только `C2|C4|C6:WON`; revenue и currency берутся из актуальной working-funnel physical deal, но обновляют root order.
- Loss/cancel обновляет тот же order в `CANCELLED` с revenue `0`.
- Первичная привязка старше 21 дня и update старше 111 дней становятся `UNMATCHABLE_WINDOW_EXPIRED` + alert.

## SQLite physical contract

Schema authority: `src/services/sessions/migrations/003-offline-analytics.sql` + semantic identity gate `004-lineage-root.sql`, `PRAGMA user_version=4`. Upgrade `3→4` разрешён только при пустых `analytics_events`, `yandex_outbox` и `yandex_order_state`; иначе миграция атомарно fail-closed. Rebuildable physical snapshots `crm_deal_state` очищаются и восстанавливаются следующим Bitrix poll уже по root identity.

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

### Operational readiness and limits

Публичный `GET https://api.veloce.team/ready` содержит только bounded operational state без OAuth/webhook/PII и возвращает `503`, если выполняется хотя бы одно условие:

- последний успешный poll старше 15 минут, upload старше 5 минут или reconciliation старше 10 минут;
- последний завершившийся запуск стадии завершился ошибкой;
- outbox содержит `retry`, `dead` или `unmatchable`, либо deliverable backlog достиг 5 строк;
- текущий poll обнаружил semantic/lineage alert;
- Yandex вернул quota status `420`/`429`.

Ответ ограничен полями `ready`, `status` и `analytics`: фиксированные issue codes, три timestamp последнего успеха, агрегированные counts только известных outbox-статусов и активные limits. Payload, error text, произвольные статусы/коды, идентификаторы, OAuth/webhook и контактные данные отбрасываются на HTTP-границе.

Внешний Uptime Kuma проверяет `/ready` каждые 60 секунд с двумя retries и timeout 15 секунд. Telegram-инцидент принимается только после controlled `DOWN → RECOVERY`; liveness `/health` остаётся независимой проверкой процесса.

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

## Контролируемый E2E и cleanup contract

1. Preconditions: source/build/tests/deploy gates green; migration rehearsed на production snapshot; goals exact-read-back; limits/alerts enabled; paid traffic off.
2. Создать одну явно помеченную test lineage с synthetic attribution и заранее сохранить CRM IDs/identity guards.
3. Провести copy-transition через allowed category, `FINAL_INVOICE` и `WON`; подтвердить один root order, semantic uniqueness, terminal Yandex read-back и отсутствие PII/physical-key leakage.
4. В `finally` удалить только CRM objects, прошедшие exact marker/attribution/lineage/contact guards, и повторным CRM read-back подтвердить их отсутствие.
5. Immutable production analytics ledger/outbox/order evidence после E2E **не удалять и не редактировать вручную**. Оно является audit trail terminal provider delivery. Любая ошибка CRM cleanup — NO-GO и ручная эскалация с точными test IDs.

### Выполненный production E2E — 2026-09-02

- live form → exact CRM attribution → copied lineage `206→208`;
- один order `b24:veloce.bitrix24.ru:deal:206`;
- `qualified_lead → FINAL_INVOICE → won_deal`, revenue `123456.78 RUB`;
- три Yandex uploads: `api_validation_status=PASSED`, один element каждый;
- physical descendant rows: state/event/outbox `0/0/0`;
- test deals/contact удалены по identity guard; immutable analytics evidence сохранено;
- runtime после cleanup: `/ready=true`, issues empty, backlog 0.

Evidence: Kanban `t_c872991c`; sanitized artifact
`/root/review-artifacts/veloce-full-e2e-final-20260902.json`, SHA-256
`c60c3b105435aea76fca0bf5786e508ebe0b2062efeaf18ccdf8449046aaef63`.

Этот документ фиксирует contract/status, но не разрешает новые live mutations,
paid traffic или Direct campaign changes.
