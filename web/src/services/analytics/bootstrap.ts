import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import { createBitrixAnalyticsClient } from './bitrix.js';
import { createAnalyticsRepository } from './repository.js';
import { createAnalyticsWorker, type AnalyticsWorker } from './worker.js';
import { createYandexSimpleOrdersClient } from './yandex.js';

export function createAnalyticsRuntime(
  env: Env,
  db: Db,
  logger: Logger,
): AnalyticsWorker | null {
  if (!env.ANALYTICS_ENABLED) return null;
  if (!env.BITRIX24_PORTAL_ID || !env.YANDEX_METRIKA_COUNTER_ID || !env.YANDEX_OAUTH_TOKEN) {
    throw new Error('analytics enabled without complete environment');
  }
  const repository = createAnalyticsRepository(db);
  return createAnalyticsWorker({
    bitrix: createBitrixAnalyticsClient({
      webhookUrl: env.BITRIX24_WEBHOOK_URL,
      portalId: env.BITRIX24_PORTAL_ID,
    }),
    repository,
    yandex: createYandexSimpleOrdersClient({
      counterId: env.YANDEX_METRIKA_COUNTER_ID,
      oauthToken: env.YANDEX_OAUTH_TOKEN,
    }),
    logger: logger.child({ component: 'offline-analytics' }),
    pollIntervalMs: env.ANALYTICS_POLL_INTERVAL_MS,
    uploadIntervalMs: env.ANALYTICS_UPLOAD_INTERVAL_MS,
    reconcileIntervalMs: env.ANALYTICS_RECONCILE_INTERVAL_MS,
    outboxAlertThreshold: env.ANALYTICS_OUTBOX_ALERT_THRESHOLD,
  });
}
