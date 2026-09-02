import type { Logger } from 'pino';
import type { BitrixAnalyticsClient } from './bitrix.js';
import type { AnalyticsRepository, YandexOutboxRecord } from './repository.js';
import {
  deriveAnalyticsTransition,
  type AnalyticsDeal,
  type AnalyticsHistoryItem,
} from './semantic.js';
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
  issues: string[];
  outbox: {
    counts: Record<string, number>;
    deliverableBacklog: number;
    terminal: number;
  };
  limits: {
    outboxAlertThreshold: number;
    staleAfterMs: Record<AnalyticsStage, number>;
  };
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
  pollStaleAfterMs?: number;
  uploadStaleAfterMs?: number;
  reconcileStaleAfterMs?: number;
};

function newestDeal(deals: AnalyticsDeal[]): AnalyticsDeal {
  return [...deals].sort((a, b) => {
    const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (byCreated !== 0) return byCreated;
    const byModified = Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt);
    if (byModified !== 0) return byModified;
    return b.dealId.localeCompare(a.dealId, undefined, { numeric: true });
  })[0]!;
}

function currentLineageDeal(deals: AnalyticsDeal[]): AnalyticsDeal {
  return newestDeal(deals);
}

function publicSemanticIssue(alert: string): string {
  if (alert.startsWith('unknown_category:')) return 'semantic:unknown_category';
  switch (alert) {
    case 'missing_ym_client_id':
    case 'invalid_current_contract_value':
    case 'won_without_signing_stage':
      return `semantic:${alert}`;
    default:
      return 'semantic:unclassified';
  }
}

