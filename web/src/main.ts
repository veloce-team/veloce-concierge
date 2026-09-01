import { parseEnv } from './config/env.js';
import { createHealthHandler, createReadinessHandler } from './adapters/http/routes/health.js';
import { createLeadHandler } from './adapters/http/routes/lead.js';
import { createLeadV1Handler } from './adapters/http/routes/lead-v1.js';
import { createServer, startServer } from './adapters/http/server.js';
import { startCleanupJob } from './infra/cleanup.js';
import { createLogger } from './infra/logger.js';
import { createAnalyticsRuntime } from './services/analytics/bootstrap.js';
import { createBitrix24Client } from './services/crm/bitrix24.js';
import { createIdempotencyStore } from './services/idempotency/store.js';
import { createOutboxQueue } from './services/outbox/queue.js';
import { createOutboxWorker } from './services/outbox/worker.js';
import {
  createLeadNotifier,
  createNullNotifier,
} from './services/notifications/lead-notifier.js';
import { assertCurrentSchema, openDb } from './services/sessions/db.js';

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger(env);
  const startedAtMs = Date.now();

  logger.info(
    { env: env.NODE_ENV, port: env.PORT },
    'concierge-web: starting',
  );

  const db = openDb(env.DB_PATH);
  assertCurrentSchema(db);

  const idempotency = createIdempotencyStore(db, env.IDEMPOTENCY_TTL_MS);
  const outbox = createOutboxQueue(db);
  const analytics = createAnalyticsRuntime(env, db, logger);

  const crm = createBitrix24Client({
    webhookUrl: env.BITRIX24_WEBHOOK_URL,
    assignedById: env.ASSIGNED_BY_ID,
  });

  const notifier =
    env.LEAD_NOTIFICATION_URL && env.LEAD_NOTIFICATION_SECRET
      ? createLeadNotifier({
          url: env.LEAD_NOTIFICATION_URL,
          secret: env.LEAD_NOTIFICATION_SECRET,
          logger: logger.child({ component: 'lead-notifier' }),
        })
      : createNullNotifier();

  if (env.LEAD_NOTIFICATION_URL) {
    logger.debug('notifier enabled');
  } else {
    logger.debug('notifier disabled');
  }

  const worker = createOutboxWorker({
    queue: outbox,
    crm,
    notifier,
    logger: logger.child({ component: 'outbox' }),
  });

  const lead = createLeadHandler({
    outbox,
    worker,
    idempotency,
    logger: logger.child({ component: 'lead' }),
    expectedSource: 'veloce_site',
  });

  const leadMaxbot = createLeadHandler({
    outbox,
    worker,
    idempotency,
    logger: logger.child({ component: 'lead-maxbot' }),
    expectedSource: 'maxbot_pro',
  });

  const leadV1 = createLeadV1Handler({
    outbox,
    worker,
    logger: logger.child({ component: 'lead-v1' }),
  });

  const app = createServer(
    {
      lead,
      leadV1,
      leadMaxbot,
      health: createHealthHandler(startedAtMs, () => ({
        analytics: analytics?.health() ?? { enabled: false, ready: true },
      })),
      readiness: createReadinessHandler(() => {
        const analyticsHealth = analytics?.health() ?? { enabled: false, ready: true };
        return { ready: analyticsHealth.ready, analytics: analyticsHealth };
      }),
    },
    {
      corsOrigins: env.CORS_ORIGINS,
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
      rateLimitMax: env.RATE_LIMIT_MAX,
    },
    logger,
  );

  const server = startServer(app, env.PORT, logger);
  worker.start();
  analytics?.start();
  logger.info({ analytics_enabled: analytics != null }, 'offline analytics runtime configured');
  const cleanup = startCleanupJob(
    db,
    logger.child({ component: 'cleanup' }),
    env.IDEMPOTENCY_TTL_MS,
  );

  let shuttingDown = false;
  async function shutdown(sig: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutdown: received signal');
    cleanup.stop();
    worker.stop();
    const closeServer = server.close();
    await analytics?.stop();
    await closeServer;
    try {
      db.close();
    } catch (err) {
      logger.error({ error_type: err instanceof Error ? err.name : 'UnknownError' }, 'shutdown: db close failed');
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
