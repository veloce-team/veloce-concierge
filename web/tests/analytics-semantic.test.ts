import { describe, expect, it } from 'vitest';
import {
  deriveAnalyticsTransition,
  type AnalyticsDeal,
  type AnalyticsHistoryItem,
  type AnalyticsState,
} from '../src/services/analytics/semantic.js';

const baseDeal: AnalyticsDeal = {
  portalId: 'portal-1',
  dealId: '42',
  contactId: '7',
  categoryId: '0',
  stageId: 'NEW',
  createdAt: '2026-09-01T09:00:00Z',
  modifiedAt: '2026-09-01T10:00:00Z',
  opportunity: '0',
  currencyId: 'RUB',
  ymClientId: '123456789012345678',
};

function history(...rows: Array<[string, string, string]>): AnalyticsHistoryItem[] {
  return rows.map(([categoryId, stageId, createdAt], index) => ({
    id: String(index + 1),
    categoryId,
    stageId,
    createdAt,
  }));
}

function prior(overrides: Partial<AnalyticsState> = {}): AnalyticsState {
  return {
    portalId: 'portal-1',
    dealId: '42',
    qualifiedAt: null,
    signedAt: null,
    signedRevenue: null,
    signedCurrency: null,
    wonAt: null,
    cancelledAt: null,
    lastPayloadHash: null,
    payloadRevision: 0,
    ...overrides,
  };
}

