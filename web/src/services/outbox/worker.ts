import type { Logger } from 'pino';
import { CrmPartialError } from '../crm/bitrix24.js';
import type { CRMClient, CrmPayload } from '../crm/types.js';
import type { LeadNotifier } from '../notifications/lead-notifier.js';
import type { OutboxQueue, OutboxRecord } from './queue.js';

// Backoff per плана §Д.3: 5s → 30s → 2m → 10m → 1h → 6h → 24h. Индекс — номер уже неуспешной попытки.
export const BACKOFF_MS: readonly number[] = [
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];

export const MAX_ATTEMPTS = 7;

export type OutboxWorker = {
  tick: (nowMs?: number) => Promise<void>;
  start: () => void;
  stop: () => void;
};

export type OutboxWorkerDeps = {
  queue: OutboxQueue;
  crm: CRMClient;
  logger: Logger;
  notifier?: LeadNotifier;
  intervalMs?: number;
  now?: () => number;
};

export function createOutboxWorker(deps: OutboxWorkerDeps): OutboxWorker {
  const interval = deps.intervalMs ?? 30_000;
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function processOne(rec: OutboxRecord): Promise<void> {
    const log = deps.logger.child({
      outbox_id: rec.id,
      attempt: rec.attempts + 1,
    });
    const start = now();
    try {
      const result = await deps.crm.createWebLead(rec.payload);
      const merged: CrmPayload = {
        ...rec.payload,
        contactId: result.contactId,
        dealId: result.dealId,
      };
      deps.queue.markSent(rec.id, merged, now());
      if (deps.notifier) {
        deps.notifier.notify(merged).catch((err) =>
          log.warn({ err }, 'notifier.notify threw'),
        );
      }
      log.info({ latency_ms: now() - start }, 'crm: web-lead delivered');
    } catch (err) {
      const message = (err as Error).message;
      const partialContactId =
        err instanceof CrmPartialError ? err.contactId : undefined;
      const updatedPayload: CrmPayload = partialContactId
        ? { ...rec.payload, contactId: partialContactId }
        : rec.payload;

      const newAttempts = rec.attempts + 1;
      if (newAttempts >= MAX_ATTEMPTS) {
        deps.queue.markFailed(rec.id, message, updatedPayload);
        log.error(
          { err, latency_ms: now() - start, attempts: newAttempts },
          'crm: gave up after max attempts',
        );
        return;
      }

      const delay = BACKOFF_MS[newAttempts] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
      deps.queue.bumpAttempt(rec.id, now() + delay, message, updatedPayload);
      log.warn(
        { err, latency_ms: now() - start, delay_ms: delay },
        'crm: attempt failed, will retry',
      );
    }
  }

  async function tick(nowOverride?: number): Promise<void> {
    if (running) return;
    running = true;
    try {
      const due = deps.queue.claimDue(nowOverride ?? now());
      for (const rec of due) {
        await processOne(rec);
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => deps.logger.error({ err }, 'outbox tick threw'));
      }, interval);
      tick().catch((err) => deps.logger.error({ err }, 'outbox initial tick threw'));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
