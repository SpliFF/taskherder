// M11a — Container lanes (DESIGN §26): `clone` isolation + syncCloneBranch,
// the validation matrix, the two-mount spawn spec, the in-container mcp config,
// lifecycle/mcpTransport parsing, and the tasks_options catalog. The clone git
// DATA path is exercised with a `local` runner (no docker needed); the
// docker-specific mount/in-container-mcp wiring is asserted at the spawn-spec /
// config level here and verified live in the M11a exit demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { makeGitRepo, gitIn } from './helpers.mjs';
import { tick } from '../src/scheduler.mjs';
import {
  newLane, saveLane, loadLane, ackLane, addStep,
} from '../src/tasks.mjs';
import {
  ensureClone, syncCloneBranch, laneDiff, gcWorktrees,
} from '../src/git.mjs';
import { clonePath, laneFile } from '../src/paths.mjs';
import { writeMcpConfig } from '../src/executor.mjs';
import { wrapForRunner } from '../src/runners.mjs';
import {
  resolveContainerPlan, parseLifecycle, parseMcpTransport,
  IN_CONTAINER_TASKS, IN_CONTAINER_REPO, IN_CONTAINER_PKG,
  nextContainerAction, containerName, ephemeralContainerName, containerSignature,
  containerGcPlan, EPHEMERAL_PREFIX,
} from '../src/containers.mjs';

const commandStep = (run) => ({ type: 'command', run, status: 'pending' });
const IMAGE = { kind: 'docker', image: 'node:20-alpine', name: 'img' };
const CONTAINER = { kind: 'docker', container: 'running-ctr', name: 'docker:running-ctr' };
const SSH = { kind: 'ssh', host: 'box', name: 'ssh:box' };
const LOCAL = { kind: 'local' };

// ── value validators ──────────────────────────────────────────────────────
test('parseLifecycle / parseMcpTransport: unknown values fail loud, null passes through', () => {
  assert.equal(parseLifecycle(null), null);
  assert.equal(parseLifecycle('ephemeral'), 'ephemeral');
  assert.equal(parseLifecycle('persistent'), 'persistent'); // known-but-gated: accepted here, gated at resolve
  assert.throws(() => parseLifecycle('forever'), /unknown lifecycle/);
  assert.equal(parseMcpTransport(''), null);
  assert.equal(parseMcpTransport('mount'), 'mount');
  assert.throws(() => parseMcpTransport('carrier-pigeon'), /unknown mcpTransport/);
});

// ── the validation matrix (§26 rule 2 + rule 1 gating) ──────────────────────
test('§26 matrix: worktree + docker image runner is REJECTED, steering to clone', () => {
  assert.throws(
    () => resolveContainerPlan({ isolation: 'worktree', runner: IMAGE }),
    /isolation 'worktree'.*docker image.*Use isolation 'clone'/s,
  );
});

test('§26 matrix: clone + docker image ai lane → container-mount; command lane → none', () => {
  const ai = resolveContainerPlan({
    isolation: 'clone', runner: IMAGE, isAi: true,
  });
  assert.equal(ai.mcpMode, 'container-mount');
  assert.equal(ai.lifecycle, 'ephemeral');
  assert.equal(ai.mcpTransport, 'mount');
  assert.equal(ai.dockerImage, true);
  assert.equal(ai.warnings.length, 0);

  const cmd = resolveContainerPlan({ isolation: 'clone', runner: IMAGE, isAi: false });
  assert.equal(cmd.mcpMode, 'none'); // a command step never wires mcp
});

test('§26 matrix: local runner → host mcp; clone+local is allowed (pristine host checkout)', () => {
  const p = resolveContainerPlan({ isolation: 'clone', runner: LOCAL, isAi: true });
  assert.equal(p.mcpMode, 'host');
  assert.equal(p.warnings.length, 0);
});