describe('offline analytics semantic contract', () => {
  it.each(['2', '4', '6'])('emits qualified_lead once for category 0 → %s', (categoryId) => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId, stageId: `C${categoryId}:NEW` },
      history(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        [categoryId, `C${categoryId}:NEW`, '2026-09-01T10:00:00Z'],
      ),
      prior(),
    );

    expect(transition.nextState.qualifiedAt).toBe('2026-09-01T10:00:00Z');
    expect(transition.order).toMatchObject({
      id: 'b24:portal-1:deal:42',
      clientUniqId: 'b24:portal-1:contact:7',
      clientIds: '123456789012345678',
      status: 'qualified_lead',
      revenue: '0',
      currency: 'RUB',
    });
    expect(transition.events).toEqual([
      expect.objectContaining({ type: 'qualified_lead', occurredAt: '2026-09-01T10:00:00Z' }),
    ]);
  });

  it.each(['10', '12'])('does not qualify excluded category 0 → %s', (categoryId) => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId, stageId: `C${categoryId}:NEW` },
      history(['0', 'NEW', '2026-09-01T09:00:00Z'], [categoryId, `C${categoryId}:NEW`, '2026-09-01T10:00:00Z']),
      prior(),
    );
    expect(transition.events).toEqual([]);
    expect(transition.order).toBeNull();
  });

  it.each(['10', '12'])('does not update an existing analytics order while current category %s is excluded', (categoryId) => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId, stageId: `C${categoryId}:WON`, opportunity: '999999' },
      history(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        ['2', 'C2:NEW', '2026-09-01T10:00:00Z'],
        [categoryId, `C${categoryId}:WON`, '2026-09-03T10:00:00Z'],
      ),
      prior({ qualifiedAt: '2026-09-01T10:00:00Z' }),
    );
    expect(transition.events).toEqual([]);
    expect(transition.order).toBeNull();
    expect(transition.suppressDelivery).toBe(true);
  });

  it('does not emit a second qualified_lead after returning to qualification', () => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId: '6', stageId: 'C6:NEW' },
      history(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        ['2', 'C2:NEW', '2026-09-01T10:00:00Z'],
        ['0', 'NEW', '2026-09-01T11:00:00Z'],
        ['6', 'C6:NEW', '2026-09-01T12:00:00Z'],
      ),
      prior({ qualifiedAt: '2026-09-01T10:00:00Z' }),
    );
    expect(transition.events).toEqual([]);
  });

  it('updates the same order with signed contract value at FINAL_INVOICE', () => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId: '2', stageId: 'C2:FINAL_INVOICE', opportunity: '150000.50' },
      history(['0', 'NEW', '2026-09-01T09:00:00Z'], ['2', 'C2:FINAL_INVOICE', '2026-09-02T10:00:00Z']),
      prior({ qualifiedAt: '2026-09-01T10:00:00Z' }),
    );
    expect(transition.order).toMatchObject({
      id: 'b24:portal-1:deal:42',
      status: 'qualified_lead',
      revenue: '150000.50',
    });
    expect(transition.nextState.signedAt).toBe('2026-09-02T10:00:00Z');
  });

  it('emits won_deal once only in categories 2, 4 and 6', () => {
    const signedState = prior({
      qualifiedAt: '2026-09-01T10:00:00Z',
      signedAt: '2026-09-02T10:00:00Z',
    });
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId: '2', stageId: 'C2:WON', opportunity: '999999' },
      history(['0', 'NEW', '2026-09-01T09:00:00Z'], ['2', 'C2:WON', '2026-09-03T10:00:00Z']),
      signedState,
    );
    expect(transition.events).toEqual([
      expect.objectContaining({ type: 'won_deal', occurredAt: '2026-09-03T10:00:00Z' }),
    ]);
    expect(transition.order).toMatchObject({ status: 'won_deal', revenue: '999999' });
  });

  it('uses the current mutable deal amount after leaving the signing stage', () => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId: '2', stageId: 'C2:EXECUTING', opportunity: '777777' },
      history(['0', 'NEW', '2026-09-01T09:00:00Z'], ['2', 'C2:FINAL_INVOICE', '2026-09-02T10:00:00Z']),
      prior({ qualifiedAt: '2026-09-01T10:00:00Z', signedAt: '2026-09-02T10:00:00Z' }),
    );
    expect(transition.order).toMatchObject({ status: 'qualified_lead', revenue: '777777', currency: 'RUB' });
  });

  it('uses current revenue when FINAL_INVOICE is discovered only from history', () => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId: '2', stageId: 'C2:WON', opportunity: '888888' },
      history(
        ['0', 'NEW', '2026-09-01T09:00:00Z'],
        ['2', 'C2:FINAL_INVOICE', '2026-09-02T10:00:00Z'],
        ['2', 'C2:WON', '2026-09-03T10:00:00Z'],
      ),
      prior({ qualifiedAt: '2026-09-01T10:00:00Z' }),
    );
    expect(transition.order).toMatchObject({ status: 'won_deal', revenue: '888888' });
  });

  it.each(['0x10', '1e3', ' 150000 ', 'NaN', 'Infinity', '0', '-1'])(
    'fails closed for non-contract decimal revenue %j',
    (opportunity) => {
      const transition = deriveAnalyticsTransition(
        { ...baseDeal, categoryId: '2', stageId: 'C2:EXECUTING', opportunity },
        history(
          ['0', 'NEW', '2026-09-01T09:00:00Z'],
          ['2', 'C2:FINAL_INVOICE', '2026-09-02T10:00:00Z'],
        ),
        prior({ qualifiedAt: '2026-09-01T10:00:00Z', signedAt: '2026-09-02T10:00:00Z' }),
      );

      expect(transition.order).toBeNull();
      expect(transition.alerts).toContain('invalid_current_contract_value');
      expect(transition.holdDelivery).toBe(true);
    },
  );

  it('cancels the same order and clears active revenue', () => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId: '2', stageId: 'C2:LOSE', opportunity: '150000' },
      history(['0', 'NEW', '2026-09-01T09:00:00Z'], ['2', 'C2:LOSE', '2026-09-04T10:00:00Z']),
      prior({ qualifiedAt: '2026-09-01T10:00:00Z', signedAt: '2026-09-02T10:00:00Z' }),
    );
    expect(transition.order).toMatchObject({ status: 'CANCELLED', revenue: '0' });
    expect(transition.nextState.cancelledAt).toBe('2026-09-04T10:00:00Z');
  });

  it('refuses analytics emission without a Metrika ClientID', () => {
    const transition = deriveAnalyticsTransition(
      { ...baseDeal, categoryId: '2', stageId: 'C2:NEW', ymClientId: null },
      history(['0', 'NEW', '2026-09-01T09:00:00Z'], ['2', 'C2:NEW', '2026-09-01T10:00:00Z']),
      prior(),
    );
    expect(transition.order).toBeNull();
    expect(transition.events).toEqual([
      expect.objectContaining({ type: 'qualified_lead', occurredAt: '2026-09-01T10:00:00Z' }),
    ]);
    expect(transition.alerts).toContain('missing_ym_client_id');
  });
});
