import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile, writeFile, mkdir, utimes,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { newLane, saveLane, loadLane, ackLane } from '../src/tasks.mjs';
import { tick } from '../src/scheduler.mjs';
import {
  needsAttentionFile, pausedFile, lockDir, lockPidFile, laneFile,
} from '../src/paths.mjs';
import { readHistory } from '../src/history.mjs';
import { makeRepo } from './helpers.mjs';

const AGED = () => new Date(Date.now() - 60 * 60_000); // an hour ago, well past STALE_LOCK_MIN

test('scheduler runs a pending command step and advances the cursor', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'echo hi', status: 'pending' });
  await saveLane(repo, lane);

  const result = await tick(repo);
  assert.equal(result.outcome, 'ran');
  assert.equal(result.result, 'done');

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.cursor, 1);
  assert.equal(reloaded.steps[0].status, 'done');

  const history = await readHistory(repo);
  assert.equal(history.length, 1);
  assert.equal(history[0].result, 'done');
});

test('a manual gate blocks its lane and shows up in NEEDS-ATTENTION.md', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'manual', message: 'sign off please', status: 'pending' });
  await saveLane(repo, lane);

  const result = await tick(repo);
  assert.equal(result.outcome, 'idle', 'the only lane is now gated, nothing runnable');

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.status, 'blocked');
  assert.equal(reloaded.steps[0].status, 'blocked');

  const attention = await readFile(needsAttentionFile(repo), 'utf8');
  assert.match(attention, /sign off please/);

  // ack clears the gate, and a later tick has nothing left to do (idle).
  const acked = await ackLane(repo, 'main');
  assert.equal(acked.kind, 'gate');
  const afterAck = await tick(repo);
  assert.equal(afterAck.outcome, 'idle');
});

test('fair pick: least-recently-run lane goes first, tie-break by name', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  for (const name of ['b', 'a']) {
    const lane = newLane(name);
    lane.steps.push({ type: 'command', run: 'echo one', status: 'pending' });
    lane.steps.push({ type: 'command', run: 'echo two', status: 'pending' });
    await saveLane(repo, lane);
  }

  const first = await tick(repo);
  assert.equal(first.lane, 'a', 'both lanes tie at lastRun=0, "a" sorts first');

  const second = await tick(repo);
  assert.equal(second.lane, 'b', 'b has not run yet, a now has a higher lastRun');
});

test('a failing command step retries once, then parks the lane as a gate', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'exit 1', status: 'pending' });
  await saveLane(repo, lane);

  const first = await tick(repo);
  assert.equal(first.result, 'failed');
  let reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'pending', 'first failure just retries');
  assert.equal(reloaded.steps[0].attempts, 1);
  assert.equal(reloaded.status, 'idle');

  const second = await tick(repo);
  assert.equal(second.result, 'failed');
  reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'failed', 'second failure parks the step');
  assert.equal(reloaded.status, 'blocked');

  const third = await tick(repo);
  assert.equal(third.outcome, 'idle', 'parked lane is not runnable until acked');
});

test('mutex: concurrent ticks on the same repo, only one runs', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'sleep 0.3', status: 'pending' });
  await saveLane(repo, lane);

  const [a, b] = await Promise.all([tick(repo), tick(repo)]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ['locked', 'ran']);
});

test('PAUSED halts the scheduler without touching lane state', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'echo hi', status: 'pending' });
  await saveLane(repo, lane);

  await writeFile(pausedFile(repo), 'x');
  const result = await tick(repo);
  assert.equal(result.outcome, 'paused');
  assert.ok(existsSync(pausedFile(repo)));

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'pending', 'nothing ran while paused');
});

test('lock: an aged lock whose owner is still ALIVE is not stolen (bug #1)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'echo hi', status: 'pending' });
  await saveLane(repo, lane);

  // Simulate a peer mid-run: lock present, mtime aged past the stale threshold,
  // but the owning pid is alive (this process). A live heartbeat/pid must win.
  await mkdir(lockDir(repo));
  await writeFile(lockPidFile(repo), `${process.pid}\n`);
  const old = AGED();
  await utimes(lockDir(repo), old, old);

  const result = await tick(repo);
  assert.equal(result.outcome, 'locked', 'a live owner keeps the lock despite an aged mtime');
  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'pending', 'the step did not double-run');
});

