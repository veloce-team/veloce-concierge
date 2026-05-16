import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdempotencyStore } from '../src/services/idempotency/store.js';
import type { Lead } from '../src/schema/lead.js';

const TTL = 60_000;
const HERE = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const db = new Database(':memory:');
  const sql = readFileSync(
    join(HERE, '..', 'src/services/sessions/migrations/001-init.sql'),
    'utf8',
  );
  db.exec(sql);
  return db;
}

const lead: Lead = {
  name: 'Иван',
  email: 'i@example.com',
  phone: '+79991234567',
  message: 'Длинное сообщение для теста',
  source: 'veloce_site',
  channel: 'form',
};

describe('IdempotencyStore', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it('returns null when no entry', () => {
    const store = createIdempotencyStore(db, TTL);
    expect(store.lookup(store.hash(lead), Date.now())).toBe(null);
  });

  it('returns cached response within TTL', () => {
    const store = createIdempotencyStore(db, TTL);
    const key = store.hash(lead);
    const now = Date.now();
    store.remember(key, '{"status":"received","ref":"abc"}', now);
    const hit = store.lookup(key, now + 30_000);
    expect(hit).not.toBeNull();
    expect(hit!.responseJson).toBe('{"status":"received","ref":"abc"}');
  });

  it('returns null after TTL expires', () => {
    const store = createIdempotencyStore(db, TTL);
    const key = store.hash(lead);
    const now = Date.now();
    store.remember(key, '{}', now);
    expect(store.lookup(key, now + TTL + 1)).toBe(null);
  });

  it('hash is deterministic and case-insensitive on email', () => {
    const store = createIdempotencyStore(db, TTL);
    const a = store.hash({ ...lead, email: 'i@example.com' });
    const b = store.hash({ ...lead, email: 'I@Example.com' });
    expect(a).toBe(b);
  });

  it('hash differs when message changes', () => {
    const store = createIdempotencyStore(db, TTL);
    const a = store.hash(lead);
    const b = store.hash({ ...lead, message: 'Другое сообщение для теста' });
    expect(a).not.toBe(b);
  });
});
