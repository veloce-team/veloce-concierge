import type { Context } from 'hono';

type HealthComponents = Record<string, unknown>;
type ReadinessSnapshot = { ready: boolean; analytics?: unknown } & Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

const PUBLIC_ISSUES = new Set([
  'stale:poll', 'stale:upload', 'stale:reconcile',
  'failed:poll', 'failed:upload', 'failed:reconcile',
  'outbox:snapshot_failed', 'outbox:retry', 'outbox:terminal', 'outbox:backlog',
  'provider:quota_exhausted',
  'semantic:lineage_root_missing',
  'semantic:lineage_root_has_no_category_0_history',
  'semantic:deal_poll_failed',
  'semantic:unknown_category',
  'semantic:missing_ym_client_id',
  'semantic:invalid_current_contract_value',
  'semantic:won_without_signing_stage',
  'semantic:unclassified',
]);
const PUBLIC_OUTBOX_STATUSES = [
  'dirty', 'sending', 'accepted', 'clean', 'retry', 'dead', 'unmatchable', 'suppressed', 'held',
] as const;
const STAGES = ['poll', 'upload', 'reconcile'] as const;

function record(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stageNumbers(value: unknown): Record<string, number | null> | null {
  const source = record(value);
  if (!source) return null;
  return Object.fromEntries(STAGES.map((stage) => {
    const candidate = source[stage];
    return [stage, candidate === null || (typeof candidate === 'number' && Number.isFinite(candidate))
      ? candidate
      : null];
  }));
}

function publicAnalyticsHealth(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  const enabled = source.enabled === true;
  const ready = source.ready === true;
  if (!enabled) return { enabled: false, ready };

  const outbox = record(source.outbox) ?? {};
  const rawCounts = record(outbox.counts) ?? {};
  const counts = Object.fromEntries(PUBLIC_OUTBOX_STATUSES.flatMap((status) => {
    const count = rawCounts[status];
    return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? [[status, count]] : [];
  }));
  const limits = record(source.limits) ?? {};

  return {
    enabled: true,
    ready,
    issues: Array.isArray(source.issues)
      ? source.issues.filter((issue): issue is string => typeof issue === 'string' && PUBLIC_ISSUES.has(issue))
      : [],
    lastSuccessAt: stageNumbers(source.lastSuccessAt),
    outbox: {
      counts,
      deliverableBacklog: typeof outbox.deliverableBacklog === 'number' ? outbox.deliverableBacklog : 0,
      terminal: typeof outbox.terminal === 'number' ? outbox.terminal : 0,
    },
    limits: {
      outboxAlertThreshold: typeof limits.outboxAlertThreshold === 'number'
        ? limits.outboxAlertThreshold
        : 0,
      staleAfterMs: stageNumbers(limits.staleAfterMs),
    },
  };
}

function publicReadinessSnapshot(current: ReadinessSnapshot): JsonRecord {
  return {
    ready: current.ready === true,
    analytics: publicAnalyticsHealth(current.analytics),
  };
}

export function createHealthHandler(
  startedAtMs: number,
  components: () => HealthComponents = () => ({}),
) {
  return function health(c: Context): Response {
    const uptime_s = Math.floor((Date.now() - startedAtMs) / 1000);
    return c.json({ status: 'ok', uptime_s, components: components() });
  };
}

export function createReadinessHandler(snapshot: () => ReadinessSnapshot) {
  return function readiness(c: Context): Response {
    const current = snapshot();
    const publicSnapshot = publicReadinessSnapshot(current);
    return c.json(
      { ...publicSnapshot, status: current.ready ? 'ready' : 'not_ready' },
      current.ready ? 200 : 503,
    );
  };
}
