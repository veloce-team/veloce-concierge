import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const base = {
  BITRIX24_WEBHOOK_URL: 'https://example.bitrix24.ru/rest/1/key/',
  ASSIGNED_BY_ID: '1',
  CORS_ORIGINS: '["https://veloce.team"]',
};

describe('offline analytics environment gate', () => {
  it('is disabled by default without requiring Yandex credentials', () => {
    const env = parseEnv(base);
    expect(env.ANALYTICS_ENABLED).toBe(false);
  });

  it('parses the complete enabled worker configuration', () => {
    const env = parseEnv({
      ...base,
      ANALYTICS_ENABLED: 'true',
      BITRIX24_PORTAL_ID: 'member-portal-1',
      YANDEX_METRIKA_COUNTER_ID: '109782828',
      YANDEX_OAUTH_TOKEN: 'secret-token',
      ANALYTICS_POLL_INTERVAL_MS: '300000',
      ANALYTICS_OUTBOX_ALERT_THRESHOLD: '50',
    });
    expect(env).toMatchObject({
      ANALYTICS_ENABLED: true,
      BITRIX24_PORTAL_ID: 'member-portal-1',
      YANDEX_METRIKA_COUNTER_ID: 109782828,
      YANDEX_OAUTH_TOKEN: 'secret-token',
      ANALYTICS_POLL_INTERVAL_MS: 300000,
      ANALYTICS_OUTBOX_ALERT_THRESHOLD: 50,
    });
  });
});