test('§26 M11b: persistent lifecycle is operator-gated — parks OFF, proceeds ON', () => {
  // gate OFF (default): a loud park naming the allow-flag (a test locks the
  // wording so the gate can't silently open).
  assert.throws(
    () => resolveContainerPlan({ isolation: 'clone', runner: IMAGE, lifecycle: 'persistent' }),
    /lifecycle 'persistent' is operator-gated.*containers.*allowPersistent/s,
  );
  assert.throws(
    () => resolveContainerPlan({
      isolation: 'clone', runner: IMAGE, lifecycle: 'persistent', allowPersistent: false,
    }),
    /operator-gated/,
  );
  // gate ON: proceeds, plan.persistent === true
  const on = resolveContainerPlan({
    isolation: 'clone', runner: IMAGE, lifecycle: 'persistent', allowPersistent: true, isAi: true,
  });
  assert.equal(on.persistent, true);
  assert.equal(on.lifecycle, 'persistent');
  assert.equal(on.mcpMode, 'container-mount');
  // the default/ephemeral path is never "persistent"
  assert.equal(resolveContainerPlan({ isolation: 'clone', runner: IMAGE, isAi: true }).persistent, false);
  // volume is still a deferred value
  assert.throws(
    () => resolveContainerPlan({ isolation: 'clone', runner: IMAGE, lifecycle: 'volume' }),
    /lifecycle 'volume' is a deferred value/,
  );
  // persistent is inert (warn, not park) without a docker image runner — even ON
  const inert = resolveContainerPlan({
    isolation: 'clone', runner: LOCAL, lifecycle: 'persistent', allowPersistent: true,
  });
  assert.equal(inert.persistent, false);
  assert.match(inert.warnings.join('\n'), /no effect without a docker image runner/);
});

test('§26 matrix: socket/http transports are deferred (park)', () => {
  assert.throws(() => resolveContainerPlan({ isolation: 'clone', runner: IMAGE, isAi: true, mcpTransport: 'socket' }), /deferred value/);
  assert.throws(() => resolveContainerPlan({ isolation: 'clone', runner: IMAGE, isAi: true, mcpTransport: 'http' }), /deferred value/);
});

test('§26 matrix: mount transport on a non-image runner degrades to none + a loud stand-in', () => {
  const exec = resolveContainerPlan({ isolation: 'none', runner: CONTAINER, isAi: true });
  assert.equal(exec.mcpMode, 'none');
  assert.match(exec.warnings.join('\n'), /FIDELITY-STANDIN.*docker IMAGE runner/s);
  const ssh = resolveContainerPlan({ isolation: 'none', runner: SSH, isAi: true });
  assert.equal(ssh.mcpMode, 'none');
  assert.match(ssh.warnings.join('\n'), /FIDELITY-STANDIN/);
  // mcpTransport: none is the honest node-less state (no stand-in from the plan;
  // wrapForRunner still emits the standing §11 one for an ai/non-local run)
  const off = resolveContainerPlan({ isolation: 'none', runner: SSH, isAi: true, mcpTransport: 'none' });
  assert.equal(off.mcpMode, 'none');
  assert.equal(off.warnings.length, 0);
});

// ── the two-mount spawn spec (§26) ──────────────────────────────────────────
test('§26 two-mount seam: wrapForRunner mounts .tasks/ (rw) + package (ro) and forwards in-container env', () => {
  const spec = wrapForRunner(IMAGE, {
    file: 'claude', args: ['-p', 'hi'], worktree: '/home/u/.taskherd/clone/r/cl', repo: '/repo', laneName: 'cl', isAi: true, mcpMounts: true, tasksMount: { hostPath: '/repo/.tasks', containerPath: IN_CONTAINER_TASKS }, pkgMount: { hostPath: '/pkg', containerPath: IN_CONTAINER_PKG }, containerEnvInline: { TASKHERD_REPO: IN_CONTAINER_REPO, TASKHERD_LANE: 'cl' },
  });
  assert.equal(spec.file, 'docker');
  const argv = spec.args.join(' ');
  assert.match(argv, /-v \/home\/u\/\.taskherd\/clone\/r\/cl:\/work/); // clone at /work
  assert.match(argv, new RegExp(`-v /repo/\\.tasks:${IN_CONTAINER_TASKS}(?!:ro)`)); // .tasks rw
  assert.match(argv, new RegExp(`-v /pkg:${IN_CONTAINER_PKG}:ro`)); // package ro
  assert.match(argv, new RegExp(`-e TASKHERD_REPO=${IN_CONTAINER_REPO}`));
  assert.match(argv, /-e TASKHERD_LANE=cl/);
  // mcpMounts:true silences the §11/§26 ai-in-runner stand-in
  assert.equal(spec.warnings.length, 0);
});

