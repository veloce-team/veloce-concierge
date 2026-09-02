import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const caddy = readFileSync('../infra/caddy/Caddyfile', 'utf8');

describe('public operational readiness route', () => {
  it('proxies only the exact public readiness endpoint to concierge', () => {
    expect(caddy).toContain('@web path /api/lead* /health /ready');
    expect(caddy).toContain('reverse_proxy concierge-web:3000');
  });
});
