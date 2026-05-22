import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { createServer } from '../src/adapters/http/server.js';
import { createHealthHandler } from '../src/adapters/http/routes/health.js';
import { createLeadHandler } from '../src/adapters/http/routes/lead.js';
import { createIdempotencyStore } from '../src/services/idempotency/store.js';
import { createOutboxQueue } from '../src/services/outbox/queue.js';
import { createOutboxWorker } from '../src/services/outbox/worker.js';
import type { CRMClient, CrmPayload } from '../src/services/crm/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const db = new Database(':memory:');
  const sql = readFileSync(
    join(HERE, '..', 'src/services/sessions/migrations/001-init.sql'),
    'utf8',
  );
  db.exec(sql);
  return db;
}

function makeApp(crm: CRMClient) {
  const db = makeDb();
  const logger = pino({ level: 'silent' });
  const idempotency = createIdempotencyStore(db, 60_000);
  const outbox = createOutboxQueue(db);
  const worker = createOutboxWorker({ queue: outbox, crm, logger });
  const lead = createLeadHandler({
    outbox,
    worker,
    idempotency,
    logger,
    expectedSource: 'veloce_site',
  });
  const leadMaxbot = createLeadHandler({
    outbox,
    worker,
    idempotency,
    logger,
    expectedSource: 'maxbot_pro',
  });
  return {
    app: createServer(
      { lead, leadMaxbot, health: createHealthHandler(Date.now()) },
      {
        corsOrigins: ['https://veloce.team', 'https://maxbot-pro.ru'],
        rateLimitWindowMs: 60_000,
        rateLimitMax: 100,
      },
      logger,
    ),
    outbox,
    worker,
  };
}

async function flush(worker: { tick: (now?: number) => Promise<void> }) {
  await worker.tick();
}

const validBody = {
  name: 'Иван',
  email: 'i@example.com',
  phone: '+79991234567',
  message: 'Длинное сообщение для теста',
  source: 'veloce_site',
  channel: 'form',
};

function fakeCrm(calls: CrmPayload[] = []): { crm: CRMClient; calls: CrmPayload[] } {
  return {
    calls,
    crm: {
      async createWebLead(payload: CrmPayload) {
        calls.push(payload);
        return { contactId: 42, dealId: 99 };
      },
    },
  };
}

describe('POST /api/lead', () => {
  let env: ReturnType<typeof makeApp>;
  let crmCalls: CrmPayload[];

  beforeEach(() => {
    crmCalls = [];
    const { crm } = fakeCrm(crmCalls);
    env = makeApp(crm);
  });

  it('200 + delivers to CRM on valid payload', async () => {
    const r = await env.app.request('/api/lead', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://veloce.team',
      },
      body: JSON.stringify(validBody),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('received');
    expect(typeof body.ref).toBe('string');
    await flush(env.worker);
    expect(crmCalls.length).toBe(1);
    expect(crmCalls[0]!.sourceId).toBe('VELOCE_SITE');
    expect(crmCalls[0]!.channel).toBe('form');
  });

  it('400 on invalid payload', async () => {
    const r = await env.app.request('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, email: 'bad' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.status).toBe('invalid');
    expect(body.errors.some((e: any) => e.field === 'email')).toBe(true);
  });

  it('honeypot — 200 but no CRM call', async () => {
    const r = await env.app.request('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, website: 'http://spam.example.com' }),
    });
    expect(r.status).toBe(200);
    await flush(env.worker);
    expect(crmCalls.length).toBe(0);
  });

  it('idempotency — second identical request returns cached, single CRM call', async () => {
    const send = () =>
      env.app.request('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
    const r1 = await send();
    await flush(env.worker);
    const r2 = await send();
    await flush(env.worker);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b2.ref).toBe(b1.ref);
    expect(crmCalls.length).toBe(1);
  });

  it('CORS preflight OPTIONS returns allow headers', async () => {
    const r = await env.app.request('/api/lead', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://veloce.team',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://veloce.team');
    expect(r.headers.get('access-control-allow-methods') ?? '').toContain('POST');
  });

  it('/health returns ok', async () => {
    const r = await env.app.request('/health');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
  });
});

describe('expectedSource route segregation', () => {
  let env: ReturnType<typeof makeApp>;
  let crmCalls: CrmPayload[];

  beforeEach(() => {
    crmCalls = [];
    const { crm } = fakeCrm(crmCalls);
    env = makeApp(crm);
  });

  const maxbotBody = {
    name: 'Анна',
    email: 'a@example.com',
    phone: '+79991112233',
    message: 'Заявка с гос-посадочной max-microsite',
    source: 'maxbot_pro',
    channel: 'form',
    landing: 'gos',
    intent: 'kp',
    product: 'miniapp',
  };

  it('POST /api/lead/maxbot c maxbot_pro → 200 + CRM call', async () => {
    const r = await env.app.request('/api/lead/maxbot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maxbotBody),
    });
    expect(r.status).toBe(200);
    await flush(env.worker);
    expect(crmCalls.length).toBe(1);
    expect(crmCalls[0]!.sourceId).toBe('MAXBOT_PRO');
    expect(crmCalls[0]!.landing).toBe('gos');
  });

  it('POST /api/lead/maxbot c veloce_site → 400, без CRM call', async () => {
    const r = await env.app.request('/api/lead/maxbot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, source: 'veloce_site' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.status).toBe('invalid');
    expect(body.errors[0].field).toBe('source');
    expect(body.errors[0].message).toBe('unexpected source for this route');
    await flush(env.worker);
    expect(crmCalls.length).toBe(0);
  });

  it('POST /api/lead c maxbot_pro → 400, без CRM call', async () => {
    const r = await env.app.request('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maxbotBody),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.errors[0].field).toBe('source');
    await flush(env.worker);
    expect(crmCalls.length).toBe(0);
  });

  it('POST /api/lead c veloce_site → 200 (backward-compat)', async () => {
    const r = await env.app.request('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(r.status).toBe(200);
    await flush(env.worker);
    expect(crmCalls.length).toBe(1);
    expect(crmCalls[0]!.sourceId).toBe('VELOCE_SITE');
  });
});
