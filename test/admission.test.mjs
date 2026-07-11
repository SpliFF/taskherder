// Parallel lanes — admission control (DESIGN §25, M10): the pure predicate
// matrix, run-manifest lifecycle + staleness, concurrent-fire admission,
// mutex exclusion, inplace exclusivity, the serial-mode busy guard, budgets
// still enforced per lane, status surfacing, and the TASKHERD_PORT_BASE
// convention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, utimes, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  parallelMax, admissible, describeHold, isIsolated, isExclusive,
  writeRunManifest, removeRunManifest, readRunningSet, runManifestFile,
} from '../src/admission.mjs';
import { lanePortBase } from '../src/paths.mjs';
import { wrapForRunner } from '../src/runners.mjs';
import { tick } from '../src/scheduler.mjs';
import { addStep, loadLane, LaneValidationError } from '../src/tasks.mjs';
import { statusData, appendHistory } from '../src/history.mjs';
import { makeRepo, makeGitRepo, waitFor } from './helpers.mjs';

const WT = { lane: 'x', isolation: 'worktree', runnerKind: 'local', parallel: null, mutex: [] };
const live = (over = {}) => ({ lane: 'aa', pid: process.pid, isolation: 'worktree', runnerKind: 'local', parallel: null, mutex: [], ...over });

function deadPid() {
  const { pid } = spawnSync('true');
  return pid;
}

// A manifest is written UNDER the admission lock, moments before it is
// released — so "the lane was admitted" for a test firing a second tick means
// manifest present AND lock gone (else the overlapping fire reads `locked`).
function admittedAndUnlocked(repo, lane) {
  return existsSync(runManifestFile(repo, lane)) && !existsSync(path.join(repo, '.tasks', '.lock'));
}

// ── the predicate (pure) ────────────────────────────────────────────────────

test('admission predicate matrix (DESIGN §25)', () => {
  // Alone, anything runs — serial semantics, even an inplace lane.
  assert.equal(admissible({ ...WT, isolation: 'inplace' }, [], 2).ok, true);
  assert.equal(admissible(WT, [], 2).ok, true);

  // An exclusive live run (unisolated, or parallel:false) blocks ALL admission.
  for (const excl of [live({ isolation: 'inplace' }), live({ isolation: 'none' }), live({ parallel: false })]) {
    const v = admissible(WT, [excl], 4);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'exclusive');
    assert.deepEqual(v.blockers, ['aa']);
  }

  // A non-isolated candidate never joins a live set.
  const ni = admissible({ ...WT, isolation: 'inplace' }, [live()], 4);
  assert.equal(ni.ok, false);
  assert.equal(ni.reason, 'not-isolated');

  // parallel:false takes the serial slot: it never joins a live set either.
  const sl = admissible({ ...WT, parallel: false }, [live()], 4);
  assert.equal(sl.ok, false);
  assert.equal(sl.reason, 'serial-lane');

  // mutex: a shared tag excludes; disjoint tags admit.
  const clash = admissible({ ...WT, mutex: ['db', 'port80'] }, [live({ mutex: ['db'] })], 4);
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, 'mutex');
  assert.deepEqual(clash.tags, ['db']);
  assert.match(describeHold(clash), /serialized: waiting on aa .*mutex 'db'/);
  assert.equal(admissible({ ...WT, mutex: ['port80'] }, [live({ mutex: ['db'] })], 4).ok, true);

  // capacity: max caps the live count.
  const cap = admissible(WT, [live(), live({ lane: 'bb' })], 2);
  assert.equal(cap.ok, false);
  assert.equal(cap.reason, 'capacity');
  assert.equal(admissible(WT, [live()], 2).ok, true);

  // Off-host runners count as isolated even without worktree isolation.
  assert.equal(isIsolated({ isolation: 'none', runnerKind: 'docker' }), true);
  assert.equal(isIsolated({ isolation: 'none', runnerKind: 'ssh' }), true);
  assert.equal(admissible({ ...WT, isolation: 'none', runnerKind: 'docker' }, [live()], 4).ok, true);
  assert.equal(isExclusive(live({ isolation: 'none', runnerKind: 'docker' })), false);
});

