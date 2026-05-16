import type { Context, MiddlewareHandler } from 'hono';

export type RateLimitConfig = {
  windowMs: number;
  max: number;
  now?: () => number;
};

type Entry = { count: number; resetAt: number };

export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip') ?? 'unknown';
}

export function createRateLimit(cfg: RateLimitConfig): MiddlewareHandler {
  const now = cfg.now ?? (() => Date.now());
  const buckets = new Map<string, Entry>();

  return async (c, next) => {
    const ip = clientIp(c);
    const t = now();
    let entry = buckets.get(ip);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + cfg.windowMs };
      buckets.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > cfg.max) {
      const retry = Math.max(0, Math.ceil((entry.resetAt - t) / 1000));
      c.header('Retry-After', String(retry));
      return c.json(
        { status: 'rate_limited', retry_after_seconds: retry },
        429,
      );
    }
    await next();
  };
}
