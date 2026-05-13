import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import type { Logger } from 'pino';

export type ServerHandlers = {
  webhook: (c: Context) => Promise<Response> | Response;
  health: (c: Context) => Response;
  metrics: (c: Context) => Response;
};

export function createServer(handlers: ServerHandlers, logger: Logger) {
  const app = new Hono();

  app.post('/webhook/tg', handlers.webhook);
  app.get('/health', handlers.health);
  app.get('/metrics', handlers.metrics);

  app.notFound((c) => c.json({ ok: false, error: 'not found' }, 404));
  app.onError((err, c) => {
    logger.error({ err }, 'http: unhandled error');
    return c.json({ ok: false, error: 'internal error' }, 500);
  });

  return app;
}

export function startServer(
  app: ReturnType<typeof createServer>,
  port: number,
  logger: Logger,
): { close: () => Promise<void> } {
  const server = serve({ fetch: app.fetch, port });
  logger.info({ port }, 'http: listening');
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