test('§26: an ai container lane WITHOUT the mount seam still emits the standing stand-in', () => {
  const spec = wrapForRunner(IMAGE, {
    file: 'claude', args: [], worktree: '/clone', repo: '/repo', laneName: 'cl', isAi: true, mcpMounts: false,
  });
  assert.match(spec.warnings.join('\n'), /FIDELITY-STANDIN.*taskherd-mcp/s);
});

// ── the in-container mcp config (§26) ───────────────────────────────────────
test('§26: writeMcpConfig(container) writes an in-container server command + returns the in-container path', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  const lane = { name: 'cl' };
  const hostReturn = await writeMcpConfig(repo, lane, path.join(repo, 'clone'), { container: true });
  assert.equal(hostReturn, `${IN_CONTAINER_TASKS}/run/cl.mcp.json`); // provider reads it here, in-container
  // …but the file itself is written to the HOST .tasks/run (inside the mounted .tasks/)
  const cfg = JSON.parse(await readFile(path.join(repo, '.tasks', 'run', 'cl.mcp.json'), 'utf8'));
  const t2 = cfg.mcpServers.taskherd;
  assert.equal(t2.command, 'node');
  assert.equal(t2.args[0], `${IN_CONTAINER_PKG}/bin/mcp.mjs`);
  assert.equal(t2.env.TASKHERD_REPO, IN_CONTAINER_REPO); // in-container repo path
  assert.equal(t2.env.TASKHERD_LANE, 'cl');

  // host mode is unchanged (real bin/mcp.mjs, host repo path)
  const hostFile = await writeMcpConfig(repo, lane, repo);
  assert.equal(hostFile, path.join(repo, '.tasks', 'run', 'cl.mcp.json'));
  const hostCfg = JSON.parse(await readFile(hostFile, 'utf8'));
  assert.match(hostCfg.mcpServers.taskherd.args[0], /bin\/mcp\.mjs$/);
  assert.equal(hostCfg.mcpServers.taskherd.env.TASKHERD_REPO, path.resolve(repo));
});

// ── clone pool + syncCloneBranch + land/diff/gc round-trip (local runner) ────
test('§26 clone isolation: a lane runs in a self-contained clone (real .git dir) on taskherd/<lane>', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  // A trailing step keeps the queue open so the lane does NOT complete this
  // fire — otherwise the post-run land check (maybeLand) would sync for us, and
  // we want to observe the pre-sync state (clone's own object store).
  await saveLane(repo, newLane('cl', {
    isolation: 'clone',
    steps: [
      commandStep('echo hi > c.txt && git add c.txt && git commit -m clone-commit'),
      commandStep('true'),
    ],
  }));
  const first = await tick(repo);
  assert.equal(first.outcome, 'ran');
  assert.equal(first.result, 'done');

  const clone = clonePath(repo, 'cl');
  assert.ok(existsSync(path.join(clone, '.git')), 'clone dir exists');
  assert.ok(statSync(path.join(clone, '.git')).isDirectory(), '.git is a REAL directory (bind-mountable), not a pointer file');
  assert.equal(await gitIn(clone, 'symbolic-ref', '--short', 'HEAD'), 'taskherd/cl');
  assert.ok(existsSync(path.join(clone, 'c.txt')), 'work happened in the clone');
  assert.ok(!existsSync(path.join(repo, 'c.txt')), 'main checkout untouched');

  // The commit is in the clone's own object store — NOT in the main repo yet
  // (the queue is still open, so no land-check sync has fired).
  const mainLogBefore = await gitIn(repo, 'log', '--oneline', 'taskherd/cl');
  assert.doesNotMatch(mainLogBefore, /clone-commit/, 'main has only the fork point until synced');

  // syncCloneBranch fetches it into the main repo (fast-forward).
  const synced = await syncCloneBranch(repo, 'cl');
  assert.equal(synced.synced, true);
  const mainLogAfter = await gitIn(repo, 'log', '--oneline', 'taskherd/cl');
  assert.match(mainLogAfter, /clone-commit/, 'main repo now has the clone commit');
});

