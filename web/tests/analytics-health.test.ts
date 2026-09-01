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
});
