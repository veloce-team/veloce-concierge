import type { Database as Db } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type {
  AnalyticsDeal,
  AnalyticsState,
  AnalyticsTransition,
  YandexOrder,
} from './semantic.js';

const CLEAN_REFRESH_MS = 86_400_000;

export type YandexOutboxStatus =
  | 'dirty'
  | 'sending'
  | 'accepted'
  | 'clean'
  | 'retry'
  | 'dead'
  | 'unmatchable'
  | 'suppressed'
  | 'held';

export type YandexOutboxRecord = {
  id: number;
  portalId: string;
  dealId: string;
  orderId: string;
  payload: YandexOrder;
  payloadHash: string;
  status: YandexOutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  uploadId: string | null;
  acceptedAt: number | null;
  reconcileCursor: string | null;
  lastError: string | null;
};

export type DeliveryOutcome =
  | 'accepted'
  | 'retry'
  | 'dead'
  | 'unmatchable'
  | 'dirty'
  | 'suppressed'
  | 'held'
  | 'ignored';

export type AnalyticsRepository = {
  getState(portalId: string, dealId: string): AnalyticsState;
  applyTransition(
    deal: AnalyticsDeal,
    transition: AnalyticsTransition,
  ): { eventCount: number; outboxCreated: boolean };
  claimDue(now: number, limit?: number, _unusedLeaseMs?: number): YandexOutboxRecord[];
  markAccepted(id: number, uploadId: string, now: number): DeliveryOutcome;
  listAccepted(): YandexOutboxRecord[];
  setReconcileCursor(id: number, cursor: string | null, now: number): void;
  markProcessed(id: number, now: number): void;
  markRetry(id: number, error: string, nextAttemptAt: number): DeliveryOutcome;
  markDead(id: number, error: string): DeliveryOutcome;
  markUnmatchable(id: number, error: string): DeliveryOutcome;
  hasProcessedOrder(orderId: string): boolean;
  countByStatus(): Record<string, number>;
};

function payloadHash(order: YandexOrder): string {
  return createHash('sha256').update(JSON.stringify(order)).digest('hex');
}

const OUTBOX_SELECT = `
  SELECT id, portal_id AS portalId, deal_id AS dealId, order_id AS orderId,
         desired_payload_json AS desiredPayloadJson,
         desired_payload_hash AS desiredPayloadHash,
         inflight_payload_json AS inflightPayloadJson,
         inflight_payload_hash AS inflightPayloadHash,
         status, attempts, next_attempt_at AS nextAttemptAt,
         upload_id AS uploadId, accepted_at AS acceptedAt,
         reconcile_cursor AS reconcileCursor, last_error AS lastError
    FROM yandex_outbox`;

function mapOutbox(row: Record<string, unknown>): YandexOutboxRecord {
  const payloadJson = row.inflightPayloadJson ?? row.desiredPayloadJson;
  const hash = row.inflightPayloadHash ?? row.desiredPayloadHash;
  if (payloadJson == null || hash == null) throw new Error(`outbox ${String(row.id)} has no deliverable payload`);
  return {
    id: Number(row.id),
    portalId: String(row.portalId),
    dealId: String(row.dealId),
    orderId: String(row.orderId),
    payload: JSON.parse(String(payloadJson)) as YandexOrder,
    payloadHash: String(hash),
    status: String(row.status) as YandexOutboxStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.nextAttemptAt),
    uploadId: row.uploadId == null ? null : String(row.uploadId),
    acceptedAt: row.acceptedAt == null ? null : Number(row.acceptedAt),
    reconcileCursor: row.reconcileCursor == null ? null : String(row.reconcileCursor),
    lastError: row.lastError == null ? null : String(row.lastError),
  };
}