test('parallelMax: absent ⇒ 1, {max:N} ⇒ N, malformed throws loudly', () => {
  assert.equal(parallelMax({}), 1);
  assert.equal(parallelMax({ parallel: null }), 1);
  assert.equal(parallelMax({ parallel: {} }), 1);
  assert.equal(parallelMax({ parallel: { max: 3 } }), 3);
  assert.throws(() => parallelMax({ parallel: 'yes' }), /parallel.*must be an object/);
  assert.throws(() => parallelMax({ parallel: { max: 0 } }), /integer >= 1/);
  assert.throws(() => parallelMax({ parallel: { max: 'two' } }), /integer >= 1/);
});

// ── run manifests ───────────────────────────────────────────────────────────

test('run manifest lifecycle: write → read → remove; non-manifests ignored', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await writeRunManifest(repo, { lane: 'ci', isolation: 'worktree', runnerKind: 'local', mutex: ['db'] });
  // Our own non-manifest files in run/ must never read as manifests.
  await writeFile(path.join(repo, '.tasks', 'run', 'ci.mcp.json'), '{"mcpServers":{}}\n');
  await writeFile(path.join(repo, '.tasks', 'run', 'probe-cache.json'), '{"k":{}}\n');
  const { running, invalid } = await readRunningSet(repo);
  assert.equal(invalid.length, 0);
  assert.equal(running.length, 1);
  assert.equal(running[0].lane, 'ci');
  assert.equal(running[0].pid, process.pid);
  assert.deepEqual(running[0].mutex, ['db']);
  await removeRunManifest(repo, 'ci');
  assert.equal((await readRunningSet(repo)).running.length, 0);
});

test('manifest staleness: old mtime + dead pid reaped; fresh-but-dead and old-but-alive stay (fail closed)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const old = new Date(Date.now() - 16 * 60_000);

  // old mtime + dead pid ⇒ stale: excluded, and reaped only when reap:true.
  await writeRunManifest(repo, { lane: 'stale', pid: deadPid() });
  await utimes(runManifestFile(repo, 'stale'), old, old);
  const ro = await readRunningSet(repo, { reap: false });
  assert.equal(ro.running.length, 0);
  assert.equal(ro.reaped.length, 1);
  assert.ok(existsSync(runManifestFile(repo, 'stale')), 'reap:false must not delete');
  const rw = await readRunningSet(repo);
  assert.equal(rw.reaped.length, 1);
  assert.ok(!existsSync(runManifestFile(repo, 'stale')), 'reap:true removes the stale manifest');

  // fresh mtime + dead pid ⇒ still counted live (the heartbeat window hasn't aged out).
  await writeRunManifest(repo, { lane: 'fresh-dead', pid: deadPid() });
  assert.equal((await readRunningSet(repo)).running.length, 1);
  await removeRunManifest(repo, 'fresh-dead');

  // old mtime + LIVE pid ⇒ counted (a wedged heartbeat never steals a live run).
  await writeRunManifest(repo, { lane: 'old-alive', pid: process.pid });
  await utimes(runManifestFile(repo, 'old-alive'), old, old);
  assert.equal((await readRunningSet(repo)).running.length, 1);
});

test('unreadable / misshapen manifest reads as invalid (fail closed)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await writeFile(path.join(repo, '.tasks', 'run', 'junk.json'), 'not json{{{\n');
  await writeFile(path.join(repo, '.tasks', 'run', 'shapeless.json'), '{"hello":"world"}\n');
  const { running, invalid } = await readRunningSet(repo);
  assert.equal(running.length, 0);
  assert.equal(invalid.length, 2);
});

// ── lane fields ─────────────────────────────────────────────────────────────

test('lane parallel:false + mutex persist via addStep laneOpts; bad tags throw', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'serial-lane', { run: 'true' }, { parallel: false, mutex: 'db, api' });
  const lane = await loadLane(repo, 'serial-lane');
  assert.equal(lane.parallel, false);
  assert.deepEqual(lane.mutex, ['db', 'api']);
  await assert.rejects(
    addStep(repo, 'serial-lane', { run: 'true' }, { mutex: 'bad/tag' }),
    LaneValidationError,
  );
  await assert.rejects(
    addStep(repo, 'serial-lane', { run: 'true' }, { parallel: 'maybe' }),
    /must be true or false/,
  );
});

// ── the scheduler paths ─────────────────────────────────────────────────────

