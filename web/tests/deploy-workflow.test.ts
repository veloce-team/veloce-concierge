import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('../.github/workflows/web-ci-deploy.yml', 'utf8');
const compose = readFileSync('../docker-compose.yml', 'utf8');

describe('stateful deploy workflow safety contract', () => {
  it('pins the complete expected action set to immutable commits and never cancels a mutating deploy', () => {
    expect(workflow).toContain('cancel-in-progress: false');
    const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
    expect(actionUses).toEqual([
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      'appleboy/scp-action@917f8b81dfc1ccd331fef9e2d61bdc6c8be94634',
      'appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2',
    ]);
    expect(actionUses).toHaveLength(5);
    for (const uses of actionUses) expect(uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('acquires one stable VPS lock before mutation and wires executable rollback in order', () => {
    const lockOpen = workflow.indexOf('exec 9>"$BASE/.deploy.lock"');
    const lockAcquire = workflow.indexOf('flock -n 9');
    const firstMutation = workflow.indexOf('chmod 600 "$BASE/web/.env"');
    const rollbackDefinition = workflow.indexOf('rollback() {');
    const rollbackTrap = workflow.indexOf('trap rollback EXIT');
    const stopRuntime = workflow.indexOf('stop concierge-web');
    const promoteLink = workflow.indexOf('mv -Tf "$BASE/current.next" "$CURRENT"');
    expect(lockOpen).toBeGreaterThan(0);
    expect(lockAcquire).toBeGreaterThan(lockOpen);
    expect(firstMutation).toBeGreaterThan(lockAcquire);
    expect(rollbackDefinition).toBeGreaterThan(firstMutation);
    expect(rollbackTrap).toBeGreaterThan(rollbackDefinition);
    expect(stopRuntime).toBeGreaterThan(rollbackTrap);
    expect(promoteLink).toBeGreaterThan(stopRuntime);
    expect(workflow.slice(rollbackDefinition, rollbackTrap)).toContain(
      'ln -sfn "$PREVIOUS" "$BASE/current.rollback"\n                mv -Tf "$BASE/current.rollback" "$CURRENT"',
    );
    expect(workflow.slice(rollbackDefinition, rollbackTrap)).toContain(
      'docker image tag "$PREVIOUS_IMAGE" "$CANDIDATE_TAG"',
    );
    expect(workflow.slice(rollbackDefinition, rollbackTrap)).toContain(
      'docker compose -p "$PROJECT" -f "$PREVIOUS/docker-compose.yml" up -d --no-deps --force-recreate concierge-web',
    );
  });

  it('freezes a runnable rollback image before the candidate replaces the compose tag', () => {
    const freezeRollbackImage = workflow.indexOf('docker build --tag "$PREVIOUS_IMAGE" "$PREVIOUS/web"');
    const candidateBuild = workflow.indexOf('build concierge-web');
    expect(freezeRollbackImage).toBeGreaterThan(0);
    expect(candidateBuild).toBeGreaterThan(freezeRollbackImage);
  });

  it('resolves the candidate image from the freshly built tag, not the stale running container', () => {
    expect(workflow).toContain('IMAGE="$(docker image inspect -f \'{{.Id}}\' "$CANDIDATE_TAG")"');
    expect(workflow).not.toContain('images -q concierge-web');
  });

  it('proves the previous image can start against the migrated rehearsal database before rollback is armed', () => {
    const oldImageSmoke = workflow.indexOf('"$PREVIOUS_IMAGE"');
    const healthProbe = workflow.indexOf('docker exec "$ROLLBACK_SMOKE" wget');
    const rollbackTrap = workflow.indexOf('trap rollback EXIT');
    expect(oldImageSmoke).toBeGreaterThan(0);
    expect(healthProbe).toBeGreaterThan(oldImageSmoke);
    expect(rollbackTrap).toBeGreaterThan(healthProbe);
    expect(workflow).toContain('web-$SHA.rehearsal.sqlite:/data/web.sqlite');
  });

  it('waits for application readiness and gives managed shutdown enough time to drain', () => {
    expect(workflow).toContain('https://api.veloce.team/ready');
    expect(compose).toContain('stop_grace_period: 35s');
  });
});