import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAnalyticsRepository } from '../src/services/analytics/repository.js';
import { deriveAnalyticsTransition } from '../src/services/analytics/semantic.js';
import {
  REQUIRED_YANDEX_GOALS,
  type YandexGoalsClient,
} from '../src/services/analytics/yandex.js';
import {
  analyticsDeal,
  analyticsHistory,
  analyticsState,
  analyticsTransition,
} from './fixtures/offline-analytics.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function migratedDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of [
    '001-init.sql', '002-lead-event-id.sql', '003-offline-analytics.sql', '004-lineage-root.sql',
  ]) {
    db.exec(readFileSync(join(HERE, '..', 'src/services/sessions/migrations', migration), 'utf8'));
  }
  return db;
}

describe('offline analytics acceptance contract (RED for implementation children)', () => {
  it('freezes the provider-neutral goal create/read-back seam', () => {
    const fake: YandexGoalsClient = {
      listGoals: async () => [],
      createActionGoal: async (name) => ({ id: 1, name, type: 'action' }),
    };

    expect(fake).toBeDefined();
    expect(REQUIRED_YANDEX_GOALS).toEqual(['qualified_lead', 'won_deal']);
  });

  it.each(['2', '4', '6'])('qualifies only the explicit 0 → %s category transition', (categoryId) => {
    const transition = deriveAnalyticsTransition(
      analyticsDeal({ categoryId, stageId: `C${categoryId}:NEW` }),
      analyticsHistory(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        [categoryId, `C${categoryId}:NEW`, '2026-09-01T10:00:00Z'],
      ),
      analyticsState(),
    );
    expect(transition.events.map((event) => event.type)).toEqual(['qualified_lead']);
    expect(transition.order).toMatchObject({ status: 'qualified_lead', revenue: '0' });
  });

  it.each(['10', '12'])('never emits an order for excluded category 0 → %s', (categoryId) => {
    const transition = deriveAnalyticsTransition(
      analyticsDeal({ categoryId, stageId: `C${categoryId}:WON` }),
      analyticsHistory(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        [categoryId, `C${categoryId}:WON`, '2026-09-01T10:00:00Z'],
      ),
      analyticsState(),
    );
    expect(transition).toMatchObject({ events: [], order: null, suppressDelivery: true });
  });

  it.each(['2', '4', '6'])('starts current revenue at C%s:FINAL_INVOICE', (categoryId) => {
    const transition = deriveAnalyticsTransition(
      analyticsDeal({
        categoryId,
        stageId: `C${categoryId}:FINAL_INVOICE`,
        opportunity: '150000.50',
      }),
      analyticsHistory(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        [categoryId, `C${categoryId}:FINAL_INVOICE`, '2026-09-02T10:00:00Z'],
      ),
      analyticsState({ qualifiedAt: '2026-09-01T10:00:00Z' }),
    );
    expect(transition.nextState).toMatchObject({
      signedAt: '2026-09-02T10:00:00Z',
      signedRevenue: '150000.50',
      signedCurrency: 'RUB',
    });
    expect(transition.order).toMatchObject({ status: 'qualified_lead', revenue: '150000.50' });
  });

  it('uses current mutable revenue when FINAL_INVOICE is only historical', () => {
    const transition = deriveAnalyticsTransition(
      analyticsDeal({ categoryId: '2', stageId: 'C2:WON', opportunity: '999999' }),
      analyticsHistory(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        ['2', 'C2:FINAL_INVOICE', '2026-09-02T10:00:00Z'],
        ['2', 'C2:WON', '2026-09-03T10:00:00Z'],
      ),
      analyticsState({ qualifiedAt: '2026-09-01T10:00:00Z' }),
    );

    expect(transition.order).toMatchObject({ status: 'won_deal', revenue: '999999' });
  });

  it.each(['2', '4', '6'])('emits won_deal only at C%s:WON with current revenue', (categoryId) => {
    const transition = deriveAnalyticsTransition(
      analyticsDeal({ categoryId, stageId: `C${categoryId}:WON`, opportunity: '999999' }),
      analyticsHistory(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        [categoryId, `C${categoryId}:WON`, '2026-09-03T10:00:00Z'],
      ),
      analyticsState({
        qualifiedAt: '2026-09-01T10:00:00Z',
        signedAt: '2026-09-02T10:00:00Z',
        signedRevenue: '150000',
        signedCurrency: 'RUB',
      }),
    );
    expect(transition.events.map((event) => event.type)).toEqual(['won_deal']);
    expect(transition.order).toMatchObject({ status: 'won_deal', revenue: '999999' });
  });

  it('keeps repeated polling idempotent and atomic', () => {
    const db = migratedDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    const deal = analyticsDeal();
    const transition = analyticsTransition();

    expect(repository.applyTransition(deal, transition)).toEqual({ eventCount: 1, outboxCreated: true });
    expect(repository.applyTransition(deal, transition)).toEqual({ eventCount: 0, outboxCreated: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM yandex_outbox').get()).toEqual({ n: 1 });
    db.close();
  });

  it('rolls back state and milestone when outbox insertion fails', () => {
    const db = migratedDb();
    db.exec(`CREATE TRIGGER contract_force_outbox_failure BEFORE INSERT ON yandex_outbox
      BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END`);
    const repository = createAnalyticsRepository(db, () => 1_000);

    expect(() => repository.applyTransition(analyticsDeal(), analyticsTransition()))
      .toThrow('forced outbox failure');
    expect(db.prepare('SELECT COUNT(*) AS n FROM crm_deal_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get()).toEqual({ n: 0 });
    db.close();
  });

  it('restarts an interrupted send with the newer current desired payload', () => {
    const db = migratedDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(analyticsDeal(), analyticsTransition('0'));
    const stale = repository.claimDue(1_000)[0]!;
    repository.applyTransition(
      analyticsDeal({ opportunity: '150000', stageId: 'C2:FINAL_INVOICE' }),
      analyticsTransition('150000'),
    );

    expect(repository.claimDue(1_101)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ revenue: '150000' }) }),
    ]);
    expect(stale.payload.revenue).toBe('0');
    expect(repository.countByStatus()).toMatchObject({ sending: 1 });
    db.close();
  });

  it('never persists forbidden PII even when it is present at the Bitrix boundary', () => {
    const db = migratedDb();
    const repository = createAnalyticsRepository(db, () => 1_000);
    repository.applyTransition(
      {
        ...analyticsDeal(),
        name: 'Иван Петров',
        email: 'ivan@example.com',
        phone: '+79990001122',
        comments: 'private request text',
      } as ReturnType<typeof analyticsDeal> & Record<string, unknown>,
      analyticsTransition(),
    );

    const dump = db.serialize().toString('utf8');
    for (const forbidden of ['Иван Петров', 'ivan@example.com', '+79990001122', 'private request text']) {
      expect(dump).not.toContain(forbidden);
    }
    db.close();
  });
});
