import type { Logger } from 'pino';
import type { BitrixAnalyticsClient } from './bitrix.js';
import type { AnalyticsRepository, YandexOutboxRecord } from './repository.js';
import { deriveAnalyticsTransition } from './semantic.js';
import { YandexApiError, type YandexSimpleOrdersClient } from './yandex.js';

const DAY_MS = 86_400_000;
const FIRST_LINK_WINDOW_MS = 21 * DAY_MS;
const UPDATE_WINDOW_MS = 111 * DAY_MS;
const MAX_UPLOAD_ATTEMPTS = 7;
const MAX_UPLOADS_PER_TICK = 10;
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000];

export type AnalyticsWorker = {
  tickPoll(): Promise<void>;
  tickUpload(): Promise<void>;
  tickReconcile(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  health(): AnalyticsWorkerHealth;
};

type AnalyticsStage = 'poll' | 'upload' | 'reconcile';

export type AnalyticsWorkerHealth = {
  enabled: true;
  started: boolean;
  stopping: boolean;
  ready: boolean;
  running: Record<AnalyticsStage, boolean>;
  lastSuccessAt: Record<AnalyticsStage, number | null>;
  lastFailureAt: Record<AnalyticsStage, number | null>;
};

export type AnalyticsWorkerDeps = {
  bitrix: BitrixAnalyticsClient;
  repository: AnalyticsRepository;
  yandex: YandexSimpleOrdersClient;
  logger: Logger;
  now?: () => number;
  pollIntervalMs?: number;
  uploadIntervalMs?: number;
  reconcileIntervalMs?: number;
  outboxAlertThreshold?: number;
};

export function createAnalyticsWorker(deps: AnalyticsWorkerDeps): AnalyticsWorker {
  const now = deps.now ?? (() => Date.now());
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const active = new Set<Promise<void>>();
  let pollRunning = false;
  let uploadRunning = false;
  let reconcileRunning = false;
  let started = false;
  let stopping = false;
  const lastSuccessAt: Record<AnalyticsStage, number | null> = {
    poll: null,
    upload: null,
    reconcile: null,
  };
  const lastFailureAt: Record<AnalyticsStage, number | null> = {
    poll: null,
    upload: null,
    reconcile: null,
  };

  function safeError(error: unknown): { error_type: string } {
    return { error_type: error instanceof Error ? error.name : 'UnknownError' };
  }

  function track(stage: AnalyticsStage, operation: () => Promise<void>): Promise<void> {
    if (stopping) return Promise.resolve();
    const promise = operation().then(
      () => {
        lastSuccessAt[stage] = now();
      },
      (error: unknown) => {
        lastFailureAt[stage] = now();
        throw error;
      },
    );
    active.add(promise);
    const remove = () => active.delete(promise);
    void promise.then(remove, remove);
    return promise;
  }

  async function runPoll(): Promise<void> {
    if (pollRunning) return;
    pollRunning = true;
    try {
      const deals = await deps.bitrix.listTrackedDeals();
      for (const deal of deals) {
        try {
          const history = await deps.bitrix.getStageHistory(deal.dealId);
          const previous = deps.repository.getState(deal.portalId, deal.dealId);
          const transition = deriveAnalyticsTransition(deal, history, previous);
          const result = deps.repository.applyTransition(deal, transition);
          if (transition.alerts.length > 0) {
            deps.logger.warn(
              { portal_id: deal.portalId, deal_id: deal.dealId, alerts: transition.alerts },
              'analytics: semantic alerts',
            );
          }
          if (result.eventCount > 0 || result.outboxCreated) {
            deps.logger.info(
              { portal_id: deal.portalId, deal_id: deal.dealId, ...result },
              'analytics: transition persisted',
            );
          }
        } catch (error) {
          deps.logger.error({ ...safeError(error), deal_id: deal.dealId }, 'analytics: deal poll failed');
        }
      }
    } finally {
      pollRunning = false;
    }
  }

  function windowExpired(record: YandexOutboxRecord, current: number): string | null {
    const eventTime = Date.parse(record.payload.createDateTime);
    if (Number.isNaN(eventTime)) return 'invalid_create_date_time';
    const age = current - eventTime;
    const limit = deps.repository.hasProcessedOrder(record.orderId)
      ? UPDATE_WINDOW_MS
      : FIRST_LINK_WINDOW_MS;
    return age > limit ? 'UNMATCHABLE_WINDOW_EXPIRED' : null;
  }

  function emitOutboxAlert(): void {
    const threshold = deps.outboxAlertThreshold;
    if (threshold == null) return;
    const counts = deps.repository.countByStatus();
    const deliverableBacklog =
      (counts.dirty ?? 0) +
      (counts.retry ?? 0) +
      (counts.sending ?? 0) +
      (counts.accepted ?? 0);
    const dead = (counts.dead ?? 0) + (counts.unmatchable ?? 0);
    if (deliverableBacklog >= threshold || dead > 0) {
      deps.logger.warn(
        { deliverable_backlog: deliverableBacklog, dead, threshold, counts },
        'analytics: outbox alert threshold exceeded',
      );
    }
  }

  async function runUpload(): Promise<void> {
    if (uploadRunning) return;
    uploadRunning = true;
    try {
      const current = now();
      const records = deps.repository.claimDue(current, MAX_UPLOADS_PER_TICK);
      for (const record of records) {
        const expired = windowExpired(record, current);
        if (expired) {
          deps.repository.markUnmatchable(record.id, expired);
          deps.logger.error({ outbox_id: record.id, order_id: record.orderId }, expired);
          continue;
        }
        try {
          const result = await deps.yandex.upload(record.payload);
          if (result.validationStatus === 'FAILED') {
            deps.repository.markDead(record.id, 'Yandex API validation failed');
          } else if (result.validationStatus !== 'PASSED') {
            deps.repository.markDead(
              record.id,
              `Yandex API returned unknown validation status: ${result.validationStatus}`,
            );
          } else if (result.elementsCount !== 1) {
            deps.repository.markDead(
              record.id,
              `Yandex accepted unexpected element count: ${result.elementsCount}`,
            );
          } else {
            deps.repository.markAccepted(record.id, result.uploadId, current);
          }
        } catch (error) {
          const retryable = error instanceof YandexApiError ? error.retryable : true;
          if (error instanceof YandexApiError && (error.status === 420 || error.status === 429)) {
            deps.logger.warn(
              { outbox_id: record.id, status: error.status },
              'analytics: Yandex quota exhausted',
            );
          }
          if (!retryable || record.attempts >= MAX_UPLOAD_ATTEMPTS) {
            deps.repository.markDead(record.id, (error as Error).message);
          } else {
            const delay = BACKOFF_MS[Math.min(record.attempts - 1, BACKOFF_MS.length - 1)]!;
            deps.repository.markRetry(record.id, (error as Error).message, current + delay);
          }
        }
      }
      emitOutboxAlert();
    } finally {
      uploadRunning = false;
    }
  }

  async function runReconcile(): Promise<void> {
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      const current = now();
      for (const record of deps.repository.listAccepted()) {
        if (!record.uploadId) {
          deps.repository.markDead(record.id, 'accepted upload has no uploading_id');
          continue;
        }
        try {
          const page = await deps.yandex.getUploadStatusPage(record.uploadId, record.reconcileCursor);
          const status = page.upload;
          if (!status) {
            if (!page.exhausted) {
              if (!page.nextCursor) {
                deps.repository.markDead(record.id, 'Yandex history page has no continuation cursor');
              } else {
                deps.repository.setReconcileCursor(record.id, page.nextCursor, current);
              }
              continue;
            }
            if (record.acceptedAt != null && current - record.acceptedAt > 3_600_000) {
              deps.repository.markDead(record.id, 'Yandex upload missing from exhaustive history');
            } else if (record.reconcileCursor != null) {
              // Eventual consistency: a recent upload may appear after a completed scan.
              deps.repository.setReconcileCursor(record.id, null, current);
            }
            continue;
          }
          if (status.validationStatus === 'PASSED') {
            if (status.elementsCount !== 1) {
              deps.repository.markDead(
                record.id,
                `Yandex processed unexpected element count: ${status.elementsCount}`,
              );
            } else {
              deps.repository.markProcessed(record.id, current);
            }
          } else if (status.validationStatus === 'FAILED') {
            deps.repository.markDead(record.id, 'Yandex processing validation failed');
          } else {
            deps.repository.markDead(
              record.id,
              `Yandex read-back returned unknown validation status: ${status.validationStatus}`,
            );
          }
        } catch (error) {
          if (error instanceof YandexApiError && !error.retryable) {
            deps.repository.markDead(
              record.id,
              `Yandex reconciliation failed permanently: ${error.message}`,
            );
          } else {
            deps.logger.warn(
              { ...safeError(error), upload_id: record.uploadId },
              'analytics: read-back failed',
            );
          }
        }
      }
    } finally {
      reconcileRunning = false;
    }
  }

  function schedule(intervalMs: number, tick: () => Promise<void>, name: string): void {
    timers.push(
      setInterval(() => {
        tick().catch((error) =>
          deps.logger.error(safeError(error), `analytics: ${name} tick failed`),
        );
      }, intervalMs),
    );
  }

  function tickPoll(): Promise<void> {
    return track('poll', runPoll);
  }

  function tickUpload(): Promise<void> {
    return track('upload', runUpload);
  }

  function tickReconcile(): Promise<void> {
    return track('reconcile', runReconcile);
  }

  async function initialLifecycle(): Promise<void> {
    for (const [name, tick] of [
      ['poll', tickPoll],
      ['upload', tickUpload],
      ['reconcile', tickReconcile],
    ] as const) {
      try {
        await tick();
      } catch (error) {
        deps.logger.error(safeError(error), `analytics: ${name} initial tick failed`);
      }
    }
  }

  return {
    tickPoll,
    tickUpload,
    tickReconcile,
    start() {
      if (started) return;
      started = true;
      stopping = false;
      schedule(deps.pollIntervalMs ?? 300_000, tickPoll, 'poll');
      schedule(deps.uploadIntervalMs ?? 30_000, tickUpload, 'upload');
      schedule(deps.reconcileIntervalMs ?? 60_000, tickReconcile, 'reconcile');
      void initialLifecycle();
    },
    async stop() {
      started = false;
      stopping = true;
      for (const timer of timers.splice(0)) clearInterval(timer);
      await Promise.allSettled([...active]);
      stopping = false;
    },
    health() {
      return {
        enabled: true,
        started,
        stopping,
        ready: Object.values(lastSuccessAt).every((value) => value != null),
        running: { poll: pollRunning, upload: uploadRunning, reconcile: reconcileRunning },
        lastSuccessAt: { ...lastSuccessAt },
        lastFailureAt: { ...lastFailureAt },
      };
    },
  };
}
