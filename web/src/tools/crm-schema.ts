import { pathToFileURL } from 'node:url';

export type CrmSchemaField = {
  fieldName: string;
  userTypeId: 'string' | 'integer' | 'datetime';
  label: string;
  xmlId: string;
};

const field = (
  suffix: string,
  userTypeId: CrmSchemaField['userTypeId'],
  label: string,
): CrmSchemaField => ({
  fieldName: `UF_CRM_VELOCE_${suffix}`,
  userTypeId,
  label,
  xmlId: `VELOCE_ANALYTICS_V1_${suffix}`,
});

export const CRM_SCHEMA_MANIFEST: readonly CrmSchemaField[] = [
  field('ATTR_SCHEMA_VERSION', 'integer', 'Veloce: версия схемы атрибуции'),
  field('LEAD_EVENT_ID', 'string', 'Veloce: ID события заявки'),
  field('FIRST_SOURCE', 'string', 'Veloce: first-touch source'),
  field('FIRST_MEDIUM', 'string', 'Veloce: first-touch medium'),
  field('FIRST_CAMPAIGN', 'string', 'Veloce: first-touch campaign'),
  field('FIRST_CONTENT', 'string', 'Veloce: first-touch content'),
  field('FIRST_TERM', 'string', 'Veloce: first-touch term'),
  field('FIRST_LANDING', 'string', 'Veloce: first-touch landing'),
  field('FIRST_REFERRER', 'string', 'Veloce: first-touch referrer'),
  field('FIRST_CAPTURED_AT', 'datetime', 'Veloce: first-touch время'),
  field('LAST_LANDING', 'string', 'Veloce: last-touch landing'),
  field('LAST_REFERRER', 'string', 'Veloce: last-touch referrer'),
  field('LAST_CAPTURED_AT', 'datetime', 'Veloce: last-touch время'),
  field('YCLID', 'string', 'Veloce: Yandex click ID'),
  field('YM_CLIENT_ID', 'string', 'Veloce: Yandex Metrica client ID'),
  field('CONTACT_CHANNEL', 'string', 'Veloce: канал обращения'),
  field('CTA_PLACEMENT', 'string', 'Veloce: размещение CTA'),
  field('PAGE_PATH', 'string', 'Veloce: путь страницы'),
  field('PAGE_TYPE', 'string', 'Veloce: тип страницы'),
  field('FORM_ID', 'string', 'Veloce: ID формы'),
  field('SERVICE', 'string', 'Veloce: услуга'),
  field('CONSENT_VERSION', 'string', 'Veloce: версия согласия'),
  field('CONSENT_AT', 'datetime', 'Veloce: время согласия'),
];

export type BitrixDealUserField = {
  ID: string;
  FIELD_NAME: string;
  USER_TYPE_ID: string;
  XML_ID?: string;
  EDIT_FORM_LABEL?: string | Record<string, string>;
  LIST_COLUMN_LABEL?: string | Record<string, string>;
  LIST_FILTER_LABEL?: string | Record<string, string>;
  SHOW_IN_LIST?: string;
  EDIT_IN_LIST?: string;
};

type BitrixCall = (method: string, body?: object) => Promise<unknown>;

function localized(value: BitrixDealUserField['EDIT_FORM_LABEL']): string | undefined {
  return typeof value === 'string' ? value : value?.ru;
}

function assertPhysicalContract(actual: BitrixDealUserField, expected: CrmSchemaField): void {
  const mismatches: string[] = [];
  if (actual.USER_TYPE_ID !== expected.userTypeId) mismatches.push('USER_TYPE_ID');
  if (actual.XML_ID !== expected.xmlId) mismatches.push('XML_ID');
  if (localized(actual.EDIT_FORM_LABEL) !== expected.label) mismatches.push('EDIT_FORM_LABEL');
  if (localized(actual.LIST_COLUMN_LABEL) !== expected.label) mismatches.push('LIST_COLUMN_LABEL');
  if (localized(actual.LIST_FILTER_LABEL) !== expected.label) mismatches.push('LIST_FILTER_LABEL');
  if (actual.SHOW_IN_LIST !== 'Y') mismatches.push('SHOW_IN_LIST');
  if (actual.EDIT_IN_LIST !== 'Y') mismatches.push('EDIT_IN_LIST');
  if (mismatches.length > 0) {
    const actualContract = {
      USER_TYPE_ID: actual.USER_TYPE_ID,
      XML_ID: actual.XML_ID,
      EDIT_FORM_LABEL: actual.EDIT_FORM_LABEL,
      LIST_COLUMN_LABEL: actual.LIST_COLUMN_LABEL,
      LIST_FILTER_LABEL: actual.LIST_FILTER_LABEL,
      SHOW_IN_LIST: actual.SHOW_IN_LIST,
      EDIT_IN_LIST: actual.EDIT_IN_LIST,
    };
    throw new Error(
      `physical contract mismatch for ${expected.fieldName}: ${mismatches.join(', ')}; actual=${JSON.stringify(actualContract)}`,
    );
  }
}

