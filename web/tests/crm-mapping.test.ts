import { describe, it, expect } from 'vitest';
import { createBitrix24Client, CrmPartialError } from '../src/services/crm/bitrix24.js';
import type { CrmPayload } from '../src/services/crm/types.js';

function makePayload(): CrmPayload {
  return {
    name: 'Иван',
    email: 'i@example.com',
    phone: '+79991234567',
    message: 'Хочу проект',
    source: 'veloce_site',
    channel: 'form',
    sourceId: 'VELOCE_SITE',
  };
}

function fakeFetch(handlers: Record<string, (body: object) => unknown>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const method = path.split('/').slice(-1)[0]!.replace('.json', '');
    const body = JSON.parse((init?.body as string) ?? '{}');
    const handler = handlers[method];
    if (!handler) {
      return new Response(JSON.stringify({ error: 'no handler' }), { status: 500 });
    }
    const result = handler(body);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('Bitrix24Client.createWebLead', () => {
  it('sends correct contact fields, then deal with CONTACT_ID + UF_CRM_CHANNEL', async () => {
    const calls: Array<{ method: string; body: any }> = [];
    const client = createBitrix24Client({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/abc/',
      assignedById: 1,
      fetchImpl: fakeFetch({
        'crm.contact.add': (body) => {
          calls.push({ method: 'crm.contact.add', body });
          return 42;
        },
        'crm.deal.add': (body) => {
          calls.push({ method: 'crm.deal.add', body });
          return 99;
        },
      }),
    });

    const res = await client.createWebLead(makePayload());

    expect(res).toEqual({ contactId: 42, dealId: 99 });
    expect(calls.length).toBe(2);

    const contactFields = calls[0]!.body.fields;
    expect(contactFields.NAME).toBe('Иван');
    expect(contactFields.EMAIL).toEqual([{ VALUE: 'i@example.com', VALUE_TYPE: 'WORK' }]);
    expect(contactFields.PHONE).toEqual([{ VALUE: '+79991234567', VALUE_TYPE: 'WORK' }]);
    expect(contactFields.SOURCE_ID).toBe('VELOCE_SITE');
    expect(contactFields.ASSIGNED_BY_ID).toBe(1);
    expect(contactFields.OPENED).toBe('Y');

    const dealFields = calls[1]!.body.fields;
    expect(dealFields.CONTACT_ID).toBe(42);
    expect(dealFields.SOURCE_ID).toBe('VELOCE_SITE');
    expect(dealFields.UF_CRM_CHANNEL).toBe('form');
    expect(dealFields.COMMENTS).toBe('Хочу проект');
    expect(dealFields.TITLE).toBe('Заявка с сайта veloce.team — Иван');
    expect(dealFields.ASSIGNED_BY_ID).toBe(1);
  });

  it('maxbot_pro payload — TITLE с лейблом MaxBot Pro, COMMENTS со структурным префиксом', () => {
    const calls: Array<{ method: string; body: any }> = [];
    const client = createBitrix24Client({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/abc/',
      assignedById: 1,
      fetchImpl: fakeFetch({
        'crm.contact.add': (body) => {
          calls.push({ method: 'crm.contact.add', body });
          return 42;
        },
        'crm.deal.add': (body) => {
          calls.push({ method: 'crm.deal.add', body });
          return 99;
        },
      }),
    });

    return client
      .createWebLead({
        ...makePayload(),
        source: 'maxbot_pro',
        sourceId: 'MAXBOT_PRO',
        landing: 'gos',
        intent: 'kp',
        product: 'miniapp',
        message: 'Заявка через max-microsite',
      })
      .then(() => {
        const dealFields = calls[1]!.body.fields;
        expect(dealFields.TITLE).toBe('Заявка с сайта MaxBot Pro — Иван');
        expect(dealFields.COMMENTS).toContain('Сайт: MaxBot Pro');
        expect(dealFields.COMMENTS).toContain('Лендинг: Для администраций (/administraciyam/)');
        expect(dealFields.COMMENTS).toContain('Запрос: Коммерческое предложение');
        expect(dealFields.COMMENTS).toContain('Интерес: Mini App «Портал жителя округа»');
        expect(dealFields.COMMENTS).toContain('---');
        expect(dealFields.COMMENTS.endsWith('Заявка через max-microsite')).toBe(true);
        expect(dealFields.SOURCE_ID).toBe('MAXBOT_PRO');
      });
  });

  it('throws CrmPartialError without contactId if contact.add fails', async () => {
    const client = createBitrix24Client({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/abc/',
      assignedById: 1,
      fetchImpl: fakeFetch({
        'crm.contact.add': () =>
          new Response(JSON.stringify({ error: 'BOOM', error_description: 'fail' }), {
            status: 500,
          }),
      }),
    });

    await expect(client.createWebLead(makePayload())).rejects.toBeInstanceOf(
      CrmPartialError,
    );
  });

  it('throws CrmPartialError with contactId if deal.add fails', async () => {
    const client = createBitrix24Client({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/abc/',
      assignedById: 1,
      fetchImpl: fakeFetch({
        'crm.contact.add': () => 42,
        'crm.deal.add': () =>
          new Response(JSON.stringify({ error: 'BOOM', error_description: 'fail' }), {
            status: 500,
          }),
      }),
    });

    try {
      await client.createWebLead(makePayload());
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CrmPartialError);
      expect((err as CrmPartialError).contactId).toBe(42);
    }
  });

  it('skips contact.add if payload already has contactId', async () => {
    const calls: string[] = [];
    const client = createBitrix24Client({
      webhookUrl: 'https://example.bitrix24.ru/rest/1/abc/',
      assignedById: 1,
      fetchImpl: fakeFetch({
        'crm.contact.add': () => {
          calls.push('contact');
          return 1;
        },
        'crm.deal.add': () => {
          calls.push('deal');
          return 99;
        },
      }),
    });

    await client.createWebLead({ ...makePayload(), contactId: 777 });
    expect(calls).toEqual(['deal']);
  });
});
