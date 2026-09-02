import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createAnalyticsWorker } from '../src/services/analytics/worker.js';
import { YandexApiError } from '../src/services/analytics/yandex.js';
import type { AnalyticsDeal } from '../src/services/analytics/semantic.js';

const deal: AnalyticsDeal = {
  portalId: 'portal-1', dealId: '42', sourceDealId: '42', contactId: '7', categoryId: '2', stageId: 'C2:NEW',
  createdAt: '2026-09-01T09:00:00Z', modifiedAt: '2026-09-01T10:00:00Z', opportunity: '0',
  currencyId: 'RUB', ymClientId: '123456789012345678',
};

const history = [
  { id: '1', categoryId: '0', stageId: 'NEW', createdAt: '2026-09-01T09:00:00Z' },
  { id: '2', categoryId: '2', stageId: 'C2:NEW', createdAt: '2026-09-01T10:00:00Z' },
];

const record = {
  id: 1,

  orderId: 'b24:portal-1:deal:42',
  payload: {
    id: 'b24:portal-1:deal:42', createDateTime: '2026-09-01T10:00:00Z',
    clientUniqId: 'b24:portal-1:contact:7', clientIds: '123456789012345678',
    status: 'qualified_lead' as const, revenue: '0', currency: 'RUB',
  },
  payloadHash: 'hash', status: 'sending' as const, attempts: 1, nextAttemptAt: 0,

  acceptedAt: null,
  reconcileCursor: null,
};

function logger() {
  return pino({ enabled: false });
}

