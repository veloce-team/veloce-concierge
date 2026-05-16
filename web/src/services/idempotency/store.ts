import type { Database as Db } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Lead } from '../../schema/lead.js';

export type IdempotencyHit = {
  responseJson: string;
  createdAt: number;
};

export interface IdempotencyStore {
  hash(lead: Lead): string;
  lookup(key: string, now: number): IdempotencyHit | null;
  remember(key: string, responseJson: string, now: number): void;
  pruneOlderThan(threshold: number): number;
}

export function createIdempotencyStore(db: Db, ttlMs: number): IdempotencyStore {
  const selectStmt = db.prepare(
    `SELECT response_json AS responseJson, created_at AS createdAt
       FROM idempotency
      WHERE key = ?`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO idempotency (key, response_json, created_at)
     VALUES (@key, @responseJson, @createdAt)
     ON CONFLICT(key) DO UPDATE SET
       response_json = excluded.response_json,
       created_at = excluded.created_at`,
  );
  const pruneStmt = db.prepare(`DELETE FROM idempotency WHERE created_at < ?`);

  return {
    hash(lead) {
      const canonical = [
        lead.name.trim().toLowerCase(),
        lead.email.trim().toLowerCase(),
        lead.phone.trim(),
        lead.message.trim(),
      ].join('|');
      return createHash('sha256').update(canonical).digest('hex');
    },
    lookup(key, now) {
      const row = selectStmt.get(key) as IdempotencyHit | undefined;
      if (!row) return null;
      if (now - row.createdAt > ttlMs) return null;
      return row;
    },
    remember(key, responseJson, now) {
      upsertStmt.run({ key, responseJson, createdAt: now });
    },
    pruneOlderThan(threshold) {
      return pruneStmt.run(threshold).changes;
    },
  };
}
