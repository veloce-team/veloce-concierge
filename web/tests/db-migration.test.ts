import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCurrentSchema, migrateDatabaseFile, openDb } from '../src/services/sessions/db.js';

const roots: string[] = [];
const HERE = dirname(fileURLToPath(import.meta.url));

function seedV3(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  for (const migration of ['001-init.sql', '002-lead-event-id.sql', '003-offline-analytics.sql']) {
    db.exec(readFileSync(join(HERE, '..', 'src/services/sessions/migrations', migration), 'utf8'));
  }
  db.pragma('user_version = 3');
  return db;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('explicit SQLite migration and runtime validation', () => {
  it('migrates a fresh file to the exact current schema and validates integrity', () => {
    const root = mkdtempSync(join(tmpdir(), 'veloce-db-'));
    roots.push(root);
    const path = join(root, 'web.sqlite');
    expect(migrateDatabaseFile(path)).toEqual({ fromVersion: 0, toVersion: 4, integrity: 'ok' });
    const db = openDb(path);
    expect(() => assertCurrentSchema(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    db.close();
  });

  it('rejects a forged current version that is missing required physical tables', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 4');
    expect(() => assertCurrentSchema(db)).toThrow(/missing required table crm_deal_state/);
    db.close();
  });

  it('fails runtime validation on a pre-migration schema', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 2');
    expect(() => assertCurrentSchema(db)).toThrow(/schema version 2.*expected 4/);
    db.close();
  });

  it('upgrades an empty-delivery v3 ledger by clearing rebuildable physical deal snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'veloce-db-'));
    roots.push(root);
    const path = join(root, 'web.sqlite');
    const db = seedV3(path);
    db.prepare(`INSERT INTO crm_deal_state
      (portal_id,deal_id,category_id,stage_id,modified_at,payload_revision,updated_at)
      VALUES ('portal-1','204','6','C6:NEW','2026-09-02T00:30:24Z',0,1)`).run();
    db.close();

    expect(migrateDatabaseFile(path)).toEqual({ fromVersion: 3, toVersion: 4, integrity: 'ok' });
    const migrated = new Database(path, { readonly: true });
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM crm_deal_state').get()).toEqual({ n: 0 });
    migrated.close();
  });

  it('refuses the lineage identity upgrade when a v3 delivery ledger is populated', () => {
    const root = mkdtempSync(join(tmpdir(), 'veloce-db-'));
    roots.push(root);
    const path = join(root, 'web.sqlite');
    const db = seedV3(path);
    db.prepare(`INSERT INTO crm_deal_state
      (portal_id,deal_id,category_id,stage_id,modified_at,payload_revision,updated_at)
      VALUES ('portal-1','204','6','C6:NEW','2026-09-02T00:30:24Z',0,1)`).run();
    db.prepare(`INSERT INTO analytics_events
      (portal_id,deal_id,event_type,contract_version,occurred_at,created_at)
      VALUES ('portal-1','204','qualified_lead',1,'2026-09-02T00:30:24Z',1)`).run();
    db.close();

    expect(() => migrateDatabaseFile(path)).toThrow(/004-lineage-root.*CHECK constraint failed/);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.pragma('user_version', { simple: true })).toBe(3);
    expect(unchanged.prepare('SELECT COUNT(*) AS n FROM analytics_events').get()).toEqual({ n: 1 });
    unchanged.close();
  });
});
