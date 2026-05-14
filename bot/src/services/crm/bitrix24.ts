import type { CRMClient, CrmPayload } from '../../core/dialog/types.js';

export class CrmPartialError extends Error {
  constructor(message: string, public readonly contactId?: number) {
    super(message);
    this.name = 'CrmPartialError';
  }
}

export type Bitrix24Config = {
  webhookUrl: string;
  dealCategoryId: number;
  fetchImpl?: typeof fetch;
};

export function createBitrix24Client(cfg: Bitrix24Config): CRMClient {
  const base = cfg.webhookUrl.endsWith('/') ? cfg.webhookUrl : `${cfg.webhookUrl}/`;
  const fetchImpl = cfg.fetchImpl ?? fetch;

  async function call<T>(method: string, body: object): Promise<T> {
    const res = await fetchImpl(`${base}${method}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Bitrix24 ${method}: non-JSON response, status ${res.status}: ${text.slice(0, 200)}`);
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
    async createLead(payload: CrmPayload) {
      let contactId = payload.contactId;
      if (!contactId) {
        try {
          const id = await call<number | string>('crm.contact.add', {
            fields: {
              NAME: payload.name,
              PHONE: [{ VALUE: payload.phone, VALUE_TYPE: 'WORK' }],
              SOURCE_ID: payload.sourceId,
              COMMENTS: 'Лид из Telegram через @veloce_concierge_bot',
            },
          });
          contactId = Number(id);
        } catch (err) {
          throw new CrmPartialError(
            `contact.add failed: ${(err as Error).message}`,
          );
        }
      }

      const title = `Concierge / ${payload.name} / ${payload.description.slice(0, 40)}`;
      let dealId: number;
      try {
        const id = await call<number | string>('crm.deal.add', {
          fields: {
            TITLE: title,
            CONTACT_ID: contactId,
            SOURCE_ID: payload.sourceId,
            COMMENTS:
              `${payload.description}\n\n` +
              `---\nКанал: Telegram @veloce_concierge_bot\nchat_id: ${payload.chatId}`,
            CATEGORY_ID: cfg.dealCategoryId,
            OPENED: 'Y',
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