async function readFields(call: BitrixCall): Promise<BitrixDealUserField[]> {
  const listed = (await call('crm.deal.userfield.list')) as BitrixDealUserField[];
  const manifestNames = new Set(CRM_SCHEMA_MANIFEST.map((item) => item.fieldName));
  return Promise.all(
    listed.map(async (item) => {
      if (!manifestNames.has(item.FIELD_NAME)) return item;
      const exact = (await call('crm.deal.userfield.get', {
        id: item.ID,
      })) as BitrixDealUserField | undefined;
      if (!exact) throw new Error(`userfield.get returned no field for ID ${item.ID}`);
      return exact;
    }),
  );
}

export async function reconcileCrmSchema(options: { apply: boolean; call: BitrixCall }) {
  const before = await readFields(options.call);
  const byName = new Map(before.map((item) => [item.FIELD_NAME, item]));
  const missing = CRM_SCHEMA_MANIFEST.filter((item) => !byName.has(item.fieldName));
  const created: string[] = [];

  for (const expected of CRM_SCHEMA_MANIFEST) {
    const actual = byName.get(expected.fieldName);
    if (actual) assertPhysicalContract(actual, expected);
  }

  if (options.apply) {
    for (const item of missing) {
      await options.call('crm.deal.userfield.add', {
        fields: {
          FIELD_NAME: item.fieldName,
          USER_TYPE_ID: item.userTypeId,
          XML_ID: item.xmlId,
          EDIT_FORM_LABEL: { ru: item.label },
          LIST_COLUMN_LABEL: { ru: item.label },
          LIST_FILTER_LABEL: { ru: item.label },
          SHOW_IN_LIST: 'Y',
          EDIT_IN_LIST: 'Y',
        },
      });
      created.push(item.fieldName);
    }
  }

  const after = options.apply
    ? await readFields(options.call)
    : before;
  const afterByName = new Map(after.map((item) => [item.FIELD_NAME, item]));
  const stillMissing = CRM_SCHEMA_MANIFEST.filter((item) => !afterByName.has(item.fieldName));
  const verified: string[] = [];
  for (const expected of CRM_SCHEMA_MANIFEST) {
    const actual = afterByName.get(expected.fieldName);
    if (!actual) continue;
    assertPhysicalContract(actual, expected);
    verified.push(expected.fieldName);
  }

  return { mode: options.apply ? 'apply' : 'dry-run', created, missing: stillMissing, verified };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--apply');
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(' ')}`);
  const webhookUrl = process.env.BITRIX24_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('BITRIX24_WEBHOOK_URL is required');
  const base = webhookUrl.endsWith('/') ? webhookUrl : `${webhookUrl}/`;

  async function rawCall(method: string, body: object): Promise<any> {
    const response = await fetch(`${base}${method}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as any;
    if (!response.ok || parsed.error) {
      throw new Error(`Bitrix24 ${method} failed: ${parsed.error_description ?? parsed.error}`);
    }
    return parsed;
  }

  const call: BitrixCall = async (method, body = {}) => {
    if (method !== 'crm.deal.userfield.list') return (await rawCall(method, body)).result;
    const all: BitrixDealUserField[] = [];
    let start = 0;
    do {
      const page = await rawCall(method, { ...body, start });
      all.push(...(page.result as BitrixDealUserField[]));
      if (page.next === undefined) break;
      start = Number(page.next);
    } while (true);
    return all;
  };

  const result = await reconcileCrmSchema({ apply, call });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.missing.length > 0) process.exitCode = apply ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
