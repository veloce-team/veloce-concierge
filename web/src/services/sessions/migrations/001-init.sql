-- 001-init.sql — schema for web microservice: idempotency + outbox.

CREATE TABLE IF NOT EXISTS idempotency (
    key           TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency(created_at);

CREATE TABLE IF NOT EXISTS outbox (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    payload          TEXT NOT NULL,
    target           TEXT NOT NULL,
    status           TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    next_attempt_at  INTEGER NOT NULL,
    sent_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox(status, next_attempt_at);
