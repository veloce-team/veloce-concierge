import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function startCleanupJob(
  db: Db,
  logger: Logger,
  idempotencyTtlMs: number,
): { stop: () => void } {
  const cleanIdempotency = db.prepare(
    `DELETE FROM idempotency WHERE created_at < ?`,
  );
  const cleanOutbox = db.prepare(
    `DELETE FROM outbox WHERE status IN ('sent','failed') AND created_at < ?`,
  );

  function tick(): void {
    const now = Date.now();
    try {
      const idemRes = cleanIdempotency.run(now - idempotencyTtlMs);
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

  const timer = setInterval(tick, MINUTE_MS);
  return { stop: () => clearInterval(timer) };
}
