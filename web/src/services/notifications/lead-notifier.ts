import type { Logger } from 'pino';
import type { CrmPayload } from '../crm/types.js';

export type LeadNotifierDeps = {
  url: string;
  secret: string;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type LeadNotifier = {
  notify(payload: CrmPayload): Promise<void>;
};

export function createLeadNotifier(deps: LeadNotifierDeps): LeadNotifier {
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const log = deps.logger;

  return {
    async notify(payload) {
      const start = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await (deps.fetch ?? globalThis.fetch)(deps.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${deps.secret}`,
          },
          body: JSON.stringify({
            name: payload.name,
            email: payload.email,
            phone: payload.phone,
            message: payload.message,
            source: payload.source,
            channel: payload.channel,
            landing: payload.landing ?? null,
            intent: payload.intent ?? null,
            product: payload.product ?? null,
            contactId: payload.contactId ?? null,
            dealId: payload.dealId ?? null,
            sourceId: payload.sourceId,
          }),
          signal: ac.signal,
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
          log.info({ status: res.status, latency_ms: latencyMs }, 'tg-notify sent');
        } else {
          log.warn(
            { status: res.status, latency_ms: latencyMs },
            'tg-notify failed',
          );
        }
      } catch (err) {
        log.warn(
          { err, latency_ms: Date.now() - start },
          'tg-notify threw',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createNullNotifier(): LeadNotifier {
  return {
    async notify() {},
  };
}
