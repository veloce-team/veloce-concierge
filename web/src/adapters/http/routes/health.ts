import type { Context } from 'hono';

type HealthComponents = Record<string, unknown>;
type ReadinessSnapshot = { ready: boolean } & Record<string, unknown>;

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
    return c.json(
      { ...current, status: current.ready ? 'ready' : 'not_ready' },
      current.ready ? 200 : 503,
    );
  };
}
