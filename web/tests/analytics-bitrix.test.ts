import { describe, expect, it } from 'vitest';
import { createBitrixAnalyticsClient } from '../src/services/analytics/bitrix.js';

type Call = { method: string; body: Record<string, unknown> };

function fakeFetch(calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!.replace('.json', '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === 'crm.deal.list') {
      const start = Number(body.start ?? 0);
      const result = start === 0
        ? [{
            ID: '42', CONTACT_ID: '7', CATEGORY_ID: '2', STAGE_ID: 'C2:NEW',
            DATE_CREATE: '2026-09-01T09:00:00Z', DATE_MODIFY: '2026-09-01T10:00:00Z',
            OPPORTUNITY: '150000', CURRENCY_ID: 'RUB',
            UF_CRM_VELOCE_YM_CLIENT_ID: '123456789012345678',
          }]
        : [{
            ID: '43', CONTACT_ID: null, CATEGORY_ID: '10', STAGE_ID: 'C10:NEW',
            DATE_CREATE: '2026-09-01T11:00:00Z', DATE_MODIFY: '2026-09-01T12:00:00Z',
            OPPORTUNITY: '0', CURRENCY_ID: 'RUB', UF_CRM_VELOCE_YM_CLIENT_ID: null,
          }];
      return new Response(JSON.stringify(start === 0 ? { result, next: 50 } : { result }), { status: 200 });
    }
    if (method === 'crm.stagehistory.list') {
      return new Response(JSON.stringify({ result: { items: [
        { ID: '1', CATEGORY_ID: '0', STAGE_ID: 'NEW', CREATED_TIME: '2026-09-01T09:00:00Z' },
        { ID: '2', CATEGORY_ID: '2', STAGE_ID: 'C2:NEW', CREATED_TIME: '2026-09-01T10:00:00Z' },
      ] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'UNKNOWN_METHOD' }), { status: 400 });
  }) as typeof fetch;
}

describe('Bitrix24 canonical analytics reader', () => {
  it('paginates tracked website deals and maps only analytics fields', async () => {
    const calls: Call[] = [];
    const client = createBitrixAnalyticsClient({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/key/',
      portalId: 'member-1',
      fetchImpl: fakeFetch(calls),
    });

    await expect(client.listTrackedDeals()).resolves.toEqual([
      {
        portalId: 'member-1', dealId: '42', contactId: '7', categoryId: '2', stageId: 'C2:NEW',
        createdAt: '2026-09-01T09:00:00Z', modifiedAt: '2026-09-01T10:00:00Z',
        opportunity: '150000', currencyId: 'RUB', ymClientId: '123456789012345678',
      },
      expect.objectContaining({ portalId: 'member-1', dealId: '43', categoryId: '10', contactId: null }),
    ]);
    expect(calls.filter((call) => call.method === 'crm.deal.list')).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({
      filter: { '=UF_CRM_VELOCE_ATTR_SCHEMA_VERSION': 1 },
      start: 0,
    });
    expect(JSON.stringify(calls)).not.toContain('PHONE');
    expect(JSON.stringify(calls)).not.toContain('EMAIL');
  });

  it('reads canonical stage history for one deal', async () => {
    const calls: Call[] = [];
    const client = createBitrixAnalyticsClient({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/key/',
      portalId: 'member-1',
      fetchImpl: fakeFetch(calls),
    });

    await expect(client.getStageHistory('42')).resolves.toEqual([
      { id: '1', categoryId: '0', stageId: 'NEW', createdAt: '2026-09-01T09:00:00Z' },
      { id: '2', categoryId: '2', stageId: 'C2:NEW', createdAt: '2026-09-01T10:00:00Z' },
    ]);
    expect(calls[0]).toMatchObject({
      method: 'crm.stagehistory.list',
      body: { entityTypeId: 2, filter: { OWNER_ID: '42' } },
    });
  });

  it('paginates stage history before deriving lifecycle semantics', async () => {
    const calls: Call[] = [];
    const client = createBitrixAnalyticsClient({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/key/',
      portalId: 'member-1',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split('/').at(-1)!.replace('.json', '');
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        calls.push({ method, body });
        const item = Number(body.start ?? 0) === 0
          ? { ID: '1', CATEGORY_ID: '0', STAGE_ID: 'NEW', CREATED_TIME: '2026-09-01T09:00:00Z' }
          : { ID: '2', CATEGORY_ID: '2', STAGE_ID: 'C2:NEW', CREATED_TIME: '2026-09-01T10:00:00Z' };
        return new Response(JSON.stringify(Number(body.start ?? 0) === 0
          ? { result: { items: [item] }, next: 50 }
          : { result: { items: [item] } }), { status: 200 });
      }) as typeof fetch,
    });
    await expect(client.getStageHistory('42')).resolves.toHaveLength(2);
    expect(calls.map((call) => call.body.start)).toEqual([0, 50]);
  });

  it('fails closed on malformed deal identity', async () => {
    const client = createBitrixAnalyticsClient({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/key/',
      portalId: 'member-1',
      fetchImpl: (async () => new Response(JSON.stringify({ result: [{ ID: true }] }), { status: 200 })) as typeof fetch,
    });
    await expect(client.listTrackedDeals()).rejects.toThrow(/invalid deal ID/);
  });
});
