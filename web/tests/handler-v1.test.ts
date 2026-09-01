import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createLeadV1Handler } from '../src/adapters/http/routes/lead-v1.js';
import { createOutboxQueue } from '../src/services/outbox/queue.js';
import { createOutboxWorker } from '../src/services/outbox/worker.js';
import type { CRMClient, CrmPayload } from '../src/services/crm/types.js';
import { validV1Body } from './schema-v1.test.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function setup(crm: CRMClient) {
  const db = new Database(':memory:');
  for (const migration of ['001-init.sql', '002-lead-event-id.sql']) {
    db.exec(
      readFileSync(join(HERE, '..', 'src/services/sessions/migrations', migration), 'utf8'),
    );
  }
  const logger = pino({ level: 'silent' });
  const outbox = createOutboxQueue(db);
  const worker = createOutboxWorker({ queue: outbox, crm, logger });
  const app = new Hono();
  app.post('/api/lead/v1', createLeadV1Handler({ outbox, worker, logger }));
  return { app, outbox, worker };
}

function request(app: Hono, body: object) {
  return app.request('/api/lead/v1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/lead/v1', () => {
  it('returns 200 only with a server-confirmed deal ID', async () => {
    const calls: CrmPayload[] = [];
    const { app, outbox } = setup({
      async createWebLead(payload) {
        calls.push(payload);
        return { contactId: 42, dealId: 99 };
      },
    });

    const response = await request(app, validV1Body);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      lead_event_id: validV1Body.lead_event_id,
      crm_entity_type: 'deal',
      crm_entity_id: '99',
    });
    expect(calls).toHaveLength(1);
    expect(outbox.getByLeadEventId(validV1Body.lead_event_id)).toMatchObject({
      status: 'sent',
      crmEntityId: '99',
    });
  });

  it('replays the durable confirmed response without a second CRM call', async () => {
    let calls = 0;
    const { app } = setup({
      async createWebLead() {
        calls += 1;
        return { contactId: 42, dealId: 99 };
      },
    });

    const first = await request(app, validV1Body);
    const duplicate = await request(app, { ...validV1Body, message: 'Изменённое тело' });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(await first.json());
    expect(calls).toBe(1);
  });

  it('returns retryable 503 and keeps the outbox pending after a transient CRM failure', async () => {
    const { app, outbox } = setup({
      async createWebLead() {
        throw new Error('temporary CRM outage');
      },
    });

    const response = await request(app, validV1Body);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      lead_event_id: validV1Body.lead_event_id,
      retryable: true,
    });
    expect(outbox.getByLeadEventId(validV1Body.lead_event_id)).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
  });

  it('rejects unknown keys without creating an outbox row', async () => {
    const { app, outbox } = setup({
      async createWebLead() {
        throw new Error('must not be called');
      },
    });

    const response = await request(app, { ...validV1Body, unknown: 'field' });

    expect(response.status).toBe(400);
    expect(outbox.getByLeadEventId(validV1Body.lead_event_id)).toBeNull();
  });

  it('rejects a non-empty honeypot under the strict v1 contract', async () => {
    const { app, outbox } = setup({
      async createWebLead() {
        throw new Error('must not be called');
      },
    });

    const response = await request(app, { ...validV1Body, website: 'spam' });

    expect(response.status).toBe(400);
    expect(outbox.getByLeadEventId(validV1Body.lead_event_id)).toBeNull();
  });
});
