import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createHealthHandler, createReadinessHandler } from '../src/adapters/http/routes/health.js';
import { createServer } from '../src/adapters/http/server.js';

function app(readiness: () => { ready: boolean; analytics: unknown }) {
  const lead = () => new Response(null, { status: 204 });
  return createServer(
    {
      lead,
      leadMaxbot: lead,
      health: createHealthHandler(Date.now(), () => ({ analytics: { enabled: true } })),
      readiness: createReadinessHandler(readiness),
    },
    { corsOrigins: [], rateLimitWindowMs: 1_000, rateLimitMax: 1 },
    pino({ enabled: false }),
  );
}

describe('health and readiness', () => {
  it('keeps liveness healthy while reporting bounded component state', async () => {
    const response = await app(() => ({ ready: false, analytics: { ready: false } })).request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      components: { analytics: { enabled: true } },
    });
  });

  it('returns 503 until the analytics lifecycle is ready, then 200', async () => {
    let ready = false;
    const server = app(() => ({ ready, analytics: { ready } }));

    const unavailable = await server.request('/ready');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ status: 'not_ready' });

    ready = true;
    const available = await server.request('/ready');
    expect(available.status).toBe(200);
    expect(await available.json()).toMatchObject({ status: 'ready' });
  });

  it('publishes only the allowlisted operational readiness schema', async () => {
    const server = app(() => ({
      ready: false,
      secret: 'must-not-leak',
      analytics: {
        enabled: true,
        ready: false,
        started: true,
        stopping: false,
        running: { poll: false, upload: false, reconcile: false },
        lastSuccessAt: { poll: 1, upload: 2, reconcile: 3, arbitrary: 4 },
        lastFailureAt: { poll: 5, upload: null, reconcile: null },
        issues: ['outbox:retry', 'semantic:unknown_category', 'raw:customer@example.com'],
        outbox: {
          counts: { retry: 1, clean: 2, arbitrary_status: 99 },
          deliverableBacklog: 1,
          terminal: 0,
          payload: { email: 'customer@example.com' },
        },
        limits: {
          outboxAlertThreshold: 5,
          staleAfterMs: { poll: 900_000, upload: 300_000, reconcile: 600_000, arbitrary: 1 },
        },
        oauthToken: 'must-not-leak',
      },
    }));

    const response = await server.request('/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      analytics: {
        enabled: true,
        ready: false,
        issues: ['outbox:retry', 'semantic:unknown_category'],
        lastSuccessAt: { poll: 1, upload: 2, reconcile: 3 },
        outbox: { counts: { retry: 1, clean: 2 }, deliverableBacklog: 1, terminal: 0 },
        limits: {
          outboxAlertThreshold: 5,
          staleAfterMs: { poll: 900_000, upload: 300_000, reconcile: 600_000 },
        },
      },
      status: 'not_ready',
    });
  });

  it('serves readiness only on the exact GET endpoint', async () => {
    const server = app(() => ({ ready: true, analytics: { enabled: false, ready: true } }));
    expect((await server.request('/ready')).status).toBe(200);
    expect((await server.request('/ready/extra')).status).toBe(404);
    expect((await server.request('/ready', { method: 'POST' })).status).toBe(404);
  });
});
