import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCurrentSchema, migrateDatabaseFile, openDb } from '../src/services/sessions/db.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('explicit SQLite migration and runtime validation', () => {
  it('migrates a fresh file to the exact current schema and validates integrity', () => {
    const root = mkdtempSync(join(tmpdir(), 'veloce-db-'));
    roots.push(root);
    const path = join(root, 'web.sqlite');
    expect(migrateDatabaseFile(path)).toEqual({ fromVersion: 0, toVersion: 3, integrity: 'ok' });
    const db = openDb(path);
    expect(() => assertCurrentSchema(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    db.close();
  });

  it('rejects a forged current version that is missing required physical tables', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 3');
    expect(() => assertCurrentSchema(db)).toThrow(/missing required table crm_deal_state/);
    db.close();
  });

  it('fails runtime validation on a pre-migration schema', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 2');
    expect(() => assertCurrentSchema(db)).toThrow(/schema version 2.*expected 3/);
    db.close();
  });
});
