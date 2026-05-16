import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { Hono } from 'hono';
import { createLeadHandler } from '../src/adapters/http/routes/lead.js';
import { createIdempotencyStore } from '../src/services/idempotency/store.js';
import { createOutboxQueue } from '../src/services/outbox/queue.js';
import { createOutboxWorker } from '../src/services/outbox/worker.js';
import type { CRMClient, CrmPayload } from '../src/services/crm/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function setup() {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(
      join(HERE, '..', 'src/services/sessions/migrations/001-init.sql'),
      'utf8',
    ),
  );
  const calls: CrmPayload[] = [];
  const crm: CRMClient = {
    async createWebLead(p) {
      calls.push(p);
      return { contactId: 1, dealId: 2 };
    },
  };
  const logger = pino({ level: 'silent' });
  const outbox = createOutboxQueue(db);
  const worker = createOutboxWorker({ queue: outbox, crm, logger });
  const idempotency = createIdempotencyStore(db, 60_000);
  const handler = createLeadHandler({ outbox, worker, idempotency, logger });
  const app = new Hono();
  app.post('/api/lead', handler);
  return { app, calls, outbox };
}

describe('honeypot', () => {
  it('returns 200 with ref but does not enqueue or call CRM', async () => {
    const { app, calls, outbox } = setup();
    const r = await app.request('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Spam',
        email: 'spam@x.com',
        phone: '+79991234567',
        message: 'spam spam spam spam',
        source: 'veloce_site',
        channel: 'form',
        website: 'http://spam.example.com',
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('received');
    expect(calls.length).toBe(0);
    expect(outbox.countPending()).toBe(0);
  });
});
