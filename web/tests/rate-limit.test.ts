import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRateLimit } from '../src/adapters/http/middleware/rate-limit.js';

function buildApp(now: () => number) {
  const app = new Hono();
  app.use('*', createRateLimit({ windowMs: 10_000, max: 3, now }));
  app.post('/x', (c) => c.json({ ok: true }));
  return app;
}

async function post(app: Hono, ip = '1.2.3.4') {
  return app.request('/x', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });
}

describe('rate-limit middleware', () => {
  it('allows up to max, blocks beyond', async () => {
    let t = 1_000_000;
    const app = buildApp(() => t);

    for (let i = 0; i < 3; i++) {
      const r = await post(app);
      expect(r.status).toBe(200);
    }
    const blocked = await post(app);
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.status).toBe('rate_limited');
    expect(typeof body.retry_after_seconds).toBe('number');
  });

  it('resets after window', async () => {
    let t = 1_000_000;
    const app = buildApp(() => t);

    for (let i = 0; i < 3; i++) await post(app);
    expect((await post(app)).status).toBe(429);
    t += 11_000;
    expect((await post(app)).status).toBe(200);
  });

  it('isolates buckets by IP', async () => {
    let t = 1_000_000;
    const app = buildApp(() => t);

    for (let i = 0; i < 3; i++) await post(app, '1.1.1.1');
    expect((await post(app, '1.1.1.1')).status).toBe(429);
    expect((await post(app, '2.2.2.2')).status).toBe(200);
  });
});
