import type { Database as Db } from 'better-sqlite3';
import type { DialogContext, Platform, SessionStore } from '../../core/dialog/types.js';

export function createSessionStore(db: Db): SessionStore {
  const upsertStmt = db.prepare(
    `INSERT INTO sessions (chat_id, platform, state, updated_at)
     VALUES (@chat_id, @platform, @state, @updated_at)
     ON CONFLICT(chat_id, platform) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at`,
  );
  const loadStmt = db.prepare(
    `SELECT state FROM sessions WHERE chat_id = ? AND platform = ?`,
  );
  const idemStmt = db.prepare(
    `INSERT OR IGNORE INTO idempotency (platform, update_id, processed_at)
     VALUES (?, ?, ?)`,
  );
  const countActiveStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM sessions`,
  );

  return {
    load(platform, chatId) {
      const row = loadStmt.get(chatId, platform) as { state: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.state) as DialogContext;
      } catch {
        return null;
      }
    },
    save(platform, chatId, ctx) {
      upsertStmt.run({
        chat_id: chatId,
        platform,
        state: JSON.stringify(ctx),
        updated_at: Date.now(),
      });
    },
    markProcessed(platform: Platform, updateId: string): boolean {
      const info = idemStmt.run(platform, updateId, Date.now());
      return info.changes > 0;
    },
    countActive(): number {
      const row = countActiveStmt.get() as { n: number };
      return row.n;
    },
  };
}
