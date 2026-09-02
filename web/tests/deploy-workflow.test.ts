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
    const stopRuntime = workflow.indexOf('stop concierge-web', rollbackTrap);
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

  it('proves the previous image can start against the pre-migration rollback database before rollback is armed', () => {
    const rollbackCopy = workflow.indexOf(
      'cp "$BACKUPS/web-$SHA.sqlite" "$BACKUPS/web-$SHA.rollback.sqlite"',
    );
    const smokeStart = workflow.indexOf('docker run -d --rm --name "$ROLLBACK_SMOKE"');
    const smokeEnd = workflow.indexOf('for attempt in $(seq 1 15)', smokeStart);
    const smokeBlock = workflow.slice(smokeStart, smokeEnd);
    const rollbackMount = smokeBlock.indexOf('web-$SHA.rollback.sqlite:/data/web.sqlite');
    const oldImage = smokeBlock.indexOf('"$PREVIOUS_IMAGE"');
    const healthProbe = workflow.indexOf('docker exec "$ROLLBACK_SMOKE" wget');
    const rollbackTrap = workflow.indexOf('trap rollback EXIT');
    expect(rollbackCopy).toBeGreaterThan(0);
    expect(smokeStart).toBeGreaterThan(rollbackCopy);
    expect(smokeEnd).toBeGreaterThan(smokeStart);
    expect(rollbackMount).toBeGreaterThan(0);
    expect(oldImage).toBeGreaterThan(rollbackMount);
    expect(healthProbe).toBeGreaterThan(smokeEnd);
    expect(rollbackTrap).toBeGreaterThan(healthProbe);
  });

  it('packages and verifies schema v4 and restores the pre-migration database before rollback restart', () => {
    expect(workflow).toContain('dist/services/sessions/migrations/004-lineage-root.sql');
    expect(workflow).toContain('src/services/sessions/migrations/004-lineage-root.sql');
    expect(workflow).toContain("!==4");
    const rollbackDefinition = workflow.indexOf('rollback() {');
    const rollbackTrap = workflow.indexOf('trap rollback EXIT');
    const rollbackBody = workflow.slice(rollbackDefinition, rollbackTrap);
    const inspectBeforeStop = rollbackBody.indexOf('docker inspect veloce-concierge-web >/dev/null');
    const stop = rollbackBody.indexOf('docker stop -t 35 veloce-concierge-web');
    const verifyStopped = rollbackBody.indexOf("'{{.State.Running}}' veloce-concierge-web");
    const restoreSymlink = rollbackBody.indexOf('mv -Tf "$BASE/current.rollback" "$CURRENT"');
    const removeSymlink = rollbackBody.indexOf('rm -f "$CURRENT"');
    const volumeMount = rollbackBody.indexOf('-v "${PROJECT}_web_data:/data"');
    const restoreSource = rollbackBody.indexOf("new D('/backup/web-$SHA.sqlite',{readonly:true})");
    const restore = rollbackBody.indexOf("source.backup('/data/web.sqlite')");
    const retag = rollbackBody.indexOf('docker image tag "$PREVIOUS_IMAGE" "$CANDIDATE_TAG"');
    const restart = rollbackBody.indexOf('up -d --no-deps --force-recreate concierge-web');
    expect(inspectBeforeStop).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(inspectBeforeStop);
    expect(verifyStopped).toBeGreaterThan(stop);
    expect(restoreSymlink).toBeGreaterThan(verifyStopped);
    expect(removeSymlink).toBeGreaterThan(restoreSymlink);
    expect(volumeMount).toBeGreaterThan(removeSymlink);
    expect(restoreSource).toBeGreaterThan(volumeMount);
    expect(restore).toBeGreaterThan(restoreSource);
    expect(retag).toBeGreaterThan(restore);
    expect(restart).toBeGreaterThan(retag);
    expect(rollbackBody).not.toContain('stop concierge-web || true');
    expect(rollbackBody).not.toContain('if docker inspect');
    expect(rollbackBody).not.toContain('|| printf false');
  });

  it('deploys the public readiness proxy through the pipeline with Caddy rollback', () => {
    expect(workflow).toContain(
      'source: "docker-compose.yml,infra/caddy/Caddyfile,web/package.json,web/package-lock.json,web/tsconfig.json,web/Dockerfile,web/src/**"',
    );
    const validate = workflow.indexOf('caddy validate --config /candidate/Caddyfile');
    const appRollbackTrap = workflow.indexOf('trap rollback EXIT');
    const backup = workflow.indexOf('cp "$BASE/infra/caddy/Caddyfile" "$BACKUPS/Caddyfile-$SHA"');
    const swap = workflow.indexOf('mv -Tf "$BASE/infra/caddy/Caddyfile.next" "$BASE/infra/caddy/Caddyfile"');
    const recreate = workflow.indexOf('up -d --no-deps --force-recreate caddy');
    const restore = workflow.indexOf('mv -Tf "$BASE/infra/caddy/Caddyfile.rollback" "$BASE/infra/caddy/Caddyfile"');
    const rollbackRecreate = workflow.indexOf('deploy_caddy rollback', restore);
    const failedRelease = workflow.indexOf('exit 1', rollbackRecreate);
    const disarmAppRollback = workflow.indexOf('trap - EXIT', failedRelease);
    expect(validate).toBeGreaterThan(0);
    expect(appRollbackTrap).toBeGreaterThan(validate);
    expect(backup).toBeGreaterThan(appRollbackTrap);
    expect(swap).toBeGreaterThan(backup);
    expect(recreate).toBeGreaterThan(swap);
    expect(restore).toBeGreaterThan(recreate);
    expect(rollbackRecreate).toBeGreaterThan(restore);
    expect(failedRelease).toBeGreaterThan(rollbackRecreate);
    expect(disarmAppRollback).toBeGreaterThan(failedRelease);
    expect(workflow.slice(recreate, restore)).toContain('if ! deploy_caddy candidate; then');
    expect(workflow.slice(restore, failedRelease)).not.toContain('||');
    expect(workflow).toContain('CADDY_UID="$(stat -c %u "$BASE/infra/caddy/Caddyfile")"');
    expect(workflow).toContain('CADDY_GID="$(stat -c %g "$BASE/infra/caddy/Caddyfile")"');
    expect(workflow).toContain('CADDY_MODE="$(stat -c %a "$BASE/infra/caddy/Caddyfile")"');
    expect(workflow).toContain(
      'install -o "$CADDY_UID" -g "$CADDY_GID" -m "$CADDY_MODE" \\\n              "$RELEASE/infra/caddy/Caddyfile" "$BASE/infra/caddy/Caddyfile.next"',
    );
    expect(workflow).toContain(
      'install -o "$CADDY_UID" -g "$CADDY_GID" -m "$CADDY_MODE" \\\n                "$BACKUPS/Caddyfile-$SHA" "$BASE/infra/caddy/Caddyfile.rollback"',
    );
    expect(workflow).toContain("wget -T 15 -qO- https://veloce.team/");
    expect(workflow).toContain("wget -T 15 -qO- https://api.veloce.team/health");
    expect(workflow).toContain("wget -T 15 -qO- https://api.veloce.team/ready");
    expect(workflow).not.toContain('docker exec veloce-caddy caddy reload');
  });

  it('waits for internal application readiness before public proxy verification and gives shutdown enough time', () => {
    const internalReady = workflow.indexOf(
      'timeout 20s docker exec veloce-concierge-web wget -T 15 -qO- http://127.0.0.1:3000/ready',
    );
    const publicReady = workflow.indexOf('https://api.veloce.team/ready');
    expect(internalReady).toBeGreaterThan(0);
    expect(publicReady).toBeGreaterThan(internalReady);
    expect(workflow).toContain(
      'timeout 20s docker exec "$ROLLBACK_SMOKE" wget -T 15 -qO- http://127.0.0.1:3000/health',
    );
    expect(workflow).toContain("timeout 20s docker inspect -f '{{.State.Running}}' veloce-caddy");
    expect(workflow).toContain(
      'timeout 20s docker exec veloce-caddy caddy validate --config /etc/caddy/Caddyfile',
    );
    expect(workflow).toContain(
      'timeout 120s docker compose -p "$PROJECT" -f "$BASE/docker-compose.yml" up -d --no-deps --force-recreate caddy',
    );
    expect(workflow.match(/for attempt in \$\(seq 1 15\)/g)).toHaveLength(2);
    expect(workflow.match(/for attempt in \$\(seq 1 30\)/g)).toHaveLength(1);
    expect(compose).toContain('stop_grace_period: 35s');
  });
});