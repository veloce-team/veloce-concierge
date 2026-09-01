import type { Logger } from 'pino';
import { vi } from 'vitest';
import type { AnalyticsRepository, YandexOutboxRecord } from '../../src/services/analytics/repository.js';
import type {
  AnalyticsDeal,
  AnalyticsHistoryItem,
  AnalyticsState,
  AnalyticsTransition,
} from '../../src/services/analytics/semantic.js';

export const CONTRACT_NOW = Date.parse('2026-09-05T12:00:00Z');

export function analyticsDeal(overrides: Partial<AnalyticsDeal> = {}): AnalyticsDeal {
  return {
    portalId: 'portal-1',
    dealId: '42',
    contactId: '7',
    categoryId: '2',
    stageId: 'C2:NEW',
    createdAt: '2026-09-01T09:00:00Z',
    modifiedAt: '2026-09-01T10:00:00Z',
    opportunity: '0',
    currencyId: 'RUB',
    ymClientId: '123456789012345678',
    ...overrides,
  };
}

export function analyticsHistory(
  ...rows: Array<[categoryId: string, stageId: string, createdAt: string]>
): AnalyticsHistoryItem[] {
  return rows.map(([categoryId, stageId, createdAt], index) => ({
    id: String(index + 1),
    categoryId,
    stageId,
    createdAt,
  }));
}

export function analyticsState(overrides: Partial<AnalyticsState> = {}): AnalyticsState {
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

export function analyticsTransition(revenue = '0'): AnalyticsTransition {
  return {
    nextState: analyticsState({
      qualifiedAt: '2026-09-01T10:00:00Z',
      signedAt: revenue === '0' ? null : '2026-09-02T10:00:00Z',
      signedRevenue: revenue === '0' ? null : revenue,
      signedCurrency: revenue === '0' ? null : 'RUB',
    }),
    events: [
      {
        type: 'qualified_lead',
        occurredAt: '2026-09-01T10:00:00Z',
        contractVersion: 1,
      },
    ],
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

export function outboxRecord(overrides: Partial<YandexOutboxRecord> = {}): YandexOutboxRecord {
  return {
    id: 1,

    portalId: 'portal-1',
    dealId: '42',
    orderId: 'b24:portal-1:deal:42',
    payload: analyticsTransition().order!,
    payloadHash: 'fixture-hash',
    status: 'sending',
    attempts: 1,
    nextAttemptAt: 0,

    uploadId: null,
    acceptedAt: null,
    reconcileCursor: null,
    lastError: null,
    ...overrides,
  };
}

export function fakeRepository(
  overrides: Partial<AnalyticsRepository> = {},
): AnalyticsRepository {
  return {
    getState: vi.fn().mockReturnValue(analyticsState()),
    applyTransition: vi.fn().mockReturnValue({ eventCount: 0, outboxCreated: false }),
    claimDue: vi.fn().mockReturnValue([]),
    markAccepted: vi.fn().mockReturnValue('accepted'),
    listAccepted: vi.fn().mockReturnValue([]),
    setReconcileCursor: vi.fn(),
    markProcessed: vi.fn(),
    markRetry: vi.fn().mockReturnValue('retry'),
    markDead: vi.fn().mockReturnValue('dead'),
    markUnmatchable: vi.fn().mockReturnValue('unmatchable'),
    hasProcessedOrder: vi.fn().mockReturnValue(false),
    countByStatus: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

export function fakeLogger(): Logger {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}
