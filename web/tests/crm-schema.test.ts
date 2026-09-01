import { describe, expect, it } from 'vitest';
import {
  CRM_SCHEMA_MANIFEST,
  reconcileCrmSchema,
  type BitrixDealUserField,
} from '../src/tools/crm-schema.js';

function existing(field = CRM_SCHEMA_MANIFEST[0]!): BitrixDealUserField {
  return {
    ID: '1',
    FIELD_NAME: field.fieldName,
    USER_TYPE_ID: field.userTypeId,
    XML_ID: field.xmlId,
    EDIT_FORM_LABEL: { ru: field.label },
    LIST_COLUMN_LABEL: { ru: field.label },
    LIST_FILTER_LABEL: { ru: field.label },
    SHOW_IN_LIST: 'Y',
    EDIT_IN_LIST: 'Y',
  };
}

describe('CRM schema reconciliation', () => {
  it('dry-run reports only missing fields and performs no writes', async () => {
    const calls: string[] = [];
    const result = await reconcileCrmSchema({
      apply: false,
      call: async (method) => {
        calls.push(method);
        return method === 'crm.deal.userfield.list' ? [existing()] : existing();
      },
    });

    expect(result.created).toEqual([]);
    expect(result.missing).toHaveLength(CRM_SCHEMA_MANIFEST.length - 1);
    expect(result.verified).toEqual([CRM_SCHEMA_MANIFEST[0]!.fieldName]);
    expect(calls).toEqual(['crm.deal.userfield.list', 'crm.deal.userfield.get']);
  });

  it('apply creates only missing fields and verifies the exact read-back', async () => {
    const fields: BitrixDealUserField[] = [existing()];
    const added: string[] = [];
    const result = await reconcileCrmSchema({
      apply: true,
      call: async (method, body) => {
        if (method === 'crm.deal.userfield.list') return fields;
        if (method === 'crm.deal.userfield.get') {
          return fields.find((field) => field.ID === (body as any).id);
        }
        const source = (body as any).fields;
        added.push(source.FIELD_NAME);
        const manifest = CRM_SCHEMA_MANIFEST.find((field) => field.fieldName === source.FIELD_NAME)!;
        const created = { ...existing(manifest), ID: String(fields.length + 1) };
        fields.push(created);
        return created.ID;
      },
    });

    expect(added).toEqual(CRM_SCHEMA_MANIFEST.slice(1).map((field) => field.fieldName));
    expect(result.missing).toEqual([]);
    expect(result.created).toEqual(added);
    expect(result.verified).toHaveLength(CRM_SCHEMA_MANIFEST.length);
  });

  it('always verifies every listed manifest field through userfield.get', async () => {
    const fields = CRM_SCHEMA_MANIFEST.map((manifest, index) => ({
      ...existing(manifest),
      ID: String(index + 1),
    }));
    const getIds: string[] = [];

    await reconcileCrmSchema({
      apply: false,
      call: async (method, body) => {
        if (method === 'crm.deal.userfield.list') return fields;
        if (method === 'crm.deal.userfield.get') {
          const id = String((body as any).id);
          getIds.push(id);
          return fields.find((field) => field.ID === id);
        }
        throw new Error(`unexpected method ${method}`);
      },
    });

    expect(getIds).toEqual(fields.map((field) => field.ID));
  });

  it('fails closed when an existing field has a conflicting physical contract', async () => {
    const stringField = CRM_SCHEMA_MANIFEST[1]!;
    const conflicting = { ...existing(stringField), USER_TYPE_ID: 'integer' };
    await expect(
      reconcileCrmSchema({
        apply: false,
        call: async (method) =>
          method === 'crm.deal.userfield.list' ? [conflicting] : conflicting,
      }),
    ).rejects.toThrow(/physical contract mismatch/);
  });
});
