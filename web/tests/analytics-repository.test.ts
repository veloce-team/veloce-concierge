import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAnalyticsRepository } from '../src/services/analytics/repository.js';
import type { AnalyticsDeal, AnalyticsTransition } from '../src/services/analytics/semantic.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of [
    '001-init.sql', '002-lead-event-id.sql', '003-offline-analytics.sql', '004-lineage-root.sql',
  ]) {
    db.exec(readFileSync(join(HERE, '..', 'src/services/sessions/migrations', migration), 'utf8'));
  }
  return db;
}

const deal: AnalyticsDeal = {
  portalId: 'portal-1',
  dealId: '42',
  sourceDealId: '42',
  contactId: '7',
  categoryId: '2',
  stageId: 'C2:NEW',
  createdAt: '2026-09-01T09:00:00Z',
  modifiedAt: '2026-09-01T10:00:00Z',
  opportunity: '0',
  currencyId: 'RUB',
  ymClientId: '123456789012345678',
};

function transition(revenue = '0'): AnalyticsTransition {
  return {
    nextState: {
      portalId: 'portal-1',
      dealId: '42',
      qualifiedAt: '2026-09-01T10:00:00Z',
      signedAt: revenue === '0' ? null : '2026-09-02T10:00:00Z',
      signedRevenue: null,
      signedCurrency: null,
      wonAt: null,
      cancelledAt: null,
      lastPayloadHash: null,
      payloadRevision: 0,
    },
    events: [{ type: 'qualified_lead', occurredAt: '2026-09-01T10:00:00Z', contractVersion: 1 }],
    order: {
      id: 'b24:portal-1:deal:42',
      createDateTime: '2026-09-01T10:00:00Z',
      clientUniqId: 'b24:portal-1:contact:7',
      clientIds: '123456789012345678',
      status: 'qualified_lead',
      revenue,
      currency: 'RUB',
    },
    suppressDelivery: false,
    alerts: [],
  };
}