export function createAnalyticsRepository(
  db: Db,
  clock: () => number = () => Date.now(),
): AnalyticsRepository {
  const selectState = db.prepare(`
    SELECT portal_id AS portalId, deal_id AS dealId,
           qualified_at AS qualifiedAt, signed_at AS signedAt,
           signed_revenue AS signedRevenue, signed_currency AS signedCurrency,
           won_at AS wonAt, cancelled_at AS cancelledAt,
           last_payload_hash AS lastPayloadHash, payload_revision AS payloadRevision
      FROM crm_deal_state WHERE portal_id=? AND deal_id=?`);
  const upsertState = db.prepare(`
    INSERT INTO crm_deal_state
      (portal_id, deal_id, category_id, stage_id, modified_at,
       qualified_at, signed_at, signed_revenue, signed_currency, won_at, cancelled_at,
       last_payload_hash, payload_revision, updated_at)
    VALUES
      (@portalId, @dealId, @categoryId, @stageId, @modifiedAt,
       @qualifiedAt, @signedAt, @signedRevenue, @signedCurrency, @wonAt, @cancelledAt,
       @lastPayloadHash, @payloadRevision, @updatedAt)
    ON CONFLICT(portal_id, deal_id) DO UPDATE SET
      category_id=excluded.category_id,
      stage_id=excluded.stage_id,
      modified_at=excluded.modified_at,
      qualified_at=COALESCE(crm_deal_state.qualified_at, excluded.qualified_at),
      signed_at=COALESCE(crm_deal_state.signed_at, excluded.signed_at),
      signed_revenue=excluded.signed_revenue,
      signed_currency=excluded.signed_currency,
      won_at=COALESCE(crm_deal_state.won_at, excluded.won_at),
      cancelled_at=excluded.cancelled_at,
      last_payload_hash=excluded.last_payload_hash,
      payload_revision=excluded.payload_revision,
      updated_at=excluded.updated_at`);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO analytics_events
      (portal_id, deal_id, event_type, contract_version, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const selectByOrder = db.prepare(`${OUTBOX_SELECT} WHERE order_id=?`);
  const selectOne = db.prepare(`${OUTBOX_SELECT} WHERE id=?`);

  // A single-instance restart makes every persisted `sending` row orphaned.
  // Rows whose desired payload was intentionally cleared must converge to the
  // durable hold/suppression state instead of remaining unclaimable forever.
  db.prepare(`UPDATE yandex_outbox SET
      status=CASE
        WHEN last_error='delivery_hold:invalid_current_contract_value' THEN 'held'
        ELSE 'suppressed'
      END,
      inflight_payload_json=NULL, inflight_payload_hash=NULL,
      upload_id=NULL, accepted_at=NULL, reconcile_cursor=NULL,
      updated_at=?
    WHERE status='sending' AND desired_payload_hash IS NULL`).run(clock());

  function desiredOutcome(id: number, terminal: 'retry' | 'dead' | 'unmatchable', error: string, nextAttemptAt?: number): DeliveryOutcome {
    return db.transaction(() => {
      const row = selectOne.get(id) as Record<string, unknown> | undefined;
      if (!row || !['sending', 'accepted'].includes(String(row.status))) return 'ignored';
      const desiredHash = row.desiredPayloadHash == null ? null : String(row.desiredPayloadHash);
      const inflightHash = row.inflightPayloadHash == null ? null : String(row.inflightPayloadHash);
      const status: DeliveryOutcome = desiredHash == null
        ? row.lastError === 'delivery_hold:invalid_current_contract_value' ? 'held' : 'suppressed'
        : desiredHash !== inflightHash
          ? 'dirty'
          : terminal;
      db.prepare(`UPDATE yandex_outbox SET
          status=@status,
          inflight_payload_json=NULL, inflight_payload_hash=NULL,
          upload_id=NULL, accepted_at=NULL, reconcile_cursor=NULL,
          last_error=@error, next_attempt_at=@nextAttemptAt, updated_at=@updatedAt
        WHERE id=@id`).run({
        id,
        status,
        error,
        nextAttemptAt: status === 'retry' ? nextAttemptAt ?? clock() : clock(),
        updatedAt: clock(),
      });
      return status;
    })();
  }

  return {
    getState(portalId, dealId) {
      const row = selectState.get(portalId, dealId) as AnalyticsState | undefined;
      return row ?? {
        portalId,
        dealId,
        qualifiedAt: null,
        signedAt: null,
        signedRevenue: null,
        signedCurrency: null,
        wonAt: null,
        cancelledAt: null,
        lastPayloadHash: null,
        payloadRevision: 0,
      };
    },

    applyTransition(deal, transition) {
      return db.transaction(() => {
        const now = clock();
        const current = selectState.get(deal.portalId, deal.dealId) as AnalyticsState | undefined;
        const desiredHash = transition.order ? payloadHash(transition.order) : null;
        const priorHash = current?.lastPayloadHash ?? null;
        const deliveryChanged = desiredHash !== priorHash || (transition.suppressDelivery && priorHash != null);
        const nextRevision = (current?.payloadRevision ?? 0) + (deliveryChanged ? 1 : 0);
        upsertState.run({
          ...transition.nextState,
          categoryId: deal.categoryId,
          stageId: deal.stageId,
          modifiedAt: deal.modifiedAt,
          lastPayloadHash: transition.suppressDelivery || transition.holdDelivery
            ? null
            : desiredHash ?? priorHash,
          payloadRevision: nextRevision,
          updatedAt: now,
        });
        let eventCount = 0;
        for (const event of transition.events) {
          eventCount += insertEvent.run(
            deal.portalId,
            deal.dealId,
            event.type,
            event.contractVersion,
            event.occurredAt,
            now,
          ).changes;
        }

        const orderId = transition.order?.id ?? `b24:${deal.portalId}:deal:${deal.dealId}`;
        const existing = selectByOrder.get(orderId) as Record<string, unknown> | undefined;
        if (transition.suppressDelivery || transition.holdDelivery) {
          const blockedStatus = transition.holdDelivery ? 'held' : 'suppressed';
          const marker = transition.holdDelivery
            ? 'delivery_hold:invalid_current_contract_value'
            : 'delivery_suppressed';
          if (existing) {
            const inFlight = ['sending', 'accepted'].includes(String(existing.status));
            db.prepare(`UPDATE yandex_outbox SET
                desired_payload_json=NULL, desired_payload_hash=NULL,
                status=?, last_error=?, updated_at=?
              WHERE order_id=?`).run(inFlight ? existing.status : blockedStatus, marker, now, orderId);
          } else if (transition.holdDelivery) {
            db.prepare(`INSERT INTO yandex_outbox
              (portal_id, deal_id, order_id, desired_payload_json, desired_payload_hash,
               status, attempts, next_attempt_at, last_error, created_at, updated_at)
              VALUES (?, ?, ?, NULL, NULL, 'held', 0, ?, ?, ?, ?)`).run(
              deal.portalId, deal.dealId, orderId, now, marker, now, now,
            );
          }
          return { eventCount, outboxCreated: !existing && Boolean(transition.holdDelivery) };
        }
        if (!transition.order || desiredHash == null) return { eventCount, outboxCreated: false };
        if (existing && String(existing.desiredPayloadHash) === desiredHash) {
          return { eventCount, outboxCreated: false };
        }
        const payloadJson = JSON.stringify(transition.order);
        if (!existing) {
          db.prepare(`INSERT INTO yandex_outbox
            (portal_id, deal_id, order_id, desired_payload_json, desired_payload_hash,
             status, attempts, next_attempt_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'dirty', 0, ?, ?, ?)`).run(
            deal.portalId, deal.dealId, orderId, payloadJson, desiredHash, now, now, now,
          );
        } else {
          const inFlight = ['sending', 'accepted'].includes(String(existing.status));
          db.prepare(`UPDATE yandex_outbox SET
              desired_payload_json=?, desired_payload_hash=?,
              status=?, attempts=CASE WHEN ? THEN attempts ELSE 0 END,
              next_attempt_at=?, last_error=NULL, updated_at=?
            WHERE order_id=?`).run(
            payloadJson, desiredHash, inFlight ? existing.status : 'dirty', inFlight ? 1 : 0,
            now, now, orderId,
          );
        }
        return { eventCount, outboxCreated: true };
      })();
    },

    claimDue(now, limit = 10) {
      return db.transaction(() => {
        const rows = db.prepare(`${OUTBOX_SELECT}
          WHERE desired_payload_hash IS NOT NULL AND (
            status='dirty' OR status='sending' OR
            (status IN ('retry','clean') AND next_attempt_at<=@now)
          ) ORDER BY next_attempt_at, id LIMIT @limit`).all({ now, limit }) as Array<Record<string, unknown>>;
        const claimed: YandexOutboxRecord[] = [];
        for (const row of rows) {
          const changed = db.prepare(`UPDATE yandex_outbox SET
              status='sending', inflight_payload_json=desired_payload_json,
              inflight_payload_hash=desired_payload_hash, attempts=attempts+1,
              upload_id=NULL, accepted_at=NULL, reconcile_cursor=NULL,
              updated_at=@now
            WHERE id=@id AND desired_payload_hash IS NOT NULL AND (
              status='dirty' OR status='sending' OR
            (status IN ('retry','clean') AND next_attempt_at<=@now)
            )`).run({ id: row.id, now }).changes;
          if (changed !== 1) continue;
          const updated = selectOne.get(row.id) as Record<string, unknown>;
          claimed.push(mapOutbox(updated));
        }
        return claimed;
      })();
    },

    markAccepted(id, uploadId, now) {
      const changed = db.prepare(`UPDATE yandex_outbox SET status='accepted', upload_id=?,
          accepted_at=?, reconcile_cursor=NULL,
          last_error=CASE WHEN desired_payload_hash IS NULL THEN last_error ELSE NULL END,
          updated_at=?
        WHERE id=? AND status='sending' AND inflight_payload_hash IS NOT NULL`).run(
        uploadId, now, now, id,
      ).changes;
      return changed === 1 ? 'accepted' : 'ignored';
    },

    listAccepted() {
      return (db.prepare(`${OUTBOX_SELECT} WHERE status='accepted' ORDER BY id`).all() as Array<Record<string, unknown>>).map(mapOutbox);
    },

    setReconcileCursor(id, cursor, now) {
      db.prepare(`UPDATE yandex_outbox SET reconcile_cursor=?, updated_at=?
        WHERE id=? AND status='accepted'`).run(cursor, now, id);
    },

    markProcessed(id, now) {
      db.transaction(() => {
        const row = selectOne.get(id) as Record<string, unknown> | undefined;
        if (!row || row.status !== 'accepted') throw new Error(`outbox ${id} is not accepted`);
        const rec = mapOutbox(row);
        db.prepare(`INSERT INTO yandex_order_state
          (order_id, payload_hash, upload_id, processed_at, status, revenue, currency)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(order_id) DO UPDATE SET
            payload_hash=excluded.payload_hash, upload_id=excluded.upload_id,
            processed_at=excluded.processed_at, status=excluded.status,
            revenue=excluded.revenue, currency=excluded.currency`).run(
          rec.orderId, rec.payloadHash, rec.uploadId, now,
          rec.payload.status, rec.payload.revenue, rec.payload.currency,
        );
        const desiredHash = row.desiredPayloadHash == null ? null : String(row.desiredPayloadHash);
        const nextStatus = desiredHash == null
          ? row.lastError === 'delivery_hold:invalid_current_contract_value' ? 'held' : 'suppressed'
          : desiredHash === rec.payloadHash
            ? 'clean'
            : 'dirty';
        db.prepare(`UPDATE yandex_outbox SET status=?, inflight_payload_json=NULL,
            inflight_payload_hash=NULL, upload_id=NULL, accepted_at=NULL,
            reconcile_cursor=NULL, last_error=NULL, processed_at=?,
            next_attempt_at=?, updated_at=? WHERE id=?`).run(
          nextStatus, now, now + CLEAN_REFRESH_MS, now, id,
        );
      })();
    },

    markRetry(id, error, nextAttemptAt) {
      return desiredOutcome(id, 'retry', error, nextAttemptAt);
    },

    markDead(id, error) {
      return desiredOutcome(id, 'dead', error);
    },

    markUnmatchable(id, error) {
      return desiredOutcome(id, 'unmatchable', error);
    },

    hasProcessedOrder(orderId) {
      return db.prepare('SELECT 1 FROM yandex_order_state WHERE order_id=?').get(orderId) != null;
    },

    countByStatus() {
      const counts: Record<string, number> = {};
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM yandex_outbox GROUP BY status').all() as Array<{ status: string; n: number }>;
      for (const row of rows) counts[row.status] = row.n;
      return counts;
    },
  };
}
