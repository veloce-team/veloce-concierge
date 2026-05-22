import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Logger } from 'pino';
import { createRateLimit } from './middleware/rate-limit.js';

export type ServerHandlers = {
  lead: (c: Context) => Promise<Response> | Response;
  leadMaxbot: (c: Context) => Promise<Response> | Response;
  health: (c: Context) => Response;
};

export type ServerConfig = {
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
};

export function createServer(
  handlers: ServerHandlers,
  cfg: ServerConfig,
  logger: Logger,
) {
  const app = new Hono();

  app.use(
    '/api/*',
    cors({
      origin: cfg.corsOrigins,
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      credentials: false,
    }),
  );

  const rateLimit = createRateLimit({
    windowMs: cfg.rateLimitWindowMs,
    max: cfg.rateLimitMax,
  });

  app.get('/health', handlers.health);
  app.post('/api/lead', rateLimit, handlers.lead);
  app.post('/api/lead/maxbot', rateLimit, handlers.leadMaxbot);

  app.notFound((c) => c.json({ status: 'not_found' }, 404));
  app.onError((err, c) => {
    logger.error({ err }, 'http: unhandled error');
    return c.json({ status: 'error' }, 500);
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
