import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import { formatLeadMessage } from '../../services/notifications/format.js';

const LeadPayloadSchema = z.object({
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  message: z.string(),
  source: z.string(),
  channel: z.string(),
  landing: z.string().nullish(),
  intent: z.string().nullish(),
  product: z.string().nullish(),
  contactId: z.number().nullish(),
  dealId: z.number().nullish(),
  sourceId: z.string().nullish(),
});

export type NotifyHandlerDeps = {
  bot: Bot;
  operatorChatId: string;
  secret: string;
  logger: Logger;
};

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createNotifyHandler(
  deps: NotifyHandlerDeps,
): (c: Context) => Promise<Response> {
  const { bot, operatorChatId, secret, logger: log } = deps;

  return async (c) => {
    const start = Date.now();

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      log.warn('notify-lead: missing Authorization header');
      return c.json({ error: 'unauthorized' }, 401);
    }

    const token = authHeader.slice(7);
    if (!safeEqual(token, secret)) {
      log.warn('notify-lead: invalid Bearer token');
      return c.json({ error: 'unauthorized' }, 401);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }

    const parsed = LeadPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: 'validation failed', issues: parsed.error.issues },
        400,
      );
    }

    const payload = parsed.data;
    const html = formatLeadMessage(payload);

    try {
      await bot.api.sendMessage(operatorChatId, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      log.error({ err, latency_ms: Date.now() - start }, 'notify-lead: sendMessage failed');
      return c.json({ error: 'telegram send failed' }, 500);
    }

    log.info({ latency_ms: Date.now() - start }, 'notify-lead: sent');
    return c.json({ status: 'sent' }, 200);
  };
}
