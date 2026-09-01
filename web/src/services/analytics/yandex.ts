import type { YandexOrder } from './semantic.js';

export const REQUIRED_YANDEX_GOALS = ['qualified_lead', 'won_deal'] as const;

export type YandexGoal = {
  id: number;
  name: string;
  type: string;
  conditions?: Array<{ type: string; url: string }>;
};

/** Provider seam for idempotent goal provisioning with mandatory read-back. */
export type YandexGoalsClient = {
  listGoals(): Promise<YandexGoal[]>;
  createActionGoal(name: (typeof REQUIRED_YANDEX_GOALS)[number]): Promise<YandexGoal>;
};

export class YandexApiError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'YandexApiError';
  }
}

export type YandexUploadResult = {
  uploadId: string;
  validationStatus: string;
  elementsCount: number;
};

export type YandexSimpleOrdersClient = {
  upload(order: YandexOrder): Promise<YandexUploadResult>;
  getUploadStatusPage(uploadId: string, cursor: string | null): Promise<{
    upload: YandexUploadResult | null;
    nextCursor: string | null;
    exhausted: boolean;
  }>;
};

export type YandexSimpleOrdersConfig = {
  counterId: number;
  oauthToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxFileBytes?: number;
};

type YandexRequest = (url: string, init: RequestInit) => Promise<unknown>;

function createYandexRequest(cfg: YandexSimpleOrdersConfig): YandexRequest {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 20_000;

  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: { Authorization: `OAuth ${cfg.oauthToken}`, ...init.headers },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new YandexApiError(
          `Yandex API request failed with status ${response.status}`,
          response.status >= 500 || response.status === 420 || response.status === 429,
          response.status,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new YandexApiError('Yandex API returned non-JSON response', false, response.status);
      }
    } catch (error) {
      if (error instanceof YandexApiError) throw error;
      throw new YandexApiError('Yandex API transport failed', true);
    } finally {
      clearTimeout(timer);
    }
  };
}

function parseGoal(value: unknown): YandexGoal {
  const row = value as Record<string, unknown>;
  if (!Number.isInteger(row?.id) || typeof row?.name !== 'string' || typeof row?.type !== 'string') {
    throw new YandexApiError('Yandex goal response is malformed', false);
  }
  const conditions = Array.isArray(row.conditions)
    ? row.conditions.map((condition) => {
        const item = condition as Record<string, unknown>;
        if (typeof item?.type !== 'string' || typeof item?.url !== 'string') {
          throw new YandexApiError('Yandex goal condition response is malformed', false);
        }
        return { type: item.type, url: item.url };
      })
    : undefined;
  return { id: row.id as number, name: row.name, type: row.type, conditions };
}

function isExactRequiredGoal(goal: YandexGoal, name: string): boolean {
  return goal.type === 'action' &&
    goal.conditions?.length === 1 &&
    goal.conditions[0]?.type === 'exact' &&
    goal.conditions[0]?.url === name;
}

export function createYandexGoalsClient(cfg: YandexSimpleOrdersConfig): YandexGoalsClient {
  const request = createYandexRequest(cfg);
  const url = `https://api-metrika.yandex.net/management/v1/counter/${cfg.counterId}/goals`;

  return {
    async listGoals() {
      const response = (await request(url, { method: 'GET' })) as { goals?: unknown[] };
      if (!Array.isArray(response.goals)) {
        throw new YandexApiError('Yandex goals response has no goals array', false);
      }
      return response.goals.map(parseGoal);
    },

    async createActionGoal(name) {
      const response = (await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: {
          name,
          type: 'action',
          conditions: [{ type: 'exact', url: name }],
        } }),
      })) as { goal?: unknown };
      return parseGoal(response.goal);
    },
  };
}

