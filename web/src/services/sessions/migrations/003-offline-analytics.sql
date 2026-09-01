-- Offline analytics v1: CRM milestones and one latest desired Yandex delivery per deal.

CREATE TABLE crm_deal_state (
    portal_id          TEXT NOT NULL,
    deal_id            TEXT NOT NULL,
    category_id        TEXT NOT NULL,
    stage_id           TEXT NOT NULL,
    modified_at        TEXT NOT NULL,
    qualified_at       TEXT,
    signed_at          TEXT,
    signed_revenue     TEXT,
    signed_currency    TEXT,
    won_at             TEXT,
    cancelled_at       TEXT,
    last_payload_hash  TEXT,
    payload_revision   INTEGER NOT NULL DEFAULT 0 CHECK (payload_revision >= 0),
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (portal_id, deal_id)
);

CREATE TABLE analytics_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    portal_id         TEXT NOT NULL,
    deal_id           TEXT NOT NULL,
    event_type        TEXT NOT NULL CHECK (event_type IN ('qualified_lead', 'won_deal')),
    contract_version  INTEGER NOT NULL CHECK (contract_version > 0),
    occurred_at       TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    UNIQUE (portal_id, deal_id, event_type, contract_version),
    FOREIGN KEY (portal_id, deal_id) REFERENCES crm_deal_state(portal_id, deal_id)
);

CREATE TABLE yandex_outbox (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    portal_id             TEXT NOT NULL,
    deal_id               TEXT NOT NULL,
    order_id              TEXT NOT NULL UNIQUE,
    desired_payload_json  TEXT,
    desired_payload_hash  TEXT,
    status                TEXT NOT NULL CHECK (status IN ('dirty','sending','accepted','clean','retry','dead','unmatchable','suppressed','held')),
    inflight_payload_json TEXT,
    inflight_payload_hash TEXT,
    attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at       INTEGER NOT NULL,
    upload_id             TEXT,
    accepted_at           INTEGER,
    reconcile_cursor      TEXT,
    last_error            TEXT,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    processed_at          INTEGER,
    CHECK ((desired_payload_json IS NULL) = (desired_payload_hash IS NULL)),
    CHECK ((inflight_payload_json IS NULL) = (inflight_payload_hash IS NULL)),
    FOREIGN KEY (portal_id, deal_id) REFERENCES crm_deal_state(portal_id, deal_id)
);
CREATE INDEX idx_yandex_outbox_due ON yandex_outbox(status, next_attempt_at);
CREATE INDEX idx_yandex_outbox_upload ON yandex_outbox(upload_id) WHERE upload_id IS NOT NULL;

CREATE TABLE yandex_order_state (
    order_id          TEXT PRIMARY KEY,
    payload_hash      TEXT NOT NULL,
    upload_id         TEXT NOT NULL,
    processed_at      INTEGER NOT NULL,
    status            TEXT NOT NULL,
    revenue           TEXT NOT NULL,
    currency          TEXT NOT NULL
);

CREATE TRIGGER analytics_events_no_update
BEFORE UPDATE ON analytics_events
BEGIN
  SELECT RAISE(ABORT, 'analytics_events are immutable');
END;

CREATE TRIGGER analytics_events_no_delete
BEFORE DELETE ON analytics_events
BEGIN
  SELECT RAISE(ABORT, 'analytics_events are immutable');
END;
