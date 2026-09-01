import { describe, expect, it } from 'vitest';
import { createBitrix24Client } from '../src/services/crm/bitrix24.js';
import type { CrmPayload } from '../src/services/crm/types.js';
import { validV1Body } from './schema-v1.test.js';

type Call = { method: string; body: any };

function payload(): CrmPayload {
  return { ...validV1Body, sourceId: 'VELOCE_SITE' };
}

function fakeFetch(
  calls: Call[],
  handlers: Record<string, (body: any) => unknown | Promise<unknown>>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!.replace('.json', '');
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    try {
      const result = await handlers[method]?.(body);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify({ result }), { status: 200 });
    } catch (error) {
      throw error;
    }
  }) as typeof fetch;
}

function client(calls: Call[], handlers: Record<string, (body: any) => unknown | Promise<unknown>>) {
  return createBitrix24Client({
    webhookUrl: 'https://example.bitrix24.ru/rest/1/key/',
    assignedById: 1,
    fetchImpl: fakeFetch(calls, handlers),
  });
}

describe('Bitrix24 Analytics Contract v1 mapping and duplicate policy', () => {
  it('reuses the one contact found by PHONE and EMAIL and maps attribution to the deal', async () => {
    const calls: Call[] = [];
    const crm = client(calls, {
      'crm.deal.list': () => [],
      'crm.duplicate.findbycomm': ({ values }: any) =>
        values[0].includes('@') ? { CONTACT: [42] } : { CONTACT: ['42'] },
      'crm.contact.add': () => 777,
      'crm.deal.add': () => 99,
    });

    await expect(crm.createWebLead(payload())).resolves.toEqual({ contactId: 42, dealId: 99 });
    expect(calls.filter((call) => call.method === 'crm.duplicate.findbycomm')).toHaveLength(2);
    expect(calls.some((call) => call.method === 'crm.contact.add')).toBe(false);

    const fields = calls.find((call) => call.method === 'crm.deal.add')!.body.fields;
    expect(fields).toMatchObject({
      CONTACT_ID: 42,
      SOURCE_ID: 'VELOCE_SITE',
      UTM_SOURCE: 'yandex',
      UTM_MEDIUM: 'cpc',
      UTM_CAMPAIGN: 'yd_2026_crm_audit_krasnoyarsk',
      UTM_CONTENT: 'yd_ad_03',
      UTM_TERM: 'crm_audit',
      UF_CRM_VELOCE_ATTR_SCHEMA_VERSION: 1,
      UF_CRM_VELOCE_LEAD_EVENT_ID: validV1Body.lead_event_id,
      UF_CRM_VELOCE_FIRST_SOURCE: 'youtube',
      UF_CRM_VELOCE_FIRST_CAMPAIGN: 'vm_2026_w36_crm_losses',
      UF_CRM_VELOCE_YCLID: 'example-not-real',
      UF_CRM_VELOCE_YM_CLIENT_ID: '123456789012345678',
      UF_CRM_VELOCE_CONTACT_CHANNEL: 'form',
      UF_CRM_VELOCE_CTA_PLACEMENT: 'form',
      UF_CRM_VELOCE_PAGE_PATH: '/resheniya/audit/',
      UF_CRM_VELOCE_CONSENT_VERSION: 'pending_legal_version',
      UF_CRM_VELOCE_CONSENT_AT: '2026-08-31T12:21:00Z',
    });
    expect(fields.UF_CRM_CHANNEL).toBeUndefined();
  });

  it('creates a contact when PHONE and EMAIL matches are ambiguous', async () => {
    const calls: Call[] = [];
    const crm = client(calls, {
      'crm.deal.list': () => [],
      'crm.duplicate.findbycomm': ({ values }: any) =>
        values[0].includes('@') ? { CONTACT: [42] } : { CONTACT: [41, 42] },
      'crm.contact.add': () => 777,
      'crm.deal.add': () => 99,
    });

    await expect(crm.createWebLead(payload())).resolves.toEqual({ contactId: 777, dealId: 99 });
    expect(calls.filter((call) => call.method === 'crm.contact.add')).toHaveLength(1);
  });

  it('returns an existing deal before contact lookup or creation', async () => {
    const calls: Call[] = [];
    const crm = client(calls, {
      'crm.deal.list': () => [{ ID: '321', CONTACT_ID: '42' }],
    });

    await expect(crm.createWebLead(payload())).resolves.toEqual({ contactId: 42, dealId: 321 });
    expect(calls.map((call) => call.method)).toEqual(['crm.deal.list']);
  });

  it('rejects an invalid deal ID instead of confirming a phantom CRM object', async () => {
    const calls: Call[] = [];
    const crm = client(calls, {
      'crm.deal.list': () => [],
      'crm.duplicate.findbycomm': () => ({ CONTACT: [42] }),
      'crm.deal.add': () => 'not-a-number',
    });

    await expect(crm.createWebLead(payload())).rejects.toThrow(/invalid deal ID/);
  });

  it('rejects coercible non-ID values returned by contact.add', async () => {
    const calls: Call[] = [];
    const crm = client(calls, {
      'crm.deal.list': () => [],
      'crm.duplicate.findbycomm': () => ({ CONTACT: [] }),
      'crm.contact.add': () => true,
    });

    await expect(crm.createWebLead(payload())).rejects.toThrow(/invalid contact ID/);
  });

  it('rejects non-canonical deal IDs returned by deal.add', async () => {
    const calls: Call[] = [];
    const crm = client(calls, {
      'crm.deal.list': () => [],
      'crm.duplicate.findbycomm': () => ({ CONTACT: [42] }),
      'crm.deal.add': () => '1e3',
    });

    await expect(crm.createWebLead(payload())).rejects.toThrow(/invalid deal ID/);
  });

  it('rejects coercible non-ID values returned by deal lookup', async () => {
    const calls: Call[] = [];
    const crm = client(calls, {
      'crm.deal.list': () => [{ ID: true, CONTACT_ID: '42' }],
    });

    await expect(crm.createWebLead(payload())).rejects.toThrow(/invalid deal ID/);
  });
});
