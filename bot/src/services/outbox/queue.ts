import type { Database as Db } from 'better-sqlite3';
import type { CrmPayload } from '../../core/dialog/types.js';

export type OutboxStatus = 'pending' | 'sent' | 'failed';

export type OutboxRecord = {
  id: number;
  payload: CrmPayload;
  target: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  nextAttemptAt: number;
  sentAt: number | null;
};

export interface OutboxQueue {
  enqueue(payload: CrmPayload, target?: string): number;
  claimDue(now: number, limit?: number): OutboxRecord[];
  markSent(id: number, payloadUpdate: CrmPayload, sentAt: number): void;
  markFailed(id: number, error: string, payloadUpdate?: CrmPayload): void;
  bumpAttempt(
    id: number,
    nextAttemptAt: number,
    lastError: string,
    payloadUpdate?: CrmPayload,
  ): void;
  countPending(): number;
  countSentSince(timestamp: number): number;
}

export function createOutboxQueue(
  db: Db,
  now: () => number = () => Date.now(),
): OutboxQueue {
  const insertStmt = db.prepare(
    `INSERT INTO outbox (payload, target, status, attempts, created_at, next_attempt_at)
     VALUES (@payload, @target, 'pending', 0, @now, @now)`,
  );
  const claimStmt = db.prepare(
    `SELECT id, payload, target, status, attempts, last_error AS lastError,
            created_at AS createdAt, next_attempt_at AS nextAttemptAt, sent_at AS sentAt
       FROM outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT ?`,
  );
  const markSentStmt = db.prepare(
    `UPDATE outbox SET status = 'sent', payload = @payload, sent_at = @sentAt
      WHERE id = @id`,
  );
  const markFailedStmt = db.prepare(
    `UPDATE outbox SET status = 'failed', payload = @payload, last_error = @lastError
      WHERE id = @id`,
  );
  const bumpStmt = db.prepare(
    `UPDATE outbox
        SET attempts = attempts + 1,
            next_attempt_at = @nextAttemptAt,
            last_error = @lastError,
            payload = @payload
      WHERE id = @id`,
  );
  const pendingCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`,
  );
  const sentSinceStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent' AND sent_at >= ?`,
  );

  return {
    enqueue(payload, target = 'bitrix24') {
      const info = insertStmt.run({
        payload: JSON.stringify(payload),
        target,
        now: now(),
      });
      return Number(info.lastInsertRowid);
    },
    claimDue(now, limit = 10) {
      const rows = claimStmt.all(now, limit) as Array<
        Omit<OutboxRecord, 'payload'> & { payload: string }
      >;
      return rows.map((row) => ({
        ...row,
        payload: JSON.parse(row.payload) as CrmPayload,
      }));
    },
    markSent(id, payloadUpdate, sentAt) {
      markSentStmt.run({
        id,
        payload: JSON.stringify(payloadUpdate),
        sentAt,
      });
    },
    markFailed(id, error, payloadUpdate) {
      markFailedStmt.run({
        id,
        payload: JSON.stringify(payloadUpdate ?? {}),
        lastError: error,
      });
    },
    bumpAttempt(id, nextAttemptAt, lastError, payloadUpdate) {
      bumpStmt.run({
        id,
        nextAttemptAt,
        lastError,
        payload: JSON.stringify(payloadUpdate ?? {}),
      });
    },
    countPending() {
      return (pendingCountStmt.get() as { n: number }).n;
    },
    countSentSince(timestamp) {
      return (sentSinceStmt.get(timestamp) as { n: number }).n;
    },
  };
}
