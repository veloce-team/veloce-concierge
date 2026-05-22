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

  return {
    async createWebLead(payload: CrmPayload): Promise<CrmResult> {
      let contactId = payload.contactId;
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
          contactId = Number(id);
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
            UF_CRM_CHANNEL: payload.channel,
            OPENED: 'Y',
            ASSIGNED_BY_ID: cfg.assignedById,
          },
        });
        dealId = Number(id);
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