export function createAnalyticsWorker(deps: AnalyticsWorkerDeps): AnalyticsWorker {
  const now = deps.now ?? (() => Date.now());
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const active = new Set<Promise<void>>();
  let pollRunning = false;
  let uploadRunning = false;
  let reconcileRunning = false;
  let started = false;
  let stopping = false;
  let semanticIssues: string[] = [];
  let quotaExhausted = false;
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
  const lastOutcome: Record<AnalyticsStage, 'success' | 'failure' | null> = {
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
        lastOutcome[stage] = 'success';
      },
      (error: unknown) => {
        lastFailureAt[stage] = now();
        lastOutcome[stage] = 'failure';
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
    const nextSemanticIssues = new Set<string>();
    try {
      const deals = await deps.bitrix.listTrackedDeals();
      const lineages = new Map<string, AnalyticsDeal[]>();
      for (const deal of deals) {
        const key = `${deal.portalId}\u0000${deal.sourceDealId}`;
        const lineage = lineages.get(key) ?? [];
        lineage.push(deal);
        lineages.set(key, lineage);
      }
      for (const lineage of lineages.values()) {
        const sourceDealId = lineage[0]!.sourceDealId;
        const root = lineage.find((member) => member.dealId === sourceDealId);
        if (!root) {
          nextSemanticIssues.add('semantic:lineage_root_missing');
          deps.logger.error(
            { deal_id: sourceDealId, physical_deal_ids: lineage.map((member) => member.dealId) },
            'analytics: lineage root missing',
          );
          const physicalDeal = currentLineageDeal(lineage);
          const deal: AnalyticsDeal = { ...physicalDeal, dealId: sourceDealId };
          const previous = deps.repository.getState(deal.portalId, deal.dealId);
          deps.repository.applyTransition(deal, {
            nextState: previous,
            events: [],
            order: null,
            suppressDelivery: true,
            alerts: ['lineage_root_missing'],
          });
          continue;
        }
        const physicalDeal = currentLineageDeal(lineage);
        const deal: AnalyticsDeal = { ...physicalDeal, dealId: physicalDeal.sourceDealId };
        try {
          const currentHistory: AnalyticsHistoryItem[] = [];
          const qualificationHistory: AnalyticsHistoryItem[] = [];
          let rootHasQualificationHistory = false;
          for (const member of lineage) {
            const memberHistory = await deps.bitrix.getStageHistory(member.dealId);
            if (member.dealId === physicalDeal.dealId) currentHistory.push(...memberHistory);
            if (member.dealId === root.dealId) {
              const rootHistory = memberHistory.filter((item) => item.categoryId === '0');
              qualificationHistory.push(...rootHistory);
              if (rootHistory.length > 0) rootHasQualificationHistory = true;
            } else {
              qualificationHistory.push(
                ...memberHistory.filter((item) => ['2', '4', '6'].includes(item.categoryId)),
              );
            }
          }
          if (!rootHasQualificationHistory) {
            nextSemanticIssues.add('semantic:lineage_root_has_no_category_0_history');
            deps.logger.error(
              { deal_id: sourceDealId },
              'analytics: lineage root has no qualification history',
            );
            const previous = deps.repository.getState(deal.portalId, deal.dealId);
            deps.repository.applyTransition(deal, {
              nextState: previous,
              events: [],
              order: null,
              suppressDelivery: true,
              alerts: ['lineage_root_has_no_category_0_history'],
            });
            continue;
          }
          const previous = deps.repository.getState(deal.portalId, deal.dealId);
          const transition = deriveAnalyticsTransition(
            deal,
            currentHistory,
            previous,
            qualificationHistory,
            true,
          );
          const result = deps.repository.applyTransition(deal, transition);
          if (transition.alerts.length > 0) {
            for (const alert of transition.alerts) nextSemanticIssues.add(publicSemanticIssue(alert));
            deps.logger.warn(
              {
                portal_id: deal.portalId,
                deal_id: deal.dealId,
                physical_deal_id: physicalDeal.dealId,
                alerts: transition.alerts,
              },
              'analytics: semantic alerts',
            );
          }
          if (result.eventCount > 0 || result.outboxCreated) {
            deps.logger.info(
              {
                portal_id: deal.portalId,
                deal_id: deal.dealId,
                physical_deal_id: physicalDeal.dealId,
                ...result,
              },
              'analytics: transition persisted',
            );
          }
        } catch (error) {
          nextSemanticIssues.add('semantic:deal_poll_failed');
          deps.logger.error(
            { ...safeError(error), deal_id: deal.dealId, physical_deal_id: physicalDeal.dealId },
            'analytics: deal poll failed',
          );
        }
      }
      semanticIssues = [...nextSemanticIssues].sort();
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
    let quotaExhaustedThisTick = false;
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
            quotaExhaustedThisTick = true;
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
      quotaExhausted = quotaExhaustedThisTick;
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
    if (pollRunning) return Promise.resolve();
    return track('poll', runPoll);
  }

  function tickUpload(): Promise<void> {
    if (uploadRunning) return Promise.resolve();
    return track('upload', runUpload);
  }

  function tickReconcile(): Promise<void> {
    if (reconcileRunning) return Promise.resolve();
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
      const current = now();
      const staleAfter: Record<AnalyticsStage, number> = {
        poll: deps.pollStaleAfterMs ?? 900_000,
        upload: deps.uploadStaleAfterMs ?? 300_000,
        reconcile: deps.reconcileStaleAfterMs ?? 600_000,
      };
      const issues = (Object.keys(lastSuccessAt) as AnalyticsStage[])
        .filter((stage) => {
          const success = lastSuccessAt[stage];
          return success != null && current - success > staleAfter[stage];
        })
        .map((stage) => `stale:${stage}`);
      for (const stage of Object.keys(lastFailureAt) as AnalyticsStage[]) {
        if (lastOutcome[stage] === 'failure') issues.push(`failed:${stage}`);
      }
      let counts: Record<string, number> = {};
      try {
        counts = deps.repository.countByStatus();
      } catch {
        issues.push('outbox:snapshot_failed');
      }
      const deliverableBacklog =
        (counts.dirty ?? 0) +
        (counts.retry ?? 0) +
        (counts.sending ?? 0) +
        (counts.accepted ?? 0);
      const terminal = (counts.dead ?? 0) + (counts.unmatchable ?? 0);
      if ((counts.retry ?? 0) > 0) issues.push('outbox:retry');
      if (terminal > 0) issues.push('outbox:terminal');
      if (deliverableBacklog >= (deps.outboxAlertThreshold ?? 5)) issues.push('outbox:backlog');
      if (quotaExhausted) issues.push('provider:quota_exhausted');
      issues.push(...semanticIssues);
      return {
        enabled: true,
        started,
        stopping,
        ready: Object.values(lastSuccessAt).every((value) => value != null) && issues.length === 0,
        running: { poll: pollRunning, upload: uploadRunning, reconcile: reconcileRunning },
        lastSuccessAt: { ...lastSuccessAt },
        lastFailureAt: { ...lastFailureAt },
        issues,
        outbox: { counts, deliverableBacklog, terminal },
        limits: {
          outboxAlertThreshold: deps.outboxAlertThreshold ?? 5,
          staleAfterMs: staleAfter,
        },
      };
    },
  };
}