async function setParallel(repo, max) {
  const cfgFile = path.join(repo, '.tasks', 'config.json');
  const cfg = JSON.parse(await readFile(cfgFile, 'utf8'));
  cfg.parallel = { max };
  await writeFile(cfgFile, JSON.stringify(cfg, null, 2));
}

test('concurrent fires admit two isolated lanes (DESIGN §25 exit demo core)', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await setParallel(repo, 2);
  await addStep(repo, 'aa', { run: 'sleep 2' });
  await addStep(repo, 'bb', { run: 'sleep 2' });

  const p1 = tick(repo);
  await waitFor(() => admittedAndUnlocked(repo, 'aa'), { timeout: 10_000 });
  const p2 = tick(repo);
  // Both manifests live at once = two lanes genuinely running concurrently.
  await waitFor(() => existsSync(runManifestFile(repo, 'aa')) && existsSync(runManifestFile(repo, 'bb')), { timeout: 10_000 });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.outcome, 'ran');
  assert.equal(r1.lane, 'aa');
  assert.equal(r2.outcome, 'ran');
  assert.equal(r2.lane, 'bb');
  assert.ok(!existsSync(runManifestFile(repo, 'aa')), 'manifest removed on exit');
  assert.ok(!existsSync(runManifestFile(repo, 'bb')), 'manifest removed on exit');
  const a = await loadLane(repo, 'aa');
  const b = await loadLane(repo, 'bb');
  assert.equal(a.steps[0].status, 'done');
  assert.equal(b.steps[0].status, 'done');
});

test('mutex tags exclude: the second fire holds, then runs once the first exits', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await setParallel(repo, 2);
  await addStep(repo, 'aa', { run: 'sleep 1.5' }, { mutex: 'db' });
  await addStep(repo, 'bb', { run: 'true' }, { mutex: 'db' });

  const p1 = tick(repo);
  await waitFor(() => admittedAndUnlocked(repo, 'aa'), { timeout: 10_000 });
  const r2 = await tick(repo);
  assert.equal(r2.outcome, 'held');
  assert.equal(r2.holds.length, 1);
  assert.equal(r2.holds[0].lane, 'bb');
  assert.match(r2.holds[0].reason, /serialized: waiting on aa .*mutex 'db'/);
  assert.equal((await tick(repo, { lane: 'bb' })).outcome, 'not-runnable'); // targeted run explains too
  const r1 = await p1;
  assert.equal(r1.outcome, 'ran');
  // Slot free again — bb admits now.
  const r3 = await tick(repo);
  assert.equal(r3.outcome, 'ran');
  assert.equal(r3.lane, 'bb');
});

test('inplace exclusivity: an unisolated lane neither joins nor is joined', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await setParallel(repo, 2);
  await addStep(repo, 'aa', { run: 'sleep 1.5' });
  await addStep(repo, 'cc', { run: 'sleep 1.5' }, { isolation: 'inplace' });

  // (a) worktree lane live → the inplace lane is held (not isolated).
  const p1 = tick(repo);
  await waitFor(() => admittedAndUnlocked(repo, 'aa'), { timeout: 10_000 });
  const held = await tick(repo);
  assert.equal(held.outcome, 'held');
  assert.match(held.holds[0].reason, /not isolated/);
  assert.equal((await p1).outcome, 'ran');

  // (b) inplace lane live → it is exclusive; the worktree lane is held.
  await addStep(repo, 'aa', { run: 'true' });
  const p2 = tick(repo); // fair-pick: aa ran last, so cc (inplace) goes first
  await waitFor(() => admittedAndUnlocked(repo, 'cc'), { timeout: 10_000 });
  const held2 = await tick(repo);
  assert.equal(held2.outcome, 'held');
  assert.match(held2.holds[0].reason, /runs exclusively/);
  assert.equal((await p2).lane, 'cc');
});

test('serial mode with live run manifests fails closed (busy), and reaps stale leftovers', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'aa', { run: 'true' });
  // A live manifest from a (simulated) parallel fire whose config was since removed.
  await writeRunManifest(repo, { lane: 'zz', isolation: 'worktree', runnerKind: 'local' });
  assert.equal((await tick(repo)).outcome, 'busy');
  await removeRunManifest(repo, 'zz');

  // A STALE leftover must not wedge serial mode: it is reaped and the tick runs.
  await writeRunManifest(repo, { lane: 'zz', pid: deadPid() });
  const old = new Date(Date.now() - 16 * 60_000);
  await utimes(runManifestFile(repo, 'zz'), old, old);
  const r = await tick(repo);
  assert.equal(r.outcome, 'ran');
  assert.ok(!existsSync(runManifestFile(repo, 'zz')));
});

