import Database, { type Database as Db } from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIRNAME = 'migrations';

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

function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, MIGRATIONS_DIRNAME);
}