test('§26 clone: laneDiff shows the clone commit, and the land gate merges it into base', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await saveLane(repo, newLane('cl', {
    isolation: 'clone',
    steps: [commandStep('echo hi > c.txt && git add c.txt && git commit -m clone-commit')],
  }));
  await tick(repo); // runs step, completes queue → maybeLand syncs + gates

  await syncCloneBranch(repo, 'cl');
  const d = await laneDiff(repo, 'cl');
  assert.ok(d.exists);
  assert.ok(d.files.some((f) => f.path === 'c.txt'), 'diff lists the clone-authored file');
  assert.ok(d.ahead >= 1);

  const lane = await loadLane(repo, 'cl');
  assert.equal(lane.status, 'blocked', 'lane parked at a land gate');
  const res = await ackLane(repo, 'cl');
  assert.equal(res.kind, 'land');
  assert.ok(existsSync(path.join(repo, 'c.txt')), 'landed: the file is now in the main checkout');
});

test('§26 clone: gc reaps a merged clone (dir + branch); keeps an unmerged one', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  // merged lane
  await saveLane(repo, newLane('done', {
    isolation: 'clone',
    steps: [commandStep('echo x > x.txt && git add x.txt && git commit -m x')],
  }));
  await tick(repo);
  await ackLane(repo, 'done'); // lands (merges into main)

  // unmerged lane (leave policy — never lands)
  await saveLane(repo, newLane('open', {
    isolation: 'clone',
    land: 'leave',
    steps: [commandStep('echo y > y.txt && git add y.txt && git commit -m y')],
  }));
  await tick(repo);

  const report = await gcWorktrees(repo);
  const byLane = Object.fromEntries(report.map((r) => [r.lane, r]));
  assert.equal(byLane.done?.action, 'removed', 'merged clone reaped');
  assert.match(byLane.done.reason, /clone \+ branch deleted/);
  assert.ok(!existsSync(clonePath(repo, 'done')), 'merged clone dir gone');
  assert.equal(byLane.open?.action, 'kept', 'unmerged clone kept');
  assert.ok(existsSync(clonePath(repo, 'open')), 'unmerged clone dir preserved');
});

test('§26 matrix live: a worktree + docker image lane parks with the steering message', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  // Configure a real image runner so resolveRunner yields image mode.
  const home = process.env.TASKHERD_HOME;
  await (await import('node:fs/promises')).writeFile(
    path.join(home, 'runners.json'),
    JSON.stringify({ img: { kind: 'docker', image: 'node:20-alpine', workdir: '/work' } }),
  );
  await saveLane(repo, newLane('bad', {
    isolation: 'worktree', runner: 'img', steps: [commandStep('true')],
  }));
  const r = await tick(repo);
  assert.equal(r.result, 'failed');
  const lane = await loadLane(repo, 'bad');
  assert.equal(lane.steps[0].status, 'failed');
  assert.match(lane.steps[0].parkedReason, /isolation 'worktree'.*Use isolation 'clone'/s);
});