describe('offline analytics worker orchestration', () => {
  it('runs the initial lifecycle in poll → upload → reconciliation order', async () => {
    const calls: string[] = [];
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockImplementation(async () => {
          calls.push('poll');
          return [];
        }),
      } as any,
      repository: {
        claimDue: vi.fn().mockImplementation(() => {
          calls.push('upload');
          return [];
        }),
        listAccepted: vi.fn().mockImplementation(() => {
          calls.push('reconcile');
          return [];
        }),
      } as any,
      yandex: {} as any,
      logger: logger(),
      pollIntervalMs: 60_000,
      uploadIntervalMs: 60_000,
      reconcileIntervalMs: 60_000,
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await worker.stop();
    expect(calls).toEqual(['poll', 'upload', 'reconcile']);
    expect(worker.health()).toMatchObject({ ready: true, started: false, stopping: false });
  });

  it('waits for an in-flight external request during managed shutdown', async () => {
    let resolveUpload!: (value: unknown) => void;
    const uploadResult = new Promise((resolve) => {
      resolveUpload = resolve;
    });
    const repository = {
      claimDue: vi.fn().mockReturnValue([record]),
      hasProcessedOrder: vi.fn().mockReturnValue(false),
      markAccepted: vi.fn(), markRetry: vi.fn(), markDead: vi.fn(), markUnmatchable: vi.fn(),
    } as any;
    const worker = createAnalyticsWorker({
      bitrix: {} as any,
      repository,
      yandex: { upload: vi.fn().mockReturnValue(uploadResult) } as any,
      logger: logger(),
      now: () => Date.parse('2026-09-02T12:00:00Z'),
    });

    const tick = worker.tickUpload();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopped = worker.stop();
    expect(stopped).toBeInstanceOf(Promise);
    let settled = false;
    void stopped.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    resolveUpload({ uploadId: 'upload-1', validationStatus: 'PASSED', elementsCount: 1 });
    await tick;
    await stopped;
    expect(repository.markAccepted).toHaveBeenCalledOnce();
  });

  it('polls canonical Bitrix state and commits the semantic transition', async () => {
    const applyTransition = vi.fn();
    const worker = createAnalyticsWorker({
      bitrix: { listTrackedDeals: vi.fn().mockResolvedValue([deal]), getStageHistory: vi.fn().mockResolvedValue(history) },
      repository: {
        getState: vi.fn().mockReturnValue({
          portalId: 'portal-1', dealId: '42', qualifiedAt: null, signedAt: null,
          signedRevenue: null, signedCurrency: null, wonAt: null, cancelledAt: null,
          lastPayloadHash: null, payloadRevision: 0,
        }),
        applyTransition,
      } as any,
      yandex: {} as any,
      logger: logger(),
      now: () => Date.parse('2026-09-01T12:00:00Z'),
    });

    await worker.tickPoll();
    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![0]).toMatchObject({
      portalId: 'portal-1', dealId: '42', categoryId: '2', stageId: 'C2:NEW',
    });
  });

  it('treats a copied working-funnel deal as one logical transition rooted at source deal ID', async () => {
    const source = {
      ...deal,
      dealId: '202', sourceDealId: '202', categoryId: '0', stageId: 'WON',
      createdAt: '2026-09-01T15:52:58Z', modifiedAt: '2026-09-02T00:30:23Z',
    } as AnalyticsDeal & { sourceDealId: string };
    const target = {
      ...deal,
      dealId: '204', sourceDealId: '202', categoryId: '6', stageId: 'C6:FINAL_INVOICE',
      createdAt: '2026-09-02T00:30:24Z', modifiedAt: '2026-09-02T00:30:24Z',
      opportunity: '150000',
    } as AnalyticsDeal & { sourceDealId: string };
    const histories = new Map([
      ['202', [
        { id: '300', categoryId: '0', stageId: 'NEW', createdAt: '2026-09-01T15:52:58Z' },
        { id: '302', categoryId: '0', stageId: 'WON', createdAt: '2026-09-02T00:30:23Z' },
      ]],
      ['204', [
        { id: '304', categoryId: '6', stageId: 'C6:FINAL_INVOICE', createdAt: '2026-09-02T00:30:24Z' },
      ]],
    ]);
    const applyTransition = vi.fn();
    const getState = vi.fn().mockReturnValue({
      portalId: 'portal-1', dealId: '202', qualifiedAt: null, signedAt: null,
      signedRevenue: null, signedCurrency: null, wonAt: null, cancelledAt: null,
      lastPayloadHash: null, payloadRevision: 0,
    });
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([source, target]),
        getStageHistory: vi.fn((dealId: string) => Promise.resolve(histories.get(dealId) ?? [])),
      },
      repository: { getState, applyTransition } as any,
      yandex: {} as any,
      logger: logger(),
    });

    await worker.tickPoll();

    expect(getState).toHaveBeenCalledOnce();
    expect(getState).toHaveBeenCalledWith('portal-1', '202');
    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![0]).toMatchObject({
      dealId: '202', categoryId: '6', stageId: 'C6:FINAL_INVOICE', opportunity: '150000',
    });
    expect(applyTransition.mock.calls[0]![1]).toMatchObject({
      events: [expect.objectContaining({ type: 'qualified_lead' })],
      order: expect.objectContaining({ id: 'b24:portal-1:deal:202', revenue: '150000' }),
    });
  });

  it('lets the newest copied descendant suppress an older working-funnel delivery', async () => {
    const source = {
      ...deal, dealId: '202', sourceDealId: '202', categoryId: '0', stageId: 'WON',
      createdAt: '2026-09-01T09:00:00Z', modifiedAt: '2026-09-03T09:00:00Z',
    };
    const working = {
      ...deal, dealId: '204', sourceDealId: '202', categoryId: '6', stageId: 'C6:NEW',
      createdAt: '2026-09-02T09:00:00Z', modifiedAt: '2026-09-02T09:00:00Z',
    };
    const excluded = {
      ...deal, dealId: '206', sourceDealId: '202', categoryId: '10', stageId: 'C10:NEW',
      createdAt: '2026-09-03T08:00:00Z', modifiedAt: '2026-09-03T08:00:00Z',
    };
    const applyTransition = vi.fn();
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([excluded, source, working]),
        getStageHistory: vi.fn((dealId: string) => Promise.resolve([
          { id: dealId, categoryId: dealId === '202' ? '0' : dealId === '204' ? '6' : '10',
            stageId: dealId === '202' ? 'NEW' : `C${dealId === '204' ? '6' : '10'}:NEW`,
            createdAt: dealId === '202' ? source.createdAt : dealId === '204' ? working.createdAt : excluded.createdAt },
        ])),
      },
      repository: {
        getState: vi.fn().mockReturnValue({
          portalId: 'portal-1', dealId: '202', qualifiedAt: '2026-09-02T09:00:00Z',
          signedAt: null, signedRevenue: null, signedCurrency: null, wonAt: null,
          cancelledAt: null, lastPayloadHash: 'old', payloadRevision: 1,
        }),
        applyTransition,
      } as any,
      yandex: {} as any,
      logger: logger(),
    });

    await worker.tickPoll();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![0]).toMatchObject({ dealId: '202', categoryId: '10' });
    expect(applyTransition.mock.calls[0]![1]).toMatchObject({
      order: null,
      suppressDelivery: true,
    });
  });

  it('fails one malformed lineage closed when its referenced category-0 root is absent', async () => {
    const error = vi.fn();
    const orphan = {
      ...deal,
      dealId: '204', sourceDealId: '202', categoryId: '6', stageId: 'C6:NEW',
    };
    const applyTransition = vi.fn();
    const activeState = {
      portalId: 'portal-1', dealId: '202', qualifiedAt: '2026-09-01T10:00:00Z',
      signedAt: null, signedRevenue: null, signedCurrency: null, wonAt: null,
      cancelledAt: null, lastPayloadHash: 'active-payload', payloadRevision: 1,
    };
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([orphan]),
        getStageHistory: vi.fn().mockResolvedValue([
          { id: '304', categoryId: '6', stageId: 'C6:NEW', createdAt: orphan.createdAt },
        ]),
      },
      repository: { getState: vi.fn().mockReturnValue(activeState), applyTransition } as any,
      yandex: {} as any,
      logger: { warn: vi.fn(), info: vi.fn(), error } as any,
    });

    await worker.tickPoll();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![0]).toMatchObject({ dealId: '202' });
    expect(applyTransition.mock.calls[0]![1]).toMatchObject({
      nextState: activeState, events: [], order: null, suppressDelivery: true,
    });
    expect(error).toHaveBeenCalledWith(
      { deal_id: '202', physical_deal_ids: ['204'] },
      'analytics: lineage root missing',
    );
  });

  it('fails one lineage closed when the referenced root has no category-0 history', async () => {
    const error = vi.fn();
    const root = {
      ...deal,
      dealId: '202', sourceDealId: '202', categoryId: '6', stageId: 'C6:NEW',
    };
    const applyTransition = vi.fn();
    const activeState = {
      portalId: 'portal-1', dealId: '202', qualifiedAt: '2026-09-01T10:00:00Z',
      signedAt: null, signedRevenue: null, signedCurrency: null, wonAt: null,
      cancelledAt: null, lastPayloadHash: 'active-payload', payloadRevision: 1,
    };
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([root]),
        getStageHistory: vi.fn().mockResolvedValue([
          { id: '304', categoryId: '6', stageId: 'C6:NEW', createdAt: root.createdAt },
        ]),
      },
      repository: { getState: vi.fn().mockReturnValue(activeState), applyTransition } as any,
      yandex: {} as any,
      logger: { warn: vi.fn(), info: vi.fn(), error } as any,
    });

    await worker.tickPoll();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![0]).toMatchObject({ dealId: '202' });
    expect(applyTransition.mock.calls[0]![1]).toMatchObject({
      nextState: activeState, events: [], order: null, suppressDelivery: true,
    });
    expect(error).toHaveBeenCalledWith(
      { deal_id: '202' },
      'analytics: lineage root has no qualification history',
    );
  });

  it('does not qualify a root-only lineage from a same-deal category-0 to working transition', async () => {
    const root = {
      ...deal,
      dealId: '202', sourceDealId: '202', categoryId: '6', stageId: 'C6:NEW',
    };
    const applyTransition = vi.fn();
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([root]),
        getStageHistory: vi.fn().mockResolvedValue([
          { id: '1', categoryId: '0', stageId: 'NEW', createdAt: '2026-09-01T09:00:00Z' },
          { id: '2', categoryId: '6', stageId: 'C6:NEW', createdAt: '2026-09-01T10:00:00Z' },
        ]),
      },
      repository: {
        getState: vi.fn().mockReturnValue({
          portalId: 'portal-1', dealId: '202', qualifiedAt: null, signedAt: null,
          signedRevenue: null, signedCurrency: null, wonAt: null, cancelledAt: null,
          lastPayloadHash: null, payloadRevision: 0,
        }),
        applyTransition,
      } as any,
      yandex: {} as any,
      logger: logger(),
    });

    await worker.tickPoll();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![1]).toMatchObject({ events: [], order: null });
  });

  it('qualifies the first working descendant despite interposed excluded lineage history', async () => {
    const root = {
      ...deal, dealId: '202', sourceDealId: '202', categoryId: '0', stageId: 'WON',
      createdAt: '2026-09-01T09:00:00Z', modifiedAt: '2026-09-03T09:00:00Z',
    };
    const excluded = {
      ...deal, dealId: '204', sourceDealId: '202', categoryId: '10', stageId: 'C10:NEW',
      createdAt: '2026-09-01T09:30:00Z', modifiedAt: '2026-09-01T09:30:00Z',
    };
    const working = {
      ...deal, dealId: '206', sourceDealId: '202', categoryId: '6', stageId: 'C6:NEW',
      createdAt: '2026-09-01T10:00:00Z', modifiedAt: '2026-09-01T10:00:00Z',
    };
    const histories = new Map([
      ['202', [{ id: '1', categoryId: '0', stageId: 'NEW', createdAt: root.createdAt }]],
      ['204', [{ id: '2', categoryId: '10', stageId: 'C10:NEW', createdAt: excluded.createdAt }]],
      ['206', [{ id: '3', categoryId: '6', stageId: 'C6:NEW', createdAt: working.createdAt }]],
    ]);
    const applyTransition = vi.fn();
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([root, excluded, working]),
        getStageHistory: vi.fn((dealId: string) => Promise.resolve(histories.get(dealId) ?? [])),
      },
      repository: {
        getState: vi.fn().mockReturnValue({
          portalId: 'portal-1', dealId: '202', qualifiedAt: null, signedAt: null,
          signedRevenue: null, signedCurrency: null, wonAt: null, cancelledAt: null,
          lastPayloadHash: null, payloadRevision: 0,
        }),
        applyTransition,
      } as any,
      yandex: {} as any,
      logger: logger(),
    });

    await worker.tickPoll();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![1]).toMatchObject({
      events: [{ type: 'qualified_lead', occurredAt: working.createdAt, contractVersion: 1 }],
      order: expect.objectContaining({ id: 'b24:portal-1:deal:202', createDateTime: working.createdAt }),
    });
  });

  it('uses numeric deal ID as the final newest-deal tie-breaker', async () => {
    const timestamp = '2026-09-02T09:00:00Z';
    const root = {
      ...deal, dealId: '202', sourceDealId: '202', categoryId: '0', stageId: 'WON',
      createdAt: '2026-09-01T09:00:00Z', modifiedAt: '2026-09-03T09:00:00Z',
    };
    const lower = {
      ...deal, dealId: '204', sourceDealId: '202', categoryId: '6', stageId: 'C6:NEW',
      createdAt: timestamp, modifiedAt: timestamp,
    };
    const higher = {
      ...deal, dealId: '206', sourceDealId: '202', categoryId: '10', stageId: 'C10:NEW',
      createdAt: timestamp, modifiedAt: timestamp,
    };
    const applyTransition = vi.fn();
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([higher, root, lower]),
        getStageHistory: vi.fn((dealId: string) => Promise.resolve([{
          id: dealId,
          categoryId: dealId === '202' ? '0' : dealId === '204' ? '6' : '10',
          stageId: dealId === '202' ? 'NEW' : dealId === '204' ? 'C6:NEW' : 'C10:NEW',
          createdAt: dealId === '202' ? root.createdAt : timestamp,
        }])),
      },
      repository: {
        getState: vi.fn().mockReturnValue({
          portalId: 'portal-1', dealId: '202', qualifiedAt: null, signedAt: null,
          signedRevenue: null, signedCurrency: null, wonAt: null, cancelledAt: null,
          lastPayloadHash: null, payloadRevision: 0,
        }),
        applyTransition,
      } as any,
      yandex: {} as any,
      logger: logger(),
    });

    await worker.tickPoll();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![0]).toMatchObject({ dealId: '202', categoryId: '10' });
    expect(applyTransition.mock.calls[0]![1]).toMatchObject({ order: null, suppressDelivery: true });
  });

  it('uses modified time before numeric ID when creation timestamps tie', async () => {
    const createdAt = '2026-09-02T09:00:00Z';
    const root = {
      ...deal, dealId: '202', sourceDealId: '202', categoryId: '0', stageId: 'WON',
      createdAt: '2026-09-01T09:00:00Z', modifiedAt: '2026-09-03T09:00:00Z',
    };
    const olderModifiedHigherId = {
      ...deal, dealId: '206', sourceDealId: '202', categoryId: '6', stageId: 'C6:NEW',
      createdAt, modifiedAt: '2026-09-02T10:00:00Z',
    };
    const newerModifiedLowerId = {
      ...deal, dealId: '204', sourceDealId: '202', categoryId: '10', stageId: 'C10:NEW',
      createdAt, modifiedAt: '2026-09-02T11:00:00Z',
    };
    const applyTransition = vi.fn();
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([newerModifiedLowerId, root, olderModifiedHigherId]),
        getStageHistory: vi.fn((dealId: string) => Promise.resolve([{
          id: dealId,
          categoryId: dealId === '202' ? '0' : dealId === '206' ? '6' : '10',
          stageId: dealId === '202' ? 'NEW' : dealId === '206' ? 'C6:NEW' : 'C10:NEW',
          createdAt: dealId === '202' ? root.createdAt : createdAt,
        }])),
      },
      repository: {
        getState: vi.fn().mockReturnValue({
          portalId: 'portal-1', dealId: '202', qualifiedAt: null, signedAt: null,
          signedRevenue: null, signedCurrency: null, wonAt: null, cancelledAt: null,
          lastPayloadHash: null, payloadRevision: 0,
        }),
        applyTransition,
      } as any,
      yandex: {} as any,
      logger: logger(),
    });

    await worker.tickPoll();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![0]).toMatchObject({ dealId: '202', categoryId: '10' });
  });

  it('derives status only from the newest physical descendant history', async () => {
    const root = {
      ...deal, dealId: '202', sourceDealId: '202', categoryId: '0', stageId: 'WON',
      createdAt: '2026-09-01T08:00:00Z', modifiedAt: '2026-09-03T09:00:00Z',
    };
    const older = {
      ...deal, dealId: '204', sourceDealId: '202', categoryId: '6', stageId: 'C6:WON',
      createdAt: '2026-09-01T09:00:00Z', modifiedAt: '2026-09-01T11:00:00Z', opportunity: '150000',
    };
    const newest = {
      ...deal, dealId: '206', sourceDealId: '202', categoryId: '6', stageId: 'C6:NEW',
      createdAt: '2026-09-02T09:00:00Z', modifiedAt: '2026-09-02T09:00:00Z', opportunity: '0',
    };
    const histories = new Map([
      ['202', [{ id: '1', categoryId: '0', stageId: 'NEW', createdAt: root.createdAt }]],
      ['204', [
        { id: '2', categoryId: '6', stageId: 'C6:NEW', createdAt: older.createdAt },
        { id: '3', categoryId: '6', stageId: 'C6:FINAL_INVOICE', createdAt: '2026-09-01T10:00:00Z' },
        { id: '4', categoryId: '6', stageId: 'C6:WON', createdAt: '2026-09-01T11:00:00Z' },
      ]],
      ['206', [{ id: '5', categoryId: '6', stageId: 'C6:NEW', createdAt: newest.createdAt }]],
    ]);
    const applyTransition = vi.fn();
    const worker = createAnalyticsWorker({
      bitrix: {
        listTrackedDeals: vi.fn().mockResolvedValue([root, older, newest]),
        getStageHistory: vi.fn((dealId: string) => Promise.resolve(histories.get(dealId) ?? [])),
      },
      repository: {
        getState: vi.fn().mockReturnValue({
          portalId: 'portal-1', dealId: '202', qualifiedAt: older.createdAt,
          signedAt: '2026-09-01T10:00:00Z', signedRevenue: '150000', signedCurrency: 'RUB',
          wonAt: '2026-09-01T11:00:00Z', cancelledAt: '2026-09-01T12:00:00Z',
          lastPayloadHash: 'older-descendant-payload', payloadRevision: 3,
        }),
        applyTransition,
      } as any,
      yandex: {} as any,
      logger: logger(),
    });

    await worker.tickPoll();

    expect(applyTransition).toHaveBeenCalledOnce();
    expect(applyTransition.mock.calls[0]![1]).toMatchObject({
      nextState: { qualifiedAt: older.createdAt, signedAt: null, wonAt: null },
      events: [],
      order: expect.objectContaining({ status: 'qualified_lead', revenue: '0' }),
    });
  });

  it('uploads a due order and records accepted upload identity', async () => {
    const repository = {
      claimDue: vi.fn().mockReturnValue([record]),
      hasProcessedOrder: vi.fn().mockReturnValue(false),
      markAccepted: vi.fn(), markRetry: vi.fn(), markDead: vi.fn(), markUnmatchable: vi.fn(),
    } as any;
    const yandex = { upload: vi.fn().mockResolvedValue({ uploadId: 'upload-1', validationStatus: 'PASSED', elementsCount: 1 }) } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => Date.parse('2026-09-02T12:00:00Z') });

    await worker.tickUpload();
    expect(repository.claimDue).toHaveBeenCalledWith(
      Date.parse('2026-09-02T12:00:00Z'),
      10,
    );
    expect(yandex.upload).toHaveBeenCalledWith(record.payload);
    expect(repository.markAccepted).toHaveBeenCalledWith(1, 'upload-1', Date.parse('2026-09-02T12:00:00Z'));
  });

  it('rejects an upload response whose element count is not exactly one', async () => {
    const repository = {
      claimDue: vi.fn().mockReturnValue([record]),
      hasProcessedOrder: vi.fn().mockReturnValue(false),
      markAccepted: vi.fn(), markRetry: vi.fn(), markDead: vi.fn(), markUnmatchable: vi.fn(),
    } as any;
    const yandex = {
      upload: vi.fn().mockResolvedValue({ uploadId: 'upload-1', validationStatus: 'PASSED', elementsCount: 0 }),
    } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => Date.parse('2026-09-02T12:00:00Z') });
    await worker.tickUpload();
    expect(repository.markAccepted).not.toHaveBeenCalled();
    expect(repository.markDead).toHaveBeenCalledWith(1, 'Yandex accepted unexpected element count: 0');
  });

  it('rejects an upload response with an unknown validation status', async () => {
    const repository = {
      claimDue: vi.fn().mockReturnValue([record]),
      hasProcessedOrder: vi.fn().mockReturnValue(false),
      markAccepted: vi.fn(), markRetry: vi.fn(), markDead: vi.fn(), markUnmatchable: vi.fn(),
    } as any;
    const yandex = {
      upload: vi.fn().mockResolvedValue({ uploadId: 'upload-1', validationStatus: 'WAITING', elementsCount: 1 }),
    } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => Date.parse('2026-09-02T12:00:00Z') });
    await worker.tickUpload();
    expect(repository.markAccepted).not.toHaveBeenCalled();
    expect(repository.markDead).toHaveBeenCalledWith(1, 'Yandex API returned unknown validation status: WAITING');
  });

  it('retries transient failures and dead-letters permanent failures', async () => {
    for (const [error, method] of [
      [new YandexApiError('temporary', true, 503), 'markRetry'],
      [new YandexApiError('bad request', false, 400), 'markDead'],
    ] as const) {
      const repository = {
        claimDue: vi.fn().mockReturnValue([record]), hasProcessedOrder: vi.fn().mockReturnValue(false),
        markAccepted: vi.fn(), markRetry: vi.fn(), markDead: vi.fn(), markUnmatchable: vi.fn(),
      } as any;
      const worker = createAnalyticsWorker({
        bitrix: {} as any, repository,
        yandex: { upload: vi.fn().mockRejectedValue(error) } as any,
        logger: logger(), now: () => Date.parse('2026-09-02T12:00:00Z'),
      });
      await worker.tickUpload();
      expect(repository[method]).toHaveBeenCalledOnce();
    }
  });

  it('emits a structured alert when Yandex reports quota exhaustion', async () => {
    const warn = vi.fn();
    const repository = {
      claimDue: vi.fn().mockReturnValue([record]), hasProcessedOrder: vi.fn().mockReturnValue(false),
      markAccepted: vi.fn(), markRetry: vi.fn(), markDead: vi.fn(), markUnmatchable: vi.fn(),
    } as any;
    const worker = createAnalyticsWorker({
      bitrix: {} as any,
      repository,
      yandex: { upload: vi.fn().mockRejectedValue(
        new YandexApiError('Yandex API request failed with status 420', true, 420),
      ) } as any,
      logger: { warn, error: vi.fn(), info: vi.fn() } as any,
      now: () => 3_000,
    });

    await worker.tickUpload();
    expect(repository.markRetry).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { outbox_id: 1, status: 420 },
      'analytics: Yandex quota exhausted',
    );
  });

  it('isolates partial failures between records in the bounded upload batch', async () => {
    const second = { ...record, id: 2, orderId: 'b24:portal-1:deal:43' };
    const repository = {
      claimDue: vi.fn().mockReturnValue([record, second]),
      hasProcessedOrder: vi.fn().mockReturnValue(false),
      markAccepted: vi.fn(), markRetry: vi.fn(), markDead: vi.fn(), markUnmatchable: vi.fn(),
    } as any;
    const yandex = { upload: vi.fn()
      .mockRejectedValueOnce(new YandexApiError('bad order', false, 400))
      .mockResolvedValueOnce({ uploadId: 'upload-2', validationStatus: 'PASSED', elementsCount: 1 }) } as any;
    const current = Date.parse('2026-09-02T12:00:00Z');
    const worker = createAnalyticsWorker({
      bitrix: {} as any, repository, yandex, logger: logger(), now: () => current,
    });

    await worker.tickUpload();
    expect(repository.markDead).toHaveBeenCalledWith(1, 'bad order');
    expect(repository.markAccepted).toHaveBeenCalledWith(2, 'upload-2', current);
  });

  it('marks first uploads older than 21 days and updates older than 111 days unmatchable', async () => {
    for (const [processed, days] of [[false, 22], [true, 112]] as const) {
      const now = Date.parse('2026-09-01T10:00:00Z') + days * 86_400_000;
      const repository = {
        claimDue: vi.fn().mockReturnValue([record]), hasProcessedOrder: vi.fn().mockReturnValue(processed),
        markAccepted: vi.fn(), markRetry: vi.fn(), markDead: vi.fn(), markUnmatchable: vi.fn(),
      } as any;
      const yandex = { upload: vi.fn() } as any;
      const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => now });
      await worker.tickUpload();
      expect(repository.markUnmatchable).toHaveBeenCalledOnce();
      expect(yandex.upload).not.toHaveBeenCalled();
    }
  });

  it('contains initial tick failures instead of crashing the HTTP runtime', async () => {
    const errorLog = vi.fn();
    const worker = createAnalyticsWorker({
      bitrix: { listTrackedDeals: vi.fn().mockRejectedValue(new Error('Bitrix down')) } as any,
      repository: { claimDue: vi.fn().mockReturnValue([]), listAccepted: vi.fn().mockReturnValue([]) } as any,
      yandex: {} as any,
      logger: { warn: vi.fn(), error: errorLog, info: vi.fn() } as any,
      pollIntervalMs: 60_000,
      uploadIntervalMs: 60_000,
      reconcileIntervalMs: 60_000,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.stop();
    expect(errorLog).toHaveBeenCalledWith(expect.any(Object), 'analytics: poll initial tick failed');
  });

  it('alerts when pending analytics delivery exceeds the configured limit', async () => {
    const warn = vi.fn();
    const repository = {
      claimDue: vi.fn().mockReturnValue([]),
      countByStatus: vi.fn().mockReturnValue({ dirty: 4, retry: 2, dead: 1 }),
    } as any;
    const worker = createAnalyticsWorker({
      bitrix: {} as any,
      repository,
      yandex: {} as any,
      logger: { warn, error: vi.fn(), info: vi.fn() } as any,
      now: () => 3_000,
      outboxAlertThreshold: 5,
    });
    await worker.tickUpload();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliverable_backlog: 6, dead: 1 }),
      'analytics: outbox alert threshold exceeded',
    );
  });

  it('reconciles accepted uploads only after Yandex validation read-back', async () => {
    const repository = {
      listAccepted: vi.fn().mockReturnValue([{ ...record, status: 'accepted', uploadId: 'upload-1' }]),
      markProcessed: vi.fn(), markDead: vi.fn(),
    } as any;
    const yandex = { getUploadStatusPage: vi.fn().mockResolvedValue({
      upload: { uploadId: 'upload-1', validationStatus: 'PASSED', elementsCount: 1 },
      nextCursor: null, exhausted: true,
    }) } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => 3_000 });
    await worker.tickReconcile();
    expect(repository.markProcessed).toHaveBeenCalledWith(1, 3_000);
  });

  it('dead-letters a PASSED upload whose element count is not exactly one', async () => {
    const repository = {
      listAccepted: vi.fn().mockReturnValue([{ ...record, status: 'accepted', uploadId: 'upload-1' }]),
      markProcessed: vi.fn(), markDead: vi.fn(),
    } as any;
    const yandex = { getUploadStatusPage: vi.fn().mockResolvedValue({
      upload: { uploadId: 'upload-1', validationStatus: 'PASSED', elementsCount: 0 },
      nextCursor: null, exhausted: true,
    }) } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => 3_000 });
    await worker.tickReconcile();
    expect(repository.markProcessed).not.toHaveBeenCalled();
    expect(repository.markDead).toHaveBeenCalledWith(1, 'Yandex processed unexpected element count: 0');
  });

  it('escalates an accepted upload missing from exhaustive Yandex history for over one hour', async () => {
    const repository = {
      listAccepted: vi.fn().mockReturnValue([{
        ...record, status: 'accepted', uploadId: 'upload-1', acceptedAt: 1_000,
      }]),
      markProcessed: vi.fn(), markDead: vi.fn(),
    } as any;
    const yandex = { getUploadStatusPage: vi.fn().mockResolvedValue({ upload: null, nextCursor: null, exhausted: true }) } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => 3_601_001 });
    await worker.tickReconcile();
    expect(repository.markDead).toHaveBeenCalledWith(1, 'Yandex upload missing from exhaustive history');
  });

  it('persists and resumes a bounded Yandex history cursor across reconcile ticks', async () => {
    const repository = {
      listAccepted: vi.fn()
        .mockReturnValueOnce([{ ...record, status: 'accepted', uploadId: 'upload-1', acceptedAt: 1_000, reconcileCursor: null }])
        .mockReturnValueOnce([{ ...record, status: 'accepted', uploadId: 'upload-1', acceptedAt: 1_000, reconcileCursor: '2026-09-01 12:00:00' }]),
      setReconcileCursor: vi.fn(), markProcessed: vi.fn(), markDead: vi.fn(),
    } as any;
    const yandex = { getUploadStatusPage: vi.fn()
      .mockResolvedValueOnce({ upload: null, nextCursor: '2026-09-01 12:00:00', exhausted: false })
      .mockResolvedValueOnce({
        upload: { uploadId: 'upload-1', validationStatus: 'PASSED', elementsCount: 1 },
        nextCursor: null, exhausted: true,
      }) } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => 2_000 });
    await worker.tickReconcile();
    await worker.tickReconcile();
    expect(repository.setReconcileCursor).toHaveBeenCalledWith(1, '2026-09-01 12:00:00', 2_000);
    expect(yandex.getUploadStatusPage).toHaveBeenNthCalledWith(2, 'upload-1', '2026-09-01 12:00:00');
    expect(repository.markProcessed).toHaveBeenCalledWith(1, 2_000);
  });

  it.each([
    ['FAILED', 'Yandex processing validation failed'],
    ['WAITING', 'Yandex read-back returned unknown validation status: WAITING'],
  ])('fails closed for reconciliation status %s', async (validationStatus, expectedError) => {
    const repository = {
      listAccepted: vi.fn().mockReturnValue([{ ...record, status: 'accepted', uploadId: 'upload-1' }]),
      markProcessed: vi.fn(), markDead: vi.fn(),
    } as any;
    const yandex = { getUploadStatusPage: vi.fn().mockResolvedValue({
      upload: { uploadId: 'upload-1', validationStatus, elementsCount: 1 },
      nextCursor: null, exhausted: true,
    }) } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => 3_000 });
    await worker.tickReconcile();
    expect(repository.markProcessed).not.toHaveBeenCalled();
    expect(repository.markDead).toHaveBeenCalledWith(1, expectedError);
  });

  it('dead-letters a permanent reconciliation pagination failure', async () => {
    const repository = {
      listAccepted: vi.fn().mockReturnValue([{ ...record, status: 'accepted', uploadId: 'upload-1' }]),
      markDead: vi.fn(),
    } as any;
    const yandex = {
      getUploadStatusPage: vi.fn().mockRejectedValue(new YandexApiError('cursor did not advance', false, 400)),
    } as any;
    const worker = createAnalyticsWorker({ bitrix: {} as any, repository, yandex, logger: logger(), now: () => 3_000 });
    await worker.tickReconcile();
    expect(repository.markDead).toHaveBeenCalledWith(1, 'Yandex reconciliation failed permanently: cursor did not advance');
  });
});