describe('analytics repository transaction and idempotency', () => {
  it('atomically persists one semantic event and one logical payload', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);

    expect(repository.applyTransition(deal, transition())).toEqual({ eventCount: 1, outboxCreated: true });
    expect(repository.applyTransition(deal, transition())).toEqual({ eventCount: 0, outboxCreated: false });

    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM yandex_outbox').get()).toEqual({ n: 1 });
    expect(repository.getState('portal-1', '42')).toMatchObject({
      qualifiedAt: '2026-09-01T10:00:00Z',
    });
  });

  it('keeps one latest desired delivery when revenue changes on the same order', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition());
    repository.applyTransition({ ...deal, stageId: 'C2:FINAL_INVOICE', opportunity: '150000' }, transition('150000'));

    const rows = db.prepare('SELECT order_id AS orderId, desired_payload_json AS payload, status FROM yandex_outbox').all() as Array<{ orderId: string; payload: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBe('b24:portal-1:deal:42');
    expect(JSON.parse(rows[0]!.payload).revenue).toBe('150000');
    expect(rows[0]!.status).toBe('dirty');
  });

  it('collapses payload A → B → A into one current desired row', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition('0'));
    repository.applyTransition({ ...deal, opportunity: '1' }, transition('1'));
    repository.applyTransition(deal, transition('0'));

    expect(db.prepare(`SELECT status, json_extract(desired_payload_json, '$.revenue') AS revenue
      FROM yandex_outbox`).all()).toEqual([{ status: 'dirty', revenue: '0' }]);
  });

  it('does not overtake an accepted payload and delivers the latest desired value afterwards', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition('0'));
    const [first] = repository.claimDue(1_000);
    repository.markAccepted(first!.id, 'upload-1', 1_100);
    repository.applyTransition({ ...deal, opportunity: '1' }, transition('1'));

    expect(repository.claimDue(2_000)).toEqual([]);
    repository.markProcessed(first!.id, 2_100);
    expect(repository.claimDue(2_100)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ revenue: '1' }) }),
    ]);
  });

  it('replaces an older retry with the latest desired payload', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition('0'));
    const [first] = repository.claimDue(1_000);
    repository.markRetry(first!.id, 'temporary', 5_000);
    repository.applyTransition({ ...deal, opportunity: '1' }, transition('1'));

    expect(repository.claimDue(1_000)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ revenue: '1' }) }),
    ]);
    expect(repository.countByStatus()).toMatchObject({ sending: 1 });
  });

  it('keeps a newer desired payload dirty after an older in-flight result', () => {
    for (const outcome of ['retry', 'accepted'] as const) {
      const db = makeDb();
      const repository = createAnalyticsRepository(db, () => 1_000);
      repository.applyTransition(deal, transition('0'));
      const [first] = repository.claimDue(1_000);
      repository.applyTransition({ ...deal, opportunity: '1' }, transition('1'));

      const result = outcome === 'retry'
        ? repository.markRetry(first!.id, 'temporary', 5_000)
        : repository.markAccepted(first!.id, 'upload-stale', 1_100);
      expect(result).toBe(outcome === 'retry' ? 'dirty' : 'accepted');
      if (outcome === 'accepted') repository.markProcessed(first!.id, 1_100);
      expect(repository.claimDue(1_100)).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ revenue: '1' }) }),
      ]);
      db.close();
    }
  });

  it('stores one suppressed current row for an excluded category', () => {
    for (const leased of [false, true]) {
      const db = makeDb();
      const repository = createAnalyticsRepository(db, () => 1_000);
      repository.applyTransition(deal, transition('0'));
      const first = leased ? repository.claimDue(1_000)[0] : null;
      repository.applyTransition(
        { ...deal, categoryId: '10', stageId: 'C10:WON' },
        { ...transition('0'), order: null, events: [], suppressDelivery: true },
      );

      if (first) {
        const restarted = createAnalyticsRepository(db, () => 2_000);
        expect(restarted.countByStatus()).toMatchObject({ suppressed: 1 });
        expect(repository.markRetry(first.id, 'late failure', 5_000)).toBe('ignored');
      }
      expect(repository.claimDue(10_000)).toEqual([]);
      expect(repository.countByStatus()).toMatchObject({ suppressed: 1 });
      db.close();
    }
  });

  it('durably holds stale desired revenue until a valid current amount returns', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition('100'));
    const [first] = repository.claimDue(1_000);
    repository.markAccepted(first!.id, 'upload-1', 1_100);
    repository.markProcessed(first!.id, 1_200);

    repository.applyTransition(
      { ...deal, opportunity: '1e3' },
      { ...transition('100'), order: null, events: [], holdDelivery: true },
    );

    expect(repository.claimDue(100_000_000)).toEqual([]);
    expect(repository.countByStatus()).toMatchObject({ held: 1 });

    repository.applyTransition({ ...deal, opportunity: '250' }, transition('250'));
    expect(repository.claimDue(100_000_000)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ revenue: '250' }) }),
    ]);
    db.close();
  });

  it('finishes reconciliation for an accepted upload before entering the durable hold', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition('100'));
    const [first] = repository.claimDue(1_000);

    repository.applyTransition(
      { ...deal, opportunity: '1e3' },
      { ...transition('100'), order: null, events: [], holdDelivery: true },
    );

    expect(repository.markAccepted(first!.id, 'upload-1', 1_100)).toBe('accepted');
    expect(repository.listAccepted()).toHaveLength(1);
    repository.markProcessed(first!.id, 1_200);
    expect(repository.countByStatus()).toMatchObject({ held: 1 });
    expect(repository.claimDue(100_000_000)).toEqual([]);
    db.close();
  });

  it('persists the reconciliation cursor for accepted uploads', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition('0'));
    const [first] = repository.claimDue(1_000);
    repository.markAccepted(first!.id, 'upload-1', 1_100);
    repository.setReconcileCursor(first!.id, '2026-09-01 12:00:00', 1_200);
    expect(repository.listAccepted()).toEqual([
      expect.objectContaining({ id: first!.id, reconcileCursor: '2026-09-01 12:00:00' }),
    ]);
    db.close();
  });

  it('stores no lead PII in analytics state, events or outbox payload', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition({
      ...deal,
      email: 'mail@example.com',
      phone: '+79999991111',
      name: 'Иван',
    } as AnalyticsDeal & Record<string, unknown>, transition());
    const dump = db.serialize().toString('utf8');
    expect(dump).not.toContain('mail@example.com');
    expect(dump).not.toContain('+79999991111');
    expect(dump).not.toContain('Иван');
  });

  it('replays an interrupted sending payload after process restart', () => {
    const db = makeDb();
    const first = createAnalyticsRepository(db, () => 1_000);
    first.applyTransition(deal, transition());

    expect(first.claimDue(1_000)).toHaveLength(1);
    const restarted = createAnalyticsRepository(db, () => 2_000);
    expect(restarted.claimDue(2_000)).toHaveLength(1);
  });

  it('periodically refreshes the current clean payload for eventual convergence', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition());
    const [first] = repository.claimDue(1_000);
    repository.markAccepted(first!.id, 'upload-1', 1_100);
    repository.markProcessed(first!.id, 2_000);

    expect(repository.claimDue(86_401_999)).toEqual([]);
    expect(repository.claimDue(86_402_000)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ revenue: '0' }) }),
    ]);
    db.close();
  });

  it('tracks accepted, processed, retry and dead states explicitly', () => {
    const db = makeDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(deal, transition());
    repository.claimDue(1_000);
    repository.markAccepted(1, 'upload-1', 2_000);
    expect(repository.listAccepted()).toEqual([expect.objectContaining({ id: 1, uploadId: 'upload-1' })]);
    repository.markProcessed(1, 3_000);
    expect(repository.countByStatus()).toMatchObject({ clean: 1 });

    repository.applyTransition({ ...deal, opportunity: '1' }, transition('1'));
    repository.claimDue(3_000);
    repository.markRetry(1, 'temporary', 4_000);
    expect(repository.claimDue(3_999)).toEqual([]);
    expect(repository.claimDue(4_000)).toHaveLength(1);
    repository.markDead(1, 'permanent');
    expect(repository.countByStatus()).toMatchObject({ dead: 1 });
  });
});
