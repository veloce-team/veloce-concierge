import { parseEnv } from './config/env.js';
import { createHealthHandler } from './adapters/http/routes/health.js';
import { createLeadHandler } from './adapters/http/routes/lead.js';
import { createServer, startServer } from './adapters/http/server.js';
import { startCleanupJob } from './infra/cleanup.js';
import { createLogger } from './infra/logger.js';
import { createBitrix24Client } from './services/crm/bitrix24.js';
import { createIdempotencyStore } from './services/idempotency/store.js';
import { createOutboxQueue } from './services/outbox/queue.js';
import { createOutboxWorker } from './services/outbox/worker.js';
import {
  createLeadNotifier,
  createNullNotifier,
} from './services/notifications/lead-notifier.js';
import { openDb, runMigrations } from './services/sessions/db.js';

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger(env);
  const startedAtMs = Date.now();

  logger.info(
    { env: env.NODE_ENV, port: env.PORT },
    'concierge-web: starting',
  );

  const db = openDb(env.DB_PATH);
  runMigrations(db);

  const idempotency = createIdempotencyStore(db, env.IDEMPOTENCY_TTL_MS);
  const outbox = createOutboxQueue(db);

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

  const app = createServer(
    { lead, leadMaxbot, health: createHealthHandler(startedAtMs) },
    {
      corsOrigins: env.CORS_ORIGINS,
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
      rateLimitMax: env.RATE_LIMIT_MAX,
    },
    logger,
  );

  const server = startServer(app, env.PORT, logger);
  worker.start();
  const cleanup = startCleanupJob(
    db,
    logger.child({ component: 'cleanup' }),
    env.IDEMPOTENCY_TTL_MS,
  );

  function shutdown(sig: string): void {
    logger.info({ sig }, 'shutdown: received signal');
    cleanup.stop();
    worker.stop();
    server.close().finally(() => {
      try {
        db.close();
      } catch (err) {
        logger.error({ err }, 'shutdown: db close failed');
      }
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
