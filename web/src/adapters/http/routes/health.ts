import type { Context } from 'hono';

export function createHealthHandler(startedAtMs: number) {
  return function health(c: Context): Response {
    const uptime_s = Math.floor((Date.now() - startedAtMs) / 1000);
    return c.json({ status: 'ok', uptime_s });
  };
}