export async function ensureRequiredYandexGoals(client: YandexGoalsClient): Promise<YandexGoal[]> {
  let goals = await client.listGoals();
  let created = false;

  for (const name of REQUIRED_YANDEX_GOALS) {
    const matches = goals.filter((goal) => goal.name === name);
    if (matches.length > 1 || (matches[0] && !isExactRequiredGoal(matches[0], name))) {
      throw new YandexApiError(`Yandex goal conflicts with required action goal ${name}`, false);
    }
    if (matches.length === 0) {
      await client.createActionGoal(name);
      created = true;
    }
  }

  if (created) goals = await client.listGoals();
  const readBack = REQUIRED_YANDEX_GOALS.map((name) => {
    const matches = goals.filter((goal) => goal.name === name);
    if (matches.length !== 1 || !isExactRequiredGoal(matches[0]!, name)) {
      throw new YandexApiError(`required Yandex goal read-back failed for ${name}`, false);
    }
    return matches[0]!;
  });
  return readBack;
}

const CSV_HEADER = [
  'id',
  'create_date_time',
  'client_uniq_id',
  'client_ids',
  'emails',
  'phones',
  'order_status',
  'revenue',
  'cost',
  'goals',
  'currency',
];

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function metrikaDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) throw new Error(`invalid order date ${iso}`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.day}.${value.month}.${value.year} ${value.hour}:${value.minute}`;
}

export function simpleOrderCsv(order: YandexOrder): string {
  const row = [
    order.id,
    metrikaDateTime(order.createDateTime),
    order.clientUniqId,
    order.clientIds,
    '',
    '',
    order.status,
    order.revenue,
    '',
    '',
    order.currency,
  ];
  return `${CSV_HEADER.join(',')}\n${row.map(csvCell).join(',')}\n`;
}

function parseUploading(value: unknown): YandexUploadResult {
  const row = value as Record<string, unknown>;
  if (typeof row?.uploading_id !== 'string' || row.uploading_id.length === 0) {
    throw new YandexApiError('Yandex response has no uploading_id', false);
  }
  return {
    uploadId: row.uploading_id,
    validationStatus: String(row.api_validation_status ?? ''),
    elementsCount: Number(row.elements_count ?? 0),
  };
}

export function createYandexSimpleOrdersClient(
  cfg: YandexSimpleOrdersConfig,
): YandexSimpleOrdersClient {
  const request = createYandexRequest(cfg);
  const base = `https://api-metrika.yandex.net/cdp/api/v1/counter/${cfg.counterId}`;
  const maxFileBytes = cfg.maxFileBytes ?? 1_000_000_000;

  return {
    async upload(order) {
      const csv = simpleOrderCsv(order);
      if (new TextEncoder().encode(csv).byteLength > maxFileBytes) {
        throw new YandexApiError(
          `Yandex Simple Orders CSV exceeds ${maxFileBytes} byte limit`,
          false,
        );
      }
      const form = new FormData();
      form.append('file', new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'data.csv');
      const response = (await request(
        `${base}/data/simple_orders?merge_mode=SAVE&delimiter_type=COMMA`,
        { method: 'POST', body: form },
      )) as { uploading?: unknown };
      return parseUploading(response.uploading);
    },

    async getUploadStatusPage(uploadId, cursor) {
      const params = new URLSearchParams({ source: 'API', limit: '1000' });
      if (cursor) params.set('datetime_offset', cursor);
      const response = (await request(`${base}/last_uploadings?${params.toString()}`, {
        method: 'GET',
      })) as { uploadings?: unknown[] };
      const rows = response.uploadings ?? [];
      const found = rows.find(
        (item) => (item as Record<string, unknown>).uploading_id === uploadId,
      );
      if (found) return { upload: parseUploading(found), nextCursor: null, exhausted: true };
      if (rows.length < 1000) return { upload: null, nextCursor: null, exhausted: true };
      const oldest = rows.at(-1) as Record<string, unknown> | undefined;
      if (typeof oldest?.datetime !== 'string' || oldest.datetime.length === 0) {
        throw new YandexApiError('Yandex upload history page has no datetime cursor', false);
      }
      if (oldest.datetime === cursor) {
        throw new YandexApiError('Yandex upload history cursor did not advance', false);
      }
      return { upload: null, nextCursor: oldest.datetime, exhausted: false };
    },
  };
}