test('§26: applyLaneOpts rejects unknown lifecycle/mcpTransport at write time (fail-closed)', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await assert.rejects(
    () => addStep(repo, 'l1', commandStep('true'), { lifecycle: 'immortal' }),
    /unknown lifecycle/,
  );
  await assert.rejects(
    () => addStep(repo, 'l2', commandStep('true'), { mcpTransport: 'telepathy' }),
    /unknown mcpTransport/,
  );
  // valid values are stored on the lane
  await addStep(repo, 'l3', commandStep('true'), { isolation: 'clone', lifecycle: 'ephemeral', mcpTransport: 'mount' });
  const lane = await loadLane(repo, 'l3');
  assert.equal(lane.isolation, 'clone');
  assert.equal(lane.lifecycle, 'ephemeral');
  assert.equal(lane.mcpTransport, 'mount');
});

test('§26: syncCloneBranch is a tolerant no-op for a non-clone lane', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  const r = await syncCloneBranch(repo, 'nope');
  assert.equal(r.synced, false);
  assert.equal(r.reason, 'no-clone');
});

test('§26: ensureClone records the base in the MAIN repo so land/diff resolve it', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await ensureClone(repo, 'cl', 'main');
  // branch created in main with taskherdbase config (like the worktree path)
  const recorded = await gitIn(repo, 'config', 'branch.taskherd/cl.taskherdbase');
  assert.equal(recorded, 'main');
  assert.ok(existsSync(laneFile(repo, 'cl')) === false, 'ensureClone does not create a lane file');
});

// ── M11b: the persistent lifecycle state machine (pure) ─────────────────────
test('§26 M11b: nextContainerAction — missing→create, drift→recreate, stopped→start, running→exec', () => {
  assert.deepEqual(
    nextContainerAction({ exists: false, wantedSignature: 'a' }).action, 'create',
  );
  assert.equal(
    nextContainerAction({
      exists: true, running: true, currentSignature: 'old', wantedSignature: 'new',
    }).action, 'recreate',
  );
  assert.equal(
    nextContainerAction({
      exists: true, running: false, currentSignature: 'a', wantedSignature: 'a',
    }).action, 'start',
  );
  assert.equal(
    nextContainerAction({
      exists: true, running: true, currentSignature: 'a', wantedSignature: 'a',
    }).action, 'exec',
  );
  // drift wins over running (a stale image/mount must never silently be reused)
  assert.equal(
    nextContainerAction({
      exists: true, running: true, currentSignature: null, wantedSignature: 'a',
    }).action, 'recreate',
  );
});

