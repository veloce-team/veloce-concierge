import type { Database as Db } from 'better-sqlite3';
import type { CrmPayload } from '../crm/types.js';

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
  leadEventId: string | null;
  crmEntityType: string | null;
  crmEntityId: string | null;
};

export type CrmEntityRef = { type: 'deal'; id: string };

export interface OutboxQueue {
  enqueue(payload: CrmPayload, target?: string): number;
  enqueueV1(payload: CrmPayload, target?: string): { id: number; created: boolean };
  getByLeadEventId(leadEventId: string): OutboxRecord | null;
  claimDue(now: number, limit?: number, leaseMs?: number): OutboxRecord[];
  markSent(
    id: number,
    payloadUpdate: CrmPayload,
    sentAt: number,
    crmEntity?: CrmEntityRef,
  ): void;
  markFailed(id: number, error: string, payloadUpdate?: CrmPayload): void;
  bumpAttempt(
    id: number,
    nextAttemptAt: number,
    lastError: string,
    payloadUpdate?: CrmPayload,
  ): void;
  countPending(): number;
}

export function createOutboxQueue(
  db: Db,
  now: () => number = () => Date.now(),
): OutboxQueue {
  const insertStmt = db.prepare(
    `INSERT INTO outbox (payload, target, status, attempts, created_at, next_attempt_at)
     VALUES (@payload, @target, 'pending', 0, @now, @now)`,
  );
  const insertV1Stmt = db.prepare(
    `INSERT OR IGNORE INTO outbox
       (payload, target, status, attempts, created_at, next_attempt_at, lead_event_id)
     VALUES (@payload, @target, 'pending', 0, @now, @now, @leadEventId)`,
  );
  const selectByLeadEventIdStmt = db.prepare(
    `SELECT id, payload, target, status, attempts, last_error AS lastError,
            created_at AS createdAt, next_attempt_at AS nextAttemptAt, sent_at AS sentAt,
            lead_event_id AS leadEventId, crm_entity_type AS crmEntityType,
            crm_entity_id AS crmEntityId
       FROM outbox
      WHERE lead_event_id = ?`,
  );
  const claimStmt = db.prepare(
    `SELECT id, payload, target, status, attempts, last_error AS lastError,
            created_at AS createdAt, next_attempt_at AS nextAttemptAt, sent_at AS sentAt,
            lead_event_id AS leadEventId, crm_entity_type AS crmEntityType,
            crm_entity_id AS crmEntityId
       FROM outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT ?`,
  );
  const leaseStmt = db.prepare(
    `UPDATE outbox
        SET next_attempt_at = ?
      WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
  );
  const markSentStmt = db.prepare(
    `UPDATE outbox
        SET status = 'sent', payload = @payload, sent_at = @sentAt,
            crm_entity_type = @crmEntityType, crm_entity_id = @crmEntityId
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

  return {
    enqueue(payload, target = 'bitrix24') {
      const info = insertStmt.run({
        payload: JSON.stringify(payload),
        target,
        now: now(),
      });
      return Number(info.lastInsertRowid);
    },
    enqueueV1(payload, target = 'bitrix24') {
      if (!('lead_event_id' in payload) || typeof payload.lead_event_id !== 'string') {
        throw new Error('enqueueV1 requires lead_event_id');
      }
      const info = insertV1Stmt.run({
        payload: JSON.stringify(payload),
        target,
        now: now(),
        leadEventId: payload.lead_event_id,
      });
      const row = selectByLeadEventIdStmt.get(payload.lead_event_id) as
        | (Omit<OutboxRecord, 'payload'> & { payload: string })
        | undefined;
      if (!row) throw new Error('outbox v1 row missing after insert');
      return { id: row.id, created: info.changes === 1 };
    },
    getByLeadEventId(leadEventId) {
      const row = selectByLeadEventIdStmt.get(leadEventId) as
        | (Omit<OutboxRecord, 'payload'> & { payload: string })
        | undefined;
      return row ? { ...row, payload: JSON.parse(row.payload) as CrmPayload } : null;
    },
    claimDue(nowTs, limit = 10, leaseMs = 120_000) {
      return db.transaction(() => {
        const rows = claimStmt.all(nowTs, limit) as Array<
          Omit<OutboxRecord, 'payload'> & { payload: string }
        >;
        const leaseUntil = nowTs + leaseMs;
        const claimed = rows.filter(
          (row) => leaseStmt.run(leaseUntil, row.id, nowTs).changes === 1,
        );
        return claimed.map((row) => ({
          ...row,
          nextAttemptAt: leaseUntil,
          payload: JSON.parse(row.payload) as CrmPayload,
        }));
      })();
    },
    markSent(id, payloadUpdate, sentAt, crmEntity) {
      markSentStmt.run({
        id,
        payload: JSON.stringify(payloadUpdate),
        sentAt,
        crmEntityType: crmEntity?.type ?? null,
        crmEntityId: crmEntity?.id ?? null,
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
  };
}
