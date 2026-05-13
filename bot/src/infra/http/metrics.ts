import type { Database as Db } from 'better-sqlite3';
import type { Context } from 'hono';
import type { OutboxQueue } from '../../services/outbox/queue.js';
import type { SessionStore } from '../../core/dialog/types.js';

export type MetricsDeps = {
  db: Db;
  sessions: SessionStore;
  outbox: OutboxQueue;
  startedAtMs: number;
};

export function createMetricsHandler(deps: MetricsDeps) {
  const dialogsTodayStmt = deps.db.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE updated_at >= ?`,
  );

  return function metrics(c: Context): Response {
    const uptime_s = Math.floor((Date.now() - deps.startedAtMs) / 1000);
    const todayStart = startOfTodayMs();
    return c.json({
      status: 'ok',
      uptime_s,
      sessions_count: deps.sessions.countActive(),
      dialogs_today: (dialogsTodayStmt.get(todayStart) as { n: number }).n,
      deals_sent_today: deps.outbox.countSentSince(todayStart),
      outbox_pending: deps.outbox.countPending(),
    });
  };
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
