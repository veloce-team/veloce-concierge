import Database, { type Database as Db } from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIRNAME = 'migrations';
export const CURRENT_SCHEMA_VERSION = 4;

const REQUIRED_SCHEMA: Array<[string, string[]]> = [
  ['crm_deal_state', ['portal_id', 'deal_id', 'category_id', 'stage_id', 'modified_at', 'qualified_at', 'signed_at', 'signed_revenue', 'signed_currency', 'won_at', 'cancelled_at', 'last_payload_hash', 'payload_revision', 'updated_at']],
  ['analytics_events', ['id', 'portal_id', 'deal_id', 'event_type', 'contract_version', 'occurred_at', 'created_at']],
  ['yandex_outbox', ['id', 'portal_id', 'deal_id', 'order_id', 'desired_payload_json', 'desired_payload_hash', 'status', 'inflight_payload_json', 'inflight_payload_hash', 'attempts', 'next_attempt_at', 'upload_id', 'accepted_at', 'reconcile_cursor', 'last_error', 'created_at', 'updated_at', 'processed_at']],
  ['yandex_order_state', ['order_id', 'payload_hash', 'upload_id', 'processed_at', 'status', 'revenue', 'currency']],
  ['idempotency', ['key', 'response_json', 'created_at']],
  ['outbox', ['id', 'payload', 'target', 'status', 'attempts', 'last_error', 'created_at', 'next_attempt_at', 'sent_at', 'lead_event_id', 'crm_entity_type', 'crm_entity_id']],
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Db, migrationsDir?: string): void {
  const dir = migrationsDir ?? defaultMigrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;

  files.forEach((file, idx) => {
    const version = idx + 1;
    if (version <= current) return;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration failed: ${file}: ${(err as Error).message}`);
    }
  });
}

export function assertCurrentSchema(db: Db): void {
  const version = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`unsupported schema version ${version}; expected ${CURRENT_SCHEMA_VERSION}`);
  }
  if (Number(db.pragma('foreign_keys', { simple: true })) !== 1) {
    throw new Error('SQLite foreign_keys enforcement is disabled');
  }
  for (const [table, requiredColumns] of REQUIRED_SCHEMA) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (columns.length === 0) throw new Error(`missing required table ${table}`);
    const actual = new Set(columns.map((column) => column.name));
    const missing = requiredColumns.filter((column) => !actual.has(column));
    if (missing.length > 0) {
      throw new Error(`table ${table} is missing required column(s): ${missing.join(', ')}`);
    }
  }
  for (const trigger of ['analytics_events_no_update', 'analytics_events_no_delete']) {
    const present = db.prepare(`SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?`).get(trigger);
    if (!present) throw new Error(`missing required trigger ${trigger}`);
  }
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`SQLite integrity_check failed: ${String(integrity)}`);
  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error(`SQLite foreign_key_check failed: ${foreignKeyErrors.length} row(s)`);
  }
}

export function migrateDatabaseFile(path: string): {
  fromVersion: number;
  toVersion: number;
  integrity: 'ok';
} {
  const db = openDb(path);
  try {
    const fromVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
    runMigrations(db);
    assertCurrentSchema(db);
    return { fromVersion, toVersion: CURRENT_SCHEMA_VERSION, integrity: 'ok' };
  } finally {
    db.close();
  }
}

function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, MIGRATIONS_DIRNAME);
}
