import Database from 'better-sqlite3';
import pino from 'pino';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { createAnalyticsRuntime } from '../src/services/analytics/bootstrap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = {
  BITRIX24_WEBHOOK_URL: 'https://example.bitrix24.ru/rest/1/key/',
  ASSIGNED_BY_ID: '1',
  CORS_ORIGINS: '["https://veloce.team"]',
};

function db() {
  const database = new Database(':memory:');
  for (const name of ['001-init.sql', '002-lead-event-id.sql', '003-offline-analytics.sql']) {
    database.exec(readFileSync(join(HERE, '..', 'src/services/sessions/migrations', name), 'utf8'));
  }
  return database;
}

describe('analytics runtime bootstrap', () => {
  it('does not construct a live worker while disabled', () => {
    expect(createAnalyticsRuntime(parseEnv(base), db(), pino({ enabled: false }))).toBeNull();
  });

  it('constructs the worker only from a complete enabled environment', () => {
    const env = parseEnv({
      ...base,
      ANALYTICS_ENABLED: 'true',
      BITRIX24_PORTAL_ID: 'member-1',
      YANDEX_METRIKA_COUNTER_ID: '109782828',
      YANDEX_OAUTH_TOKEN: 'secret-token',
    });
    expect(createAnalyticsRuntime(env, db(), pino({ enabled: false }))).toMatchObject({
      start: expect.any(Function),
      stop: expect.any(Function),
      tickPoll: expect.any(Function),
      tickUpload: expect.any(Function),
      tickReconcile: expect.any(Function),
    });
  });
});