// ── M11b: container identity + drift signature ──────────────────────────────
test('§26 M11b: containerName / ephemeralContainerName sanitize to docker charset', () => {
  assert.equal(containerName('repo-abcd1234', 'ci'), 'taskherd-repo-abcd1234-ci');
  // odd repoId/lane chars collapse to '-'; the taskherd- prefix keeps a valid lead
  assert.match(containerName('re po/x', 'a b'), /^taskherd-re-po-x-a-b$/);
  assert.match(containerName('r', 'l'), /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  const eph = ephemeralContainerName('r', 'ci', 'deadbeef');
  assert.ok(eph.startsWith(EPHEMERAL_PREFIX));
  assert.match(eph, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
});

test('§26 M11b: containerSignature is deterministic, mount-order-insensitive, drifts on change', () => {
  const base = { image: 'node:20-alpine', mounts: ['/a:/x', '/b:/y'], workdir: '/work' };
  const sig = containerSignature(base);
  assert.equal(sig, containerSignature({ ...base, mounts: ['/b:/y', '/a:/x'] }), 'mount order does not matter');
  assert.notEqual(sig, containerSignature({ ...base, image: 'node:22-alpine' }), 'image change drifts');
  assert.notEqual(sig, containerSignature({ ...base, mounts: ['/a:/x'] }), 'mount set change drifts');
  assert.notEqual(sig, containerSignature({ ...base, workdir: '/srv' }), 'workdir change drifts');
});

// ── M11b: gc plan — the clone gate + orphan sweep + the §25 interlock ────────
test('§26 M11b: containerGcPlan honors the run-manifest interlock, reaps orphans/leftovers, keeps active', () => {
  const containers = [
    { name: 'taskherd-r-live', lane: 'live' }, // has a live manifest → keep
    { name: 'taskherd-r-gone', lane: 'gone' }, // lane file gone → reap
    { name: 'taskherd-r-noclone', lane: 'noclone' }, // clone reaped → reap
    { name: 'taskherd-r-active', lane: 'active' }, // lane + clone present → keep
    { name: 'taskherd-eph-r-active-abcd', lane: 'active' }, // ephemeral leftover → reap
    { name: 'taskherd-eph-r-live-ef01', lane: 'live' }, // ephemeral but live manifest → keep
  ];
  const plan = containerGcPlan({
    containers,
    laneFiles: new Set(['noclone', 'active', 'live']),
    clones: new Set(['active', 'live']),
    runningLanes: new Set(['live']),
  });
  const by = Object.fromEntries(plan.map((p) => [p.name, p]));
  assert.equal(by['taskherd-r-live'].action, 'keep');
  assert.match(by['taskherd-r-live'].reason, /interlock/);
  assert.equal(by['taskherd-r-gone'].action, 'reap');
  assert.match(by['taskherd-r-gone'].reason, /lane gone/);
  assert.equal(by['taskherd-r-noclone'].action, 'reap');
  assert.match(by['taskherd-r-noclone'].reason, /clone reaped/);
  assert.equal(by['taskherd-r-active'].action, 'keep');
  assert.equal(by['taskherd-eph-r-active-abcd'].action, 'reap');
  assert.match(by['taskherd-eph-r-active-abcd'].reason, /ephemeral/);
  assert.equal(by['taskherd-eph-r-live-ef01'].action, 'keep', 'never reap a live lane container, even ephemeral');
});

// ── M11b: wrapForRunner exec-into-persistent + ephemeral naming ─────────────
test('§26 M11b: wrapForRunner execs into a persistent container (no run/--rm/mounts/image)', () => {
  const spec = wrapForRunner(IMAGE, {
    file: 'sh', args: ['-c', 'echo hi'], laneName: 'ci',
    execContainer: 'taskherd-r-ci', execWorkdir: '/work',
    extraEnv: { ANTHROPIC_API_KEY: 'sek' },
    containerEnvInline: { TASKHERD_REPO: IN_CONTAINER_REPO, GIT_CONFIG_COUNT: '1' },
  });
  assert.equal(spec.file, 'docker');
  const argv = spec.args.join(' ');
  assert.match(argv, /^exec -i -t -w \/work/);
  assert.doesNotMatch(argv, /run|--rm|-v /); // exec adds no mounts, no --rm
  assert.match(argv, /-e ANTHROPIC_API_KEY(?!=)/); // secret by NAME only (value off-argv)
  assert.match(argv, new RegExp(`-e TASKHERD_REPO=${IN_CONTAINER_REPO}`)); // inline by value
  assert.match(argv, /-e GIT_CONFIG_COUNT=1/);
  assert.match(argv, /taskherd-r-ci sh -c echo hi/); // the named container, then the command
  // secret value never lands on the recorded argv
  assert.ok(!argv.includes('sek'));
});

test('§26 M11b: wrapForRunner names + labels an ephemeral run --rm (so timeout-kill/gc can find it)', () => {
  const spec = wrapForRunner(IMAGE, {
    file: 'sh', args: ['-c', 'true'], worktree: '/clone', repo: '/repo', laneName: 'ci',
    ephemeralName: 'taskherd-eph-r-ci-abcd', ephemeralLabels: { 'taskherd.repo': 'r', 'taskherd.lane': 'ci' },
  });
  const argv = spec.args.join(' ');
  assert.match(argv, /run --rm -i/);
  assert.match(argv, /--name taskherd-eph-r-ci-abcd/);
  assert.match(argv, /--label taskherd\.repo=r/);
  assert.match(argv, /--label taskherd\.lane=ci/);
  assert.match(argv, /-v \/clone:\/work/); // still bind-mounts the tree
});
