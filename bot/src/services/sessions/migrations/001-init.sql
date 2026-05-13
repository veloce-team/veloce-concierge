-- 001-init.sql — schema for sessions, idempotency, outbox.
-- See block 2a spec section 6.3.

CREATE TABLE IF NOT EXISTS sessions (
    chat_id     TEXT NOT NULL,
    platform    TEXT NOT NULL,
    state       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (chat_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS idempotency (
    platform     TEXT NOT NULL,
    update_id    TEXT NOT NULL,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (platform, update_id)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_processed_at ON idempotency(processed_at);

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
