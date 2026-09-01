import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['001-init.sql', '002-lead-event-id.sql', '003-offline-analytics.sql'];

const EXACT_COLUMNS = {
  crm_deal_state: [
    'portal_id', 'deal_id', 'category_id', 'stage_id', 'modified_at', 'qualified_at',
    'signed_at', 'signed_revenue', 'signed_currency', 'won_at', 'cancelled_at',
    'last_payload_hash', 'payload_revision', 'updated_at',
  ],
  analytics_events: [
    'id', 'portal_id', 'deal_id', 'event_type', 'contract_version', 'occurred_at', 'created_at',
  ],
  yandex_outbox: [
    'id', 'portal_id', 'deal_id', 'order_id', 'desired_payload_json', 'desired_payload_hash',
    'status', 'inflight_payload_json', 'inflight_payload_hash', 'attempts', 'next_attempt_at',
    'upload_id', 'accepted_at',
    'reconcile_cursor', 'last_error', 'created_at', 'updated_at', 'processed_at',
  ],
  yandex_order_state: [
    'order_id', 'payload_hash', 'upload_id', 'processed_at', 'status', 'revenue', 'currency',
  ],
} as const;

function migratedDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    db.exec(readFileSync(join(HERE, '..', 'src/services/sessions/migrations', migration), 'utf8'));
  }
  db.pragma('user_version = 3');
  return db;
}

describe('offline analytics exact physical SQLite contract', () => {
  it('has the frozen tables and exact ordered columns', () => {
    const db = migratedDb();
    for (const [table, expected] of Object.entries(EXACT_COLUMNS)) {
      const actual = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(({ name }) => name);
      expect(actual, table).toEqual(expected);
    }
    db.close();
  });

  it('has the required indexes, immutable-event triggers and foreign keys', () => {
    const db = migratedDb();
    const objects = db.prepare(`
      SELECT type, name FROM sqlite_schema
      WHERE name LIKE 'idx_yandex_outbox_%' OR name LIKE 'analytics_events_no_%'
      ORDER BY type, name`).all();
    expect(objects).toEqual([
      { type: 'index', name: 'idx_yandex_outbox_due' },

      { type: 'index', name: 'idx_yandex_outbox_upload' },
      { type: 'trigger', name: 'analytics_events_no_delete' },
      { type: 'trigger', name: 'analytics_events_no_update' },
    ]);
    expect(db.pragma('foreign_key_list(analytics_events)')).toEqual([
      expect.objectContaining({ table: 'crm_deal_state', from: 'portal_id', to: 'portal_id' }),
      expect.objectContaining({ table: 'crm_deal_state', from: 'deal_id', to: 'deal_id' }),
    ]);
    expect(db.pragma('foreign_key_list(yandex_outbox)')).toEqual([
      expect.objectContaining({ table: 'crm_deal_state', from: 'portal_id', to: 'portal_id' }),
      expect.objectContaining({ table: 'crm_deal_state', from: 'deal_id', to: 'deal_id' }),
    ]);
    db.close();
  });

  it('freezes the latest-state vocabulary and one-row-per-order identity', () => {
    const db = migratedDb();
    const tableSql = db.prepare(
      `SELECT sql FROM sqlite_schema WHERE type='table' AND name='yandex_outbox'`,
    ).pluck().get() as string;
    expect(tableSql).toContain(
      "status IN ('dirty','sending','accepted','clean','retry','dead','unmatchable','suppressed','held')",
    );
    expect(tableSql).toContain('order_id              TEXT NOT NULL UNIQUE');
    expect(() => db.prepare(`INSERT INTO yandex_outbox
      (portal_id, deal_id, order_id, desired_payload_json, desired_payload_hash, status,
       attempts, next_attempt_at, created_at, updated_at)
      VALUES ('p','d','o','{}','h','unknown',0,0,0,0)`).run()).toThrow();
    db.close();
  });
});