test('lock: an aged lock whose owner is DEAD is reclaimed', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'echo hi', status: 'pending' });
  await saveLane(repo, lane);

  await mkdir(lockDir(repo));
  await writeFile(lockPidFile(repo), '2147483647\n'); // a pid that does not exist
  const old = AGED();
  await utimes(lockDir(repo), old, old);

  const result = await tick(repo);
  assert.equal(result.outcome, 'ran', 'a dead owner + aged mtime is genuinely stale');
  assert.equal(result.result, 'done');
});

test('lost-update: a step added mid-run is not clobbered by the run write-back (bug #2)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'sleep 0.5', status: 'pending' });
  await saveLane(repo, lane);

  const runP = tick(repo); // holds the lock, runs `sleep 0.5`
  await new Promise((r) => { setTimeout(r, 150); });
  // Simulate a concurrent `taskherd add` writing straight to disk (it takes no lock).
  const disk = await loadLane(repo, 'main');
  disk.steps.push({ type: 'command', run: 'echo added', status: 'pending' });
  await saveLane(repo, disk);

  const result = await runP;
  assert.equal(result.result, 'done');

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps.length, 2, 'the concurrently-added step survived');
  assert.equal(reloaded.steps[1].run, 'echo added');
  assert.equal(reloaded.steps[0].status, 'done', 'the run still recorded its own result');
  assert.equal(reloaded.cursor, 1);
});

test('resilient: one unloadable lane file does not brick a healthy lane (bug #5)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const healthy = newLane('healthy');
  healthy.steps.push({ type: 'command', run: 'echo ok', status: 'pending' });
  await saveLane(repo, healthy);
  // A hand-authored `ai` step is unsupported this milestone -> loadLane throws.
  await writeFile(laneFile(repo, 'broken'), JSON.stringify({ name: 'broken', cursor: 0, steps: [{ type: 'ai', task: '/work' }] }));

  const result = await tick(repo);
  assert.equal(result.outcome, 'ran');
  assert.equal(result.lane, 'healthy', 'the healthy lane still ran');

  const attention = await readFile(needsAttentionFile(repo), 'utf8');
  assert.match(attention, /broken/);
  assert.match(attention, /unloadable/);
});

test('timeout park reason reads "timed out after ..." not "exit null" (bug #4)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const prev = process.env.TASKHERD_KILL_GRACE_MS;
  process.env.TASKHERD_KILL_GRACE_MS = '200';
  t.after(() => {
    if (prev === undefined) delete process.env.TASKHERD_KILL_GRACE_MS;
    else process.env.TASKHERD_KILL_GRACE_MS = prev;
  });

  const lane = newLane('main', { timeout: '200ms' });
  lane.steps.push({ type: 'command', run: 'trap "" TERM; while true; do :; done', status: 'pending' });
  await saveLane(repo, lane);

  await tick(repo); // times out -> first retry
  await tick(repo); // times out again -> parked

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'failed');
  assert.equal(reloaded.status, 'blocked');
  assert.match(reloaded.steps[0].parkedReason, /timed out after/);
  assert.doesNotMatch(reloaded.steps[0].parkedReason, /exit null/);

  const history = await readHistory(repo);
  assert.equal(history.at(-1).timedOut, true, 'history records the timeout');
});

test('ack of a parked failure resets attempts and the step re-runs', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'exit 1', status: 'pending' });
  await saveLane(repo, lane);

  await tick(repo); // fail -> retry
  await tick(repo); // fail -> parked
  let reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'failed');
  assert.equal(reloaded.steps[0].attempts, 2);

  const acked = await ackLane(repo, 'main');
  assert.equal(acked.kind, 'failure');
  reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'pending');
  assert.equal(reloaded.steps[0].attempts, 0, 'attempts reset so the retry budget is fresh');

  const again = await tick(repo);
  assert.equal(again.result, 'failed', 'the acked step actually re-ran');
  reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].attempts, 1);
});
