import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Logger } from 'pino';
import { LeadSchema, type Lead } from '../../../schema/lead.js';
import { resolveWebSource, type WebSource } from '../../../config/sources.js';
import type { CrmPayload } from '../../../services/crm/types.js';
import type { IdempotencyStore } from '../../../services/idempotency/store.js';
import type { OutboxQueue } from '../../../services/outbox/queue.js';
import type { OutboxWorker } from '../../../services/outbox/worker.js';
import { clientIp } from '../middleware/rate-limit.js';

export type LeadHandlerDeps = {
  outbox: OutboxQueue;
  worker: OutboxWorker;
  idempotency: IdempotencyStore;
  logger: Logger;
  now?: () => number;
  /**
   * Если задан — handler возвращает 400, когда payload.source не совпадает
   * с этим значением. Используется для сегрегации route'ов:
   * /api/lead принимает только veloce_site, /api/lead/maxbot — только maxbot_pro.
   */
  expectedSource?: WebSource;
};

function shortRef(): string {
  return randomUUID().slice(0, 8);
}

export function createLeadHandler(deps: LeadHandlerDeps) {
  const now = deps.now ?? (() => Date.now());

  return async function leadHandler(c: Context): Promise<Response> {
    const start = now();
    const ip = clientIp(c);
    const log = deps.logger.child({ route: 'POST /api/lead', ip });

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log.warn('invalid json');
      return c.json(
        { status: 'invalid', errors: [{ field: '(root)', message: 'invalid JSON' }] },
        400,
      );
    }

    // Honeypot — до Zod, чтобы не светить причину боту.
    const website = (body as { website?: unknown })?.website;
    if (typeof website === 'string' && website.length > 0) {
      const ref = shortRef();
      log.warn({ lead_ref: ref, honeypot: true }, 'honeypot triggered');
      return c.json({ status: 'received', ref }, 200);
    }

    const parsed = LeadSchema.safeParse(body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      }));
      log.warn({ errors }, 'validation failed');
      return c.json({ status: 'invalid', errors }, 400);
    }

    const lead: Lead = parsed.data;

    if (deps.expectedSource && lead.source !== deps.expectedSource) {
      log.warn(
        { got: lead.source, expected: deps.expectedSource },
        'source/route mismatch',
      );
      return c.json(
        {
          status: 'invalid',
          errors: [{ field: 'source', message: 'unexpected source for this route' }],
        },
        400,
      );
    }

    const sourceId = resolveWebSource(lead.source);
    if (!sourceId) {
      log.error({ source: lead.source }, 'unknown source after schema');
      return c.json(
        { status: 'invalid', errors: [{ field: 'source', message: 'unknown source' }] },
        400,
      );
    }

    const idemKey = deps.idempotency.hash(lead);
    const cached = deps.idempotency.lookup(idemKey, now());
    if (cached) {
      log.info({ lead_ref: '(cached)', latency_ms: now() - start }, 'idempotent hit');
      return new Response(cached.responseJson, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const ref = shortRef();
    const payload: CrmPayload = { ...lead, sourceId };

    try {
      deps.outbox.enqueue(payload);
    } catch (err) {
      log.error({ err, lead_ref: ref }, 'outbox enqueue failed');
      return c.json({ status: 'error', ref }, 500);
    }

    const responseBody = JSON.stringify({ status: 'received', ref });
    try {
      deps.idempotency.remember(idemKey, responseBody, now());
    } catch (err) {
      log.warn({ err, lead_ref: ref }, 'idempotency remember failed (non-fatal)');
    }

    // Запускаем воркер сразу — он обработает доставку в Б24 в фоне.
    deps.worker.tick().catch((err) =>
      log.error({ err }, 'tick after enqueue threw'),
    );

    log.info(
      { lead_ref: ref, latency_ms: now() - start, channel: lead.channel },
      'lead accepted',
    );
    return new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
