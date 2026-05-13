import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function startCleanupJob(db: Db, logger: Logger): { stop: () => void } {
  const cleanIdempotency = db.prepare(
    `DELETE FROM idempotency WHERE processed_at < ?`,
  );
  const cleanOutbox = db.prepare(
    `DELETE FROM outbox WHERE status IN ('sent','failed') AND created_at < ?`,
  );

  function tick(): void {
    const now = Date.now();
    try {
      const idemRes = cleanIdempotency.run(now - DAY_MS);
      const outRes = cleanOutbox.run(now - 7 * DAY_MS);
      if (idemRes.changes > 0 || outRes.changes > 0) {
        logger.info(
          {
            idempotency_removed: idemRes.changes,
            outbox_removed: outRes.changes,
          },
          'cleanup: rows pruned',
        );
      }
    } catch (err) {
      logger.error({ err }, 'cleanup: failed');
    }
  }

  // first run after one hour, then hourly
  const timer = setInterval(tick, HOUR_MS);
  return { stop: () => clearInterval(timer) };
}
