# veloce-concierge

Production monorepo Veloce: shared Caddy/infra, lead intake API, Bitrix24 integrations, offline analytics, Telegram/МАХ bot components and supporting applications.

## Source of truth

- Repository: `veloce-team/veloce-concierge`.
- Production host alias: `timeweb-cm`.
- Current project overview: Basic Memory `05-projects/veloce24/01-context/veloce24 — текущая карта сайта и документации`.
- Operational task state: Hermes Kanban board `veloce24`.
- Secrets: GitHub Actions/VPS env only; never Git, README or Basic Memory.

## Relevant production components

| Component | Purpose | Runtime |
|---|---|---|
| `web/` | strict lead API, CRM delivery, SQLite/outbox, Bitrix24→Yandex offline analytics | `veloce-concierge-web` on TimeWeb |
| `infra/caddy/` | shared production front door for site/API and approved app routes | `veloce-caddy` on TimeWeb |
| `bot/` | Telegram/МАХ Concierge bot | separate bot contour; see `bot/README.md` |
| `waba-pulse/` | WABA pulse tooling | see package README |
| `mini-app/`, `ai-service/` | supporting/prototype packages | not the public site runtime |

The public Astro source lives in the separate repository `AlexBurkovRus/veloce`. Caddy serves its immutable release through `/opt/veloce-team/current`; the removed legacy `/opt/veloce-site` is not a rollback path.

## Public endpoints

| Endpoint | Contract |
|---|---|
| `https://veloce.team/` | Astro production site |
| `POST https://api.veloce.team/api/lead/v1` | current strict veloce.team form contract |
| `POST https://api.veloce.team/api/lead` | compatibility route; not the current site contract |
| `GET https://api.veloce.team/health` | process liveness |
| `GET https://api.veloce.team/ready` | bounded operational readiness, including offline analytics |

See [`web/README.md`](web/README.md) for API behavior and [`web/docs/offline-analytics-contract-v1.md`](web/docs/offline-analytics-contract-v1.md) for the executable analytics contract.

## Production deployment

`web` and Caddy changes use `.github/workflows/web-ci-deploy.yml`:

```text
branch from clean origin/main
→ web tests/typecheck/build
→ PR CI without deploy
→ explicit merge gate
→ immutable /opt/veloce-concierge/releases/<sha>
→ Caddy validation
→ SQLite backup + migration rehearsal + rollback smoke
→ atomic current switch and container promotion
→ schema/integrity/ready/public smoke
```

Do not deploy Concierge with manual `git pull`, manual image replacement or direct production SQLite edits. Caddy is a shared front door; Caddy/compose changes require source review and pipeline validation.

Production layout:

```text
/opt/veloce-concierge/releases/<sha>
/opt/veloce-concierge/current -> releases/<sha>
/opt/veloce-concierge/web/.env          # shared secret env, mode 0600
Docker volume /data/web.sqlite           # runtime state
```

## Local web development

```bash
cd web
cp .env.example .env
npm ci
npm test
npm run typecheck
npm run build
```

Required secrets are documented only by variable name in `web/.env.example` and source contracts.

## Offline analytics status

The worker is production-enabled and uses canonical copied-deal lineage via `UF_CRM_1780724113` (`ID исходной сделки`). It maintains one logical order per root/source deal, updates revenue after `FINAL_INVOICE`, emits `won_deal` at `WON`, suppresses excluded categories and stores no PII in analytics state/outbox/CSV.

On 2026-09-02 the controlled live form→CRM→copied lineage→Yandex qualified/revenue/won E2E passed. External `/ready` monitoring with Telegram `DOWN → RECOVERY` acceptance is active. Technical chain: **GO**; paid traffic: separate owner-approved launch gate.

## Domain policy

`veloce.team` is reserved for the public site and strictly necessary production endpoints. Prototype/internal hosts belong under `maxbot-pro.ru`; do not create experimental `veloce.team` subdomains.

## License

UNLICENSED — internal, see `LICENSE`.