test('budgets still gate per lane under parallel mode', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await setParallel(repo, 2);
  await addStep(repo, 'ai-lane', {
    type: 'ai', provider: 'claude', task: 'do things', budgetUsd: 0.05,
  });
  await appendHistory(repo, { lane: 'ai-lane', step: 0, result: 'done', cost: 0.06 });
  const r = await tick(repo);
  assert.equal(r.outcome, 'idle'); // the only lane got budget-blocked before admission
  const lane = await loadLane(repo, 'ai-lane');
  assert.equal(lane.status, 'blocked');
  assert.match(lane.budgetBlock, /budget/);
});

// ── surfacing ───────────────────────────────────────────────────────────────

test('statusData: held lane reads "serialized: waiting on …" + parallel running set (§25 rule 3)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await setParallel(repo, 2);
  await addStep(repo, 'bb', { run: 'true' }, { mutex: 'db' });
  // A live (pid-alive) manifest for aa: bb is runnable but held by the shared tag.
  await writeRunManifest(repo, {
    lane: 'aa', isolation: 'worktree', runnerKind: 'local', parallel: null, mutex: ['db'],
  });
  const s = await statusData(repo);
  assert.deepEqual(s.parallel, { max: 2, running: ['aa'] });
  const bb = s.lanes.find((l) => l.name === 'bb');
  assert.match(bb.serialized, /serialized: waiting on aa/);
  await removeRunManifest(repo, 'aa');
  const after = await statusData(repo);
  assert.equal(after.lanes.find((l) => l.name === 'bb').serialized, null);
});

test('statusData: overlap advisory when two runnable isolated lanes touch the same file (§25 rule 4)', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await setParallel(repo, 2);
  const { ensureWorktree } = await import('../src/git.mjs');
  const { gitIn } = await import('./helpers.mjs');
  for (const lane of ['aa', 'bb']) {
    const wt = await ensureWorktree(repo, lane, 'main');
    await writeFile(path.join(wt, 'README.md'), `edit by ${lane}\n`);
    await gitIn(wt, 'commit', '-qam', `edit by ${lane}`);
    await addStep(repo, lane, { run: 'true' });
  }
  const s = await statusData(repo);
  assert.equal(s.overlaps.length, 1);
  assert.deepEqual(s.overlaps[0].lanes, ['aa', 'bb']);
  assert.deepEqual(s.overlaps[0].files, ['README.md']);
});

// ── TASKHERD_PORT_BASE (§25 rule 2) ─────────────────────────────────────────

test('lanePortBase: deterministic, 50-aligned, in [20000, 30000)', () => {
  const a = lanePortBase('aa');
  assert.equal(a, lanePortBase('aa'));
  for (const name of ['aa', 'bb', 'ci', 'a-very-long-lane-name']) {
    const base = lanePortBase(name);
    assert.ok(base >= 20000 && base < 30000, `${name}: ${base}`);
    assert.equal(base % 50, 0);
  }
});

test('TASKHERD_PORT_BASE crosses every runner kind', () => {
  const local = wrapForRunner({ kind: 'local' }, { file: 'true', args: [], portBase: 20450 });
  assert.equal(local.env.TASKHERD_PORT_BASE, '20450');
  const docker = wrapForRunner({ kind: 'docker', container: 'box' }, { file: 'true', args: [], portBase: 20450 });
  assert.ok(docker.args.includes('-e') && docker.args.includes('TASKHERD_PORT_BASE'));
  assert.equal(docker.env.TASKHERD_PORT_BASE, '20450');
  const ssh = wrapForRunner({ kind: 'ssh', host: 'h' }, { file: 'true', args: [], portBase: 20450 });
  assert.match(ssh.args[ssh.args.length - 1], /TASKHERD_PORT_BASE=20450 exec/);
  // Without a portBase nothing is injected (probes, web shells).
  const none = wrapForRunner({ kind: 'local' }, { file: 'true', args: [] });
  assert.equal('TASKHERD_PORT_BASE' in none.env, 'TASKHERD_PORT_BASE' in process.env);
});
