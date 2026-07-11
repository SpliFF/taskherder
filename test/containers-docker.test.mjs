// M11b — the PERSISTENT lifecycle end-to-end, against a REAL docker daemon
// (DESIGN §26). These spin actual containers, so — like M11a's docker-specific
// wiring — they are kept OUT of the default `npm test` (which stays fast + green
// on a docker-less box) and opt in via `TASKHERD_DOCKER_TESTS=1`. The pure/data
// paths (state machine, signature, gc plan, exec/ephemeral argv) are covered
// docker-free in containers.test.mjs; this file locks the live behavior the
// exit demo also exercises: container reuse, stop→start, signature-drift
// recreate, and — the §12-critical one — that a timed-out step leaves NOTHING
// running inside the container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { makeGitRepo } from './helpers.mjs';
import { tick } from '../src/scheduler.mjs';
import { newLane, saveLane, loadLane } from '../src/tasks.mjs';
import { containerName } from '../src/containers.mjs';
import { inspectContainer, removeContainer } from '../src/containers-docker.mjs';
import { repoId } from '../src/paths.mjs';

const execFileP = promisify(execFile);
const RUN = process.env.TASKHERD_DOCKER_TESTS === '1';
const IMAGE = 'node:20-alpine';
const ALT_IMAGE = 'alpine:latest';
const skip = RUN ? false : 'set TASKHERD_DOCKER_TESTS=1 (needs a docker daemon + node:20-alpine)';

async function enablePersistent(home, image = IMAGE) {
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ notify: 'none', containers: { allowPersistent: true } }));
  await writeFile(path.join(home, 'runners.json'), JSON.stringify({ img: { kind: 'docker', image, workdir: '/work' } }));
}
async function containerId(name) {
  return (await execFileP('docker', ['inspect', '-f', '{{.Id}}', name])).stdout.trim();
}

test('persistent: fire 1 creates the container; a manual stop → fire 2 docker-starts the SAME one (state survives)', { skip }, async (t) => {
  const { repo, home, cleanup } = await makeGitRepo();
  const name = containerName(repoId(repo), 'ci');
  t.after(async () => { await removeContainer(name); await cleanup(); });
  await enablePersistent(home);
  // /root is OUTSIDE every mount, so a marker there proves the SAME container FS
  // is reused across fires (a fresh `--rm` container would not have it).
  const step = { type: 'command', run: 'test -f /root/marker && echo REUSED || (echo FRESH; touch /root/marker)', status: 'pending' };
  await saveLane(repo, newLane('ci', {
    isolation: 'clone', runner: 'img', lifecycle: 'persistent', land: 'leave',
    steps: [{ ...step }, { ...step }],
  }));

  const r1 = await tick(repo);
  assert.equal(r1.result, 'done', 'fire 1 ran');
  const info1 = await inspectContainer(name);
  assert.ok(info1.exists && info1.running, 'container created + running after fire 1');
  const id1 = await containerId(name);
  // the marker is now inside the container (written outside the mounts)
  await execFileP('docker', ['exec', name, 'test', '-f', '/root/marker']);

  // Manual stop between fires — the next fire must `docker start` it, not recreate.
  await execFileP('docker', ['stop', '-t', '0', name]);
  assert.equal((await inspectContainer(name)).running, false, 'stopped');

  const r2 = await tick(repo);
  assert.equal(r2.result, 'done', 'fire 2 ran');
  assert.equal(await containerId(name), id1, 'SAME container id across fires (started, not recreated)');
  await execFileP('docker', ['exec', name, 'test', '-f', '/root/marker']); // state survived
});

test('persistent: changing the image drifts the signature → loud recreate (new container id)', { skip }, async (t) => {
  const { repo, home, cleanup } = await makeGitRepo();
  const name = containerName(repoId(repo), 'drift');
  t.after(async () => { await removeContainer(name); await cleanup(); });
  await enablePersistent(home, IMAGE);
  const step = { type: 'command', run: 'true', status: 'pending' };
  await saveLane(repo, newLane('drift', {
    isolation: 'clone', runner: 'img', lifecycle: 'persistent', land: 'leave',
    steps: [{ ...step }, { ...step }],
  }));
  await tick(repo);
  const id1 = await containerId(name);
  // Swap the image → the create signature changes → next fire recreates.
  await enablePersistent(home, ALT_IMAGE);
  await tick(repo);
  const id2 = await containerId(name);
  assert.notEqual(id1, id2, 'signature drift recreated the container');
});

test('persistent §12: a timed-out trap-TERM step leaves NOTHING running inside; the container survives', { skip }, async (t) => {
  const { repo, home, cleanup } = await makeGitRepo();
  const name = containerName(repoId(repo), 'to');
  const prevGrace = process.env.TASKHERD_KILL_GRACE_MS;
  process.env.TASKHERD_KILL_GRACE_MS = '400';
  t.after(async () => {
    if (prevGrace == null) delete process.env.TASKHERD_KILL_GRACE_MS;
    else process.env.TASKHERD_KILL_GRACE_MS = prevGrace;
    await removeContainer(name); await cleanup();
  });
  await enablePersistent(home);
  await saveLane(repo, newLane('to', {
    isolation: 'clone', runner: 'img', lifecycle: 'persistent', land: 'leave', timeout: '2s',
    steps: [{ type: 'command', run: 'trap "" TERM; echo STARTED; sleep 300', status: 'pending' }],
  }));
  const r = await tick(repo);
  assert.equal(r.result, 'failed', 'the step timed out'); // (retry-once sets it pending, not parked, on the first timeout)
  // The regression: killing the local docker exec client alone would orphan the
  // in-container sleep; the docker-level restart escalation must have cleared it.
  const ps = (await execFileP('docker', ['exec', name, 'ps', '-o', 'args'])).stdout;
  assert.doesNotMatch(ps, /sleep 300/, 'the timed-out sleep is gone from inside the container');
  assert.equal((await inspectContainer(name)).running, true, 'the container itself survived the restart');
});
