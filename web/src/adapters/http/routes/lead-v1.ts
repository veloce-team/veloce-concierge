import type { Context } from 'hono';
import type { Logger } from 'pino';
import { LeadV1Schema } from '../../../schema/lead-v1.js';
import type { CrmPayload } from '../../../services/crm/types.js';
import type { OutboxQueue } from '../../../services/outbox/queue.js';
import type { OutboxWorker } from '../../../services/outbox/worker.js';

export type LeadV1HandlerDeps = {
  outbox: OutboxQueue;
  worker: OutboxWorker;
  logger: Logger;
};

export function createLeadV1Handler(deps: LeadV1HandlerDeps) {
  return async function leadV1Handler(c: Context): Promise<Response> {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, errors: [{ field: '(root)', message: 'invalid JSON' }] }, 400);
    }

    const parsed = LeadV1Schema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          errors: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        },
        400,
      );
    }

    const lead = parsed.data;
    const payload: CrmPayload = { ...lead, sourceId: 'VELOCE_SITE' };

    try {
      deps.outbox.enqueueV1(payload);
      const existing = deps.outbox.getByLeadEventId(lead.lead_event_id);
      if (existing?.status !== 'sent') await deps.worker.tick();
    } catch (error) {
      deps.logger.error({ err: error, lead_event_id: lead.lead_event_id }, 'v1 intake failed');
      return c.json({ ok: false, lead_event_id: lead.lead_event_id, retryable: true }, 503);
    }

    const record = deps.outbox.getByLeadEventId(lead.lead_event_id);
    if (record?.status === 'sent' && record.crmEntityType === 'deal' && record.crmEntityId) {
      return c.json({
        ok: true,
        lead_event_id: lead.lead_event_id,
        crm_entity_type: 'deal' as const,
        crm_entity_id: record.crmEntityId,
      });
    }

    if (record?.status === 'failed') {
      return c.json({ ok: false, lead_event_id: lead.lead_event_id, retryable: false }, 502);
    }

    c.header('Retry-After', '5');
    return c.json({ ok: false, lead_event_id: lead.lead_event_id, retryable: true }, 503);
  };
}
