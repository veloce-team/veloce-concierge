import type { AnalyticsDeal, AnalyticsHistoryItem } from './semantic.js';

export type BitrixAnalyticsClient = {
  listTrackedDeals(): Promise<AnalyticsDeal[]>;
  getStageHistory(dealId: string): Promise<AnalyticsHistoryItem[]>;
};

export type BitrixAnalyticsConfig = {
  webhookUrl: string;
  portalId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type ApiEnvelope<T> = { result: T; next?: number; error?: string; error_description?: string };

function canonicalId(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  throw new Error(`invalid ${label} ID returned by Bitrix24`);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createBitrixAnalyticsClient(cfg: BitrixAnalyticsConfig): BitrixAnalyticsClient {
  const base = cfg.webhookUrl.endsWith('/') ? cfg.webhookUrl : `${cfg.webhookUrl}/`;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  async function call<T>(method: string, body: object): Promise<ApiEnvelope<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${method}.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed: ApiEnvelope<T>;
    try {
      parsed = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw new Error(`Bitrix24 ${method}: non-JSON response, status ${response.status}`);
    }
    if (!response.ok || parsed.error) {
      throw new Error(
        `Bitrix24 ${method} failed: ${parsed.error_description ?? parsed.error ?? response.status}`,
      );
    }
    return parsed;
  }

  return {
    async listTrackedDeals() {
      const deals: AnalyticsDeal[] = [];
      let start = 0;
      do {
        const envelope = await call<Array<Record<string, unknown>>>('crm.deal.list', {
          filter: { '=UF_CRM_VELOCE_ATTR_SCHEMA_VERSION': 1 },
          select: [
            'ID',
            'CONTACT_ID',
            'CATEGORY_ID',
            'STAGE_ID',
            'DATE_CREATE',
            'DATE_MODIFY',
            'OPPORTUNITY',
            'CURRENCY_ID',
            'UF_CRM_VELOCE_YM_CLIENT_ID',
          ],
          order: { DATE_MODIFY: 'ASC', ID: 'ASC' },
          start,
        });
        for (const row of envelope.result) {
          deals.push({
            portalId: cfg.portalId,
            dealId: canonicalId(row.ID, 'deal'),
            contactId: row.CONTACT_ID == null || row.CONTACT_ID === ''
              ? null
              : canonicalId(row.CONTACT_ID, 'contact'),
            categoryId: String(row.CATEGORY_ID ?? '0'),
            stageId: String(row.STAGE_ID ?? ''),
            createdAt: String(row.DATE_CREATE ?? ''),
            modifiedAt: String(row.DATE_MODIFY ?? ''),
            opportunity: nullableString(row.OPPORTUNITY),
            currencyId: nullableString(row.CURRENCY_ID),
            ymClientId: nullableString(row.UF_CRM_VELOCE_YM_CLIENT_ID),
          });
        }
        if (envelope.next == null) break;
        start = envelope.next;
      } while (true);
      return deals;
    },

    async getStageHistory(dealId) {
      const history: AnalyticsHistoryItem[] = [];
      let start = 0;
      do {
        const envelope = await call<{ items: Array<Record<string, unknown>> }>(
          'crm.stagehistory.list',
          {
            entityTypeId: 2,
            filter: { OWNER_ID: dealId },
            order: { CREATED_TIME: 'ASC', ID: 'ASC' },
            select: ['ID', 'CATEGORY_ID', 'STAGE_ID', 'CREATED_TIME'],
            start,
          },
        );
        history.push(...envelope.result.items.map((row) => ({
          id: canonicalId(row.ID, 'stage history'),
          categoryId: String(row.CATEGORY_ID ?? '0'),
          stageId: String(row.STAGE_ID ?? ''),
          createdAt: String(row.CREATED_TIME ?? ''),
        })));
        if (envelope.next == null) break;
        start = envelope.next;
      } while (true);
      return history;
    },
  };
}
