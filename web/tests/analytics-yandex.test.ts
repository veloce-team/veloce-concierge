import { describe, expect, it, vi } from 'vitest';
import {
  createYandexGoalsClient,
  createYandexSimpleOrdersClient,
  ensureRequiredYandexGoals,
  YandexApiError,
} from '../src/services/analytics/yandex.js';
import type { YandexOrder } from '../src/services/analytics/semantic.js';

const order: YandexOrder = {
  id: 'b24:portal-1:deal:42',
  createDateTime: '2026-09-01T10:00:00Z',
  clientUniqId: 'b24:portal-1:contact:7',
  clientIds: '123456789012345678',
  status: 'qualified_lead',
  revenue: '0',
  currency: 'RUB',
};

describe('Yandex Simple Orders API client', () => {
  it('uploads one UTF-8 CSV order with ClientID and no PII', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const client = createYandexSimpleOrdersClient({
      counterId: 109782828,
      oauthToken: 'secret-token',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify({ uploading: {
          uploading_id: 'upload-1', api_validation_status: 'PASSED', elements_count: 1,
        } }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.upload(order)).resolves.toEqual({
      uploadId: 'upload-1', validationStatus: 'PASSED', elementsCount: 1,
    });
    expect(capturedUrl).toBe('https://api-metrika.yandex.net/cdp/api/v1/counter/109782828/data/simple_orders?merge_mode=SAVE&delimiter_type=COMMA');
    expect(capturedInit?.headers).toMatchObject({ Authorization: 'OAuth secret-token' });
    const form = capturedInit?.body as FormData;
    const file = form.get('file') as File;
    const csv = await file.text();
    expect(csv).toBe(
      'id,create_date_time,client_uniq_id,client_ids,emails,phones,order_status,revenue,cost,goals,currency\n' +
      'b24:portal-1:deal:42,01.09.2026 13:00,b24:portal-1:contact:7,123456789012345678,,,qualified_lead,0,,,RUB\n',
    );
    expect(csv).not.toContain('@');
    expect(csv).not.toContain('+7');
  });

  it('reads back validation status by exact upload id', async () => {
    const client = createYandexSimpleOrdersClient({
      counterId: 109782828,
      oauthToken: 'secret-token',
      fetchImpl: (async () => new Response(JSON.stringify({ uploadings: [
        { uploading_id: 'other', api_validation_status: 'PASSED', elements_count: 1 },
        { uploading_id: 'upload-1', api_validation_status: 'FAILED', elements_count: 1 },
      ] }), { status: 200 })) as typeof fetch,
    });
    await expect(client.getUploadStatusPage('upload-1', null)).resolves.toEqual({
      upload: { uploadId: 'upload-1', validationStatus: 'FAILED', elementsCount: 1 },
      nextCursor: null,
      exhausted: true,
    });
  });

  it('returns one bounded history page and a durable datetime cursor', async () => {
    const urls: string[] = [];
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      uploading_id: `other-${index}`,
      datetime: '2026-09-01 12:00:00',
      api_validation_status: 'PASSED',
      elements_count: 1,
    }));
    const client = createYandexSimpleOrdersClient({
      counterId: 109782828,
      oauthToken: 'secret-token',
      fetchImpl: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ uploadings: firstPage }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.getUploadStatusPage('upload-old', '2026-09-02 12:00:00')).resolves.toEqual({
      upload: null,
      nextCursor: '2026-09-01 12:00:00',
      exhausted: false,
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('datetime_offset=2026-09-02+12%3A00%3A00');
  });

  it('fails closed when a full history page does not advance the cursor', async () => {
    const page = Array.from({ length: 1000 }, (_, index) => ({
      uploading_id: `other-${index}`,
      datetime: '2026-09-01 12:00:00',
      api_validation_status: 'PASSED', elements_count: 1,
    }));
    const client = createYandexSimpleOrdersClient({
      counterId: 109782828, oauthToken: 'secret-token',
      fetchImpl: (async () => new Response(JSON.stringify({ uploadings: page }), { status: 200 })) as typeof fetch,
    });
    await expect(client.getUploadStatusPage('missing', '2026-09-01 12:00:00'))
      .rejects.toThrow('cursor did not advance');
  });

  it('classifies quota and server failures as retryable and other 4xx as permanent', async () => {
    for (const [status, retryable] of [[503, true], [429, true], [420, true], [400, false]] as const) {
      const client = createYandexSimpleOrdersClient({
        counterId: 109782828,
        oauthToken: 'secret-token',
        fetchImpl: (async () => new Response('provider error', { status })) as typeof fetch,
      });
      try {
        await client.upload(order);
        throw new Error('expected upload failure');
      } catch (error) {
        expect(error).toBeInstanceOf(YandexApiError);
        expect((error as YandexApiError).retryable).toBe(retryable);
      }
    }
  });

  it('does not expose provider response bodies in diagnostic errors', async () => {
    const client = createYandexSimpleOrdersClient({
      counterId: 109782828,
      oauthToken: 'secret-token',
      fetchImpl: (async () => new Response(
        'ivan@example.com +79995551122 secret-token',
        { status: 400 },
      )) as typeof fetch,
    });

    await expect(client.upload(order)).rejects.toMatchObject({
      message: 'Yandex API request failed with status 400',
      retryable: false,
    });
  });

  it('rejects a CSV that exceeds the configured file-size limit before transport', async () => {
    const fetchImpl = vi.fn();
    const client = createYandexSimpleOrdersClient({
      counterId: 109782828,
      oauthToken: 'secret-token',
      maxFileBytes: 100,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.upload(order)).rejects.toMatchObject({
      message: 'Yandex Simple Orders CSV exceeds 100 byte limit',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Yandex goal provisioning', () => {
  it('uses the Management API action-goal contract and OAuth auth', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createYandexGoalsClient({
      counterId: 109782828,
      oauthToken: 'secret-token',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ goal: {
            id: 7, name: 'qualified_lead', type: 'action',
            conditions: [{ type: 'exact', url: 'qualified_lead' }],
          } }), { status: 200 });
        }
        return new Response(JSON.stringify({ goals: [] }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.listGoals()).resolves.toEqual([]);
    await expect(client.createActionGoal('qualified_lead')).resolves.toMatchObject({
      id: 7,
      name: 'qualified_lead',
      type: 'action',
      conditions: [{ type: 'exact', url: 'qualified_lead' }],
    });
    expect(requests.map(({ url }) => url)).toEqual([
      'https://api-metrika.yandex.net/management/v1/counter/109782828/goals',
      'https://api-metrika.yandex.net/management/v1/counter/109782828/goals',
    ]);
    expect(requests[1]?.init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'OAuth secret-token' }),
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ goal: {
      name: 'qualified_lead',
      type: 'action',
      conditions: [{ type: 'exact', url: 'qualified_lead' }],
    } });
  });

  it('creates only missing goals and returns the mandatory exact read-back', async () => {
    const listGoals = vi.fn()
      .mockResolvedValueOnce([{
        id: 1, name: 'qualified_lead', type: 'action',
        conditions: [{ type: 'exact', url: 'qualified_lead' }],
      }])
      .mockResolvedValueOnce([
        { id: 1, name: 'qualified_lead', type: 'action', conditions: [{ type: 'exact', url: 'qualified_lead' }] },
        { id: 2, name: 'won_deal', type: 'action', conditions: [{ type: 'exact', url: 'won_deal' }] },
      ]);
    const createActionGoal = vi.fn().mockResolvedValue({
      id: 2, name: 'won_deal', type: 'action', conditions: [{ type: 'exact', url: 'won_deal' }],
    });

    await expect(ensureRequiredYandexGoals({ listGoals, createActionGoal })).resolves.toEqual([
      expect.objectContaining({ id: 1, name: 'qualified_lead' }),
      expect.objectContaining({ id: 2, name: 'won_deal' }),
    ]);
    expect(createActionGoal).toHaveBeenCalledOnce();
    expect(createActionGoal).toHaveBeenCalledWith('won_deal');
    expect(listGoals).toHaveBeenCalledTimes(2);
  });

  it('is idempotent when both exact action goals already exist', async () => {
    const goals = [
      { id: 1, name: 'qualified_lead', type: 'action', conditions: [{ type: 'exact', url: 'qualified_lead' }] },
      { id: 2, name: 'won_deal', type: 'action', conditions: [{ type: 'exact', url: 'won_deal' }] },
    ];
    const client = { listGoals: vi.fn().mockResolvedValue(goals), createActionGoal: vi.fn() };

    await expect(ensureRequiredYandexGoals(client)).resolves.toEqual(goals);
    expect(client.createActionGoal).not.toHaveBeenCalled();
    expect(client.listGoals).toHaveBeenCalledOnce();
  });

  it('fails closed on a conflicting goal or missing post-create read-back', async () => {
    await expect(ensureRequiredYandexGoals({
      listGoals: vi.fn().mockResolvedValue([{
        id: 1, name: 'qualified_lead', type: 'url', conditions: [],
      }]),
      createActionGoal: vi.fn(),
    })).rejects.toThrow('conflicts with required action goal qualified_lead');

    await expect(ensureRequiredYandexGoals({
      listGoals: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      createActionGoal: vi.fn().mockResolvedValue({
        id: 1, name: 'qualified_lead', type: 'action',
        conditions: [{ type: 'exact', url: 'qualified_lead' }],
      }),
    })).rejects.toThrow('required Yandex goal read-back failed');
  });
});
