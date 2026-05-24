import { createTgAdapter } from './adapters/tg/adapter.js';
import { createTgWebhookHandler } from './adapters/tg/webhook.js';
import { parseEnv } from './config/env.js';
import { startCleanupJob } from './infra/cleanup.js';
import { createHealthHandler } from './infra/http/health.js';
import { createMetricsHandler } from './infra/http/metrics.js';
import { createNotifyHandler } from './infra/http/notify-handler.js';
import { createServer, startServer } from './infra/http/server.js';
import { createLogger } from './infra/logger.js';
import { createBitrix24Client } from './services/crm/bitrix24.js';
import { createOutboxQueue } from './services/outbox/queue.js';
import { createOutboxWorker } from './services/outbox/worker.js';
import { openDb, runMigrations } from './services/sessions/db.js';
import { createSessionStore } from './services/sessions/store.js';

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger(env);
  const startedAtMs = Date.now();

  logger.info({ env: env.NODE_ENV, port: env.PORT }, 'concierge-bot: starting');

  const db = openDb(env.SQLITE_PATH);
  runMigrations(db);

  const sessions = createSessionStore(db);
  const outbox = createOutboxQueue(db);

  const tg = createTgAdapter(env.TG_BOT_TOKEN);
  const crm = createBitrix24Client({
    webhookUrl: env.BITRIX24_WEBHOOK_URL,
    dealCategoryId: env.BITRIX24_DEAL_CATEGORY_ID,
  });

  const worker = createOutboxWorker({
    queue: outbox,
    crm,
    logger: logger.child({ component: 'outbox' }),
  });

  function enqueueCrm(payload: Parameters<typeof outbox.enqueue>[0]): void {
    outbox.enqueue(payload);
    worker.tick().catch((err) => logger.error({ err }, 'tick after enqueue threw'));
  }

  const webhook = createTgWebhookHandler({
    adapter: tg,
    sessions,
    enqueueCrm,
    expectedSecret: env.TG_WEBHOOK_SECRET,
    logger: logger.child({ component: 'tg-webhook' }),
    bot: tg.bot,
  });

  const notifyLead = createNotifyHandler({
    bot: tg.bot,
    operatorChatId: env.OPERATOR_CHAT_ID,
    secret: env.LEAD_NOTIFICATION_SECRET,
    logger: logger.child({ component: 'notify-handler' }),
  });

  const app = createServer(
    {
      webhook,
      health: createHealthHandler(startedAtMs),
      metrics: createMetricsHandler({ db, sessions, outbox, startedAtMs }),
      notifyLead,
    },
    logger,
  );

  const server = startServer(app, env.PORT, logger);
  worker.start();
  const cleanup = startCleanupJob(db, logger.child({ component: 'cleanup' }));

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
