import pino, { type Logger } from 'pino';
import type { Env } from '../config/env.js';

export type LogContext = {
  chat_id?: string;
  update_id?: string;
  scenario?: string;
  step?: string;
  [key: string]: unknown;
};

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  const isDev = env.NODE_ENV === 'development';
  return pino({
    level: env.LOG_LEVEL,
    base: { service: 'concierge-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
          },
        }
      : {}),
  });
}

export function childFor(logger: Logger, ctx: LogContext): Logger {
  return logger.child(ctx);
}

export function withLatency<T>(
  logger: Logger,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  return fn().then(
    (value) => {
      logger.info({ latency_ms: Date.now() - start, op: label }, `${label} ok`);
      return value;
    },
    (err: unknown) => {
      logger.error(
        { latency_ms: Date.now() - start, op: label, err },
        `${label} failed`,
      );
      throw err;
    },
  );
}
