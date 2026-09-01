import type { CRMClient, CrmPayload, CrmResult } from './types.js';
import { formatComments, formatDealTitle } from './format.js';

export class CrmPartialError extends Error {
  constructor(message: string, public readonly contactId?: number) {
    super(message);
    this.name = 'CrmPartialError';
  }
}

export type Bitrix24Config = {
  webhookUrl: string;
  assignedById: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createBitrix24Client(cfg: Bitrix24Config): CRMClient {
  const base = cfg.webhookUrl.endsWith('/') ? cfg.webhookUrl : `${cfg.webhookUrl}/`;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 10_000;

  function positiveId(value: unknown, label: string): number {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
    throw new Error(`invalid ${label} ID returned by Bitrix24`);
  }

  async function call<T>(method: string, body: object): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}${method}.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Bitrix24 ${method}: non-JSON response, status ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok || (parsed as { error?: string })?.error) {
      const errMsg =
        (parsed as { error_description?: string; error?: string })?.error_description ??
        (parsed as { error?: string })?.error ??
        `status ${res.status}`;
      throw new Error(`Bitrix24 ${method} failed: ${errMsg}`);
    }
    return (parsed as { result: T }).result;
  }

  async function findDeal(payload: CrmPayload): Promise<CrmResult | null> {
    if (!payload.lead_event_id) return null;
    const deals = await call<Array<{ ID: string; CONTACT_ID?: string }>>('crm.deal.list', {
      filter: { UF_CRM_VELOCE_LEAD_EVENT_ID: payload.lead_event_id },
      select: ['ID', 'CONTACT_ID'],
    });
    if (deals.length > 1) {
      throw new Error(`multiple deals found for lead_event_id ${payload.lead_event_id}`);
    }
    const deal = deals[0];
    if (!deal) return null;
    return {
      contactId: positiveId(deal.CONTACT_ID, 'contact'),
      dealId: positiveId(deal.ID, 'deal'),
    };
  }

  async function findUniqueContact(payload: CrmPayload): Promise<number | undefined> {
    if (!payload.lead_event_id) return undefined;
    const ids = new Set<number>();
    for (const [type, value] of [
      ['PHONE', payload.phone],
      ['EMAIL', payload.email],
    ] as const) {
      const result = await call<{ CONTACT?: Array<number | string> }>(
        'crm.duplicate.findbycomm',
        { entity_type: 'CONTACT', type, values: [value] },
      );
      for (const id of result.CONTACT ?? []) ids.add(positiveId(id, 'contact'));
    }
    return ids.size === 1 ? [...ids][0] : undefined;
  }

  function v1DealFields(payload: CrmPayload): Record<string, unknown> {
    if (!payload.lead_event_id || !payload.context || !payload.attribution || !payload.consent_proof) {
      return {};
    }
    const first = payload.attribution.first_touch;
    const last = payload.attribution.last_touch;
    return {
      UTM_SOURCE: last.utm_source,
      UTM_MEDIUM: last.utm_medium,
      UTM_CAMPAIGN: last.utm_campaign,
      UTM_CONTENT: last.utm_content,
      UTM_TERM: last.utm_term,
      UF_CRM_VELOCE_ATTR_SCHEMA_VERSION: payload.attribution.schema_version,
      UF_CRM_VELOCE_LEAD_EVENT_ID: payload.lead_event_id,
      UF_CRM_VELOCE_FIRST_SOURCE: first.utm_source,
      UF_CRM_VELOCE_FIRST_MEDIUM: first.utm_medium,
      UF_CRM_VELOCE_FIRST_CAMPAIGN: first.utm_campaign,
      UF_CRM_VELOCE_FIRST_CONTENT: first.utm_content,
      UF_CRM_VELOCE_FIRST_TERM: first.utm_term,
      UF_CRM_VELOCE_FIRST_LANDING: first.landing_url,
      UF_CRM_VELOCE_FIRST_REFERRER: first.referrer,
      UF_CRM_VELOCE_FIRST_CAPTURED_AT: first.captured_at,
      UF_CRM_VELOCE_LAST_LANDING: last.landing_url,
      UF_CRM_VELOCE_LAST_REFERRER: last.referrer,
      UF_CRM_VELOCE_LAST_CAPTURED_AT: last.captured_at,
      UF_CRM_VELOCE_YCLID: last.yclid,
      UF_CRM_VELOCE_YM_CLIENT_ID: payload.attribution.ym_client_id,
      UF_CRM_VELOCE_CONTACT_CHANNEL: payload.channel,
      UF_CRM_VELOCE_CTA_PLACEMENT: payload.context.placement,
      UF_CRM_VELOCE_PAGE_PATH: payload.context.page_path,
      UF_CRM_VELOCE_PAGE_TYPE: payload.context.page_type,
      UF_CRM_VELOCE_FORM_ID: payload.context.form_id ?? null,
      UF_CRM_VELOCE_SERVICE: payload.context.service ?? null,
      UF_CRM_VELOCE_CONSENT_VERSION: payload.consent_proof.version,
      UF_CRM_VELOCE_CONSENT_AT: payload.consent_proof.accepted_at,
    };
  }

  return {
    async createWebLead(payload: CrmPayload): Promise<CrmResult> {
      const existingDeal = await findDeal(payload);
      if (existingDeal) return existingDeal;

      let contactId = payload.contactId;
      if (!contactId) {
        contactId = await findUniqueContact(payload);
      }
      if (!contactId) {
        try {
          const id = await call<number | string>('crm.contact.add', {
            fields: {
              NAME: payload.name,
              EMAIL: [{ VALUE: payload.email, VALUE_TYPE: 'WORK' }],
              PHONE: [{ VALUE: payload.phone, VALUE_TYPE: 'WORK' }],
              SOURCE_ID: payload.sourceId,
              OPENED: 'Y',
              ASSIGNED_BY_ID: cfg.assignedById,
            },
          });
          contactId = positiveId(id, 'contact');
        } catch (err) {
          throw new CrmPartialError(`contact.add failed: ${(err as Error).message}`);
        }
      }

      let dealId: number;
      try {
        const id = await call<number | string>('crm.deal.add', {
          fields: {
            TITLE: formatDealTitle(payload),
            CONTACT_ID: contactId,
            COMMENTS: formatComments(payload),
            SOURCE_ID: payload.sourceId,
            ...(payload.lead_event_id ? {} : { UF_CRM_CHANNEL: payload.channel }),
            ...v1DealFields(payload),
            OPENED: 'Y',
            ASSIGNED_BY_ID: cfg.assignedById,
          },
        });
        dealId = positiveId(id, 'deal');
      } catch (err) {
        throw new CrmPartialError(
          `deal.add failed: ${(err as Error).message}`,
          contactId,
        );
      }

      return { contactId, dealId };
    },
  };
}
