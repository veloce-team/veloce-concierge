import type { Context } from 'hono';
import type { Logger } from 'pino';
import { handleUpdate } from '../../core/dialog/state-machine.js';
import type {
  BotAdapter,
  CrmPayload,
  IncomingMessage,
  SessionStore,
  SideEffect,
} from '../../core/dialog/types.js';
import { resolveSourceId } from '../../config/sources.js';
import { parseTgUpdate } from './mappers.js';

export type TgWebhookDeps = {
  adapter: BotAdapter;
  sessions: SessionStore;
  enqueueCrm: (payload: CrmPayload) => void;
  expectedSecret: string;
  logger: Logger;
  bot: { api: { answerCallbackQuery(id: string): Promise<unknown> } };
};

export function createTgWebhookHandler(deps: TgWebhookDeps) {
  return async function tgWebhook(c: Context): Promise<Response> {
    const secret = c.req.header('x-telegram-bot-api-secret-token');
    if (secret !== deps.expectedSecret) {
      deps.logger.warn('webhook: invalid secret token');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid json' }, 400);
    }

    const parsed = parseTgUpdate(body);
    if (!parsed || !parsed.chatId) {
      // Unknown shape — acknowledge so TG doesn't retry forever.
      return c.json({ ok: true });
    }

    const log = deps.logger.child({
      chat_id: parsed.chatId,
      update_id: parsed.updateId,
    });

    const fresh = deps.sessions.markProcessed('tg', parsed.updateId);
    if (!fresh) {
      log.info('webhook: duplicate update, skipping');
      return c.json({ ok: true });
    }

    if (parsed.callbackQueryId) {
      deps.bot.api.answerCallbackQuery(parsed.callbackQueryId).catch((err) => {
        log.warn({ err }, 'answerCallbackQuery failed');
      });
    }

    const incoming: IncomingMessage = {
      platform: 'tg',
      chatId: parsed.chatId,
      updateId: parsed.updateId,
      text: parsed.text,
      callbackData: parsed.callbackData,
      contact: parsed.contact,
      isCommand: parsed.isCommand,
      command: parsed.command,
      startParam: parsed.startParam,
    };

    if (parsed.startParam) {
      const { known } = resolveSourceId(parsed.startParam);
      if (!known) {
        log.warn({ start_param: parsed.startParam }, 'unknown start_param, using default source');
      }
    }

    const ctx = deps.sessions.load('tg', parsed.chatId);
    const start = Date.now();
    const result = handleUpdate(ctx, incoming);
    deps.sessions.save('tg', parsed.chatId, result.next);

    const sceLog = log.child({
      scenario: result.next.scenario,
      step: result.next.step,
    });

    for (const out of result.outgoing) {
      try {
        await deps.adapter.send(parsed.chatId, out);
      } catch (err) {
        sceLog.error({ err }, 'send failed');
      }
    }

    for (const eff of result.sideEffects ?? []) {
      applySideEffect(deps, eff, sceLog);
    }

    sceLog.info({ latency_ms: Date.now() - start }, 'update handled');
    return c.json({ ok: true });
  };
}

function applySideEffect(
  deps: TgWebhookDeps,
  eff: SideEffect,
  log: Logger,
): void {
  if (eff.kind === 'enqueue_crm') {
    try {
      deps.enqueueCrm(eff.payload);
    } catch (err) {
      log.error({ err }, 'enqueueCrm failed');
    }
  }
}
