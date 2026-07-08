import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile, writeFile, mkdir, utimes,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { newLane, saveLane, loadLane, ackLane } from '../src/tasks.mjs';
import { tick } from '../src/scheduler.mjs';
import {
  needsAttentionFile, pausedFile, lockDir, lockPidFile, laneFile, eventsFile,
} from '../src/paths.mjs';
import { readHistory, statusData } from '../src/history.mjs';
import { makeRepo, installFakeClaude } from './helpers.mjs';

const FAKE_CLAUDE = `#!/bin/sh
echo '{"total_cost_usd":0.01,"session_id":"s1","usage":{"input_tokens":5,"output_tokens":5}}'
`;

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

test('waitsFor: a lane holds until its cross-lane dependency lands, then runs (§22)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  // `main`'s only step waits on `dep:U2`; `dep` runs a labelled step U2.
  const main = newLane('main');
  main.steps.push({ type: 'command', run: 'echo go', waitsFor: ['dep:U2'], status: 'pending' });
  await saveLane(repo, main);
  const dep = newLane('dep');
  dep.steps.push({ type: 'command', run: 'echo U2', id: 'U2', status: 'pending' });
  await saveLane(repo, dep);

  // Before anything runs: status shows main as waiting (dep:U2 not done yet), with
  // the reason — and it holds NO persisted blocked state (a soft, auto-clearing wait).
  const { lanes } = await statusData(repo);
  const mainRow = lanes.find((l) => l.name === 'main');
  assert.equal(mainRow.status, 'waiting');
  assert.deepEqual(mainRow.waiting, ['dep:U2']);

  // Fire 1: main is NOT runnable (dep:U2 not done) — the ONLY thing that runs is dep.
  const first = await tick(repo);
  assert.equal(first.lane, 'dep', 'main is soft-waiting, so dep is the only runnable lane');
  assert.equal((await loadLane(repo, 'dep')).steps[0].status, 'done');
  const mainAfter1 = await loadLane(repo, 'main');
  assert.equal(mainAfter1.cursor, 0);
  assert.equal(mainAfter1.status, 'idle', 'a soft wait persists NO blocked state');

  // Fire 2: dep:U2 is now done → main's wait auto-clears and it runs. No ack needed.
  const second = await tick(repo);
  assert.equal(second.lane, 'main');
  assert.equal(second.result, 'done');
  assert.equal((await loadLane(repo, 'main')).cursor, 1);
});

test('waitsFor: a mutual dependency deadlock is surfaced loudly, not hung silently (§1/§22)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  // a waits on b:x, b waits on a:y — neither can ever run.
  const a = newLane('a');
  a.steps.push({ type: 'command', run: 'echo a', id: 'y', waitsFor: ['b:x'], status: 'pending' });
  await saveLane(repo, a);
  const b = newLane('b');
  b.steps.push({ type: 'command', run: 'echo b', id: 'x', waitsFor: ['a:y'], status: 'pending' });
  await saveLane(repo, b);

  const result = await tick(repo);
  assert.equal(result.outcome, 'idle', 'nothing can run — the herd is stalled');

  // Surfaced in NEEDS-ATTENTION.md (both waiting lanes) ...
  const attention = await readFile(needsAttentionFile(repo), 'utf8');
  assert.match(attention, /\*\*a\*\*.*waiting on b:x/);
  assert.match(attention, /\*\*b\*\*.*waiting on a:y/);

  // ... and a waitsFor.deadlock event names the cycle (loud, greppable).
  const events = (await readFile(eventsFile(repo), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const deadlock = events.find((e) => e.event === 'waitsFor.deadlock');
  assert.ok(deadlock, 'a waitsFor.deadlock event is emitted');
  assert.deepEqual([...deadlock.cycle].sort(), ['a', 'b']);
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

test('a parked failure surfaces the error tail as a red failure gate', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  // A step that dies with an identifiable message on its way out — the console
  // must show WHY (the message), not just the exit code.
  lane.steps.push({ type: 'command', run: 'echo "reached your Fable 5 limit" >&2; exit 7', status: 'pending' });
  await saveLane(repo, lane);

  await tick(repo); // fail -> retry
  await tick(repo); // fail -> parked

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'failed');
  assert.equal(reloaded.status, 'blocked');
  assert.match(reloaded.steps[0].error, /reached your Fable 5 limit/, 'the operative error persisted on the step');

  // What the console reads: a failure-kind gate carrying the distilled error.
  const { lanes } = await statusData(repo);
  const main = lanes.find((l) => l.name === 'main');
  assert.equal(main.gateKind, 'failure');
  assert.match(main.gate, /exit 7/);
  assert.match(main.gateDetail, /reached your Fable 5 limit/);

  // ack re-queues the step and clears the surfaced error with it.
  await ackLane(repo, 'main');
  const acked = await loadLane(repo, 'main');
  assert.equal(acked.steps[0].status, 'pending');
  assert.equal(acked.steps[0].error, undefined, 'the error clears on retry');
});

test('run --lane targets one lane even when another would fair-pick first', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  // Both lanes are runnable and un-run (lastRun 0); a bare tick fair-picks
  // 'alpha' (alphabetical tie-break). Targeting 'beta' must override that.
  const a = newLane('alpha');
  a.steps.push({ type: 'command', run: 'echo a', status: 'pending' });
  await saveLane(repo, a);
  const b = newLane('beta');
  b.steps.push({ type: 'command', run: 'echo b', status: 'pending' });
  await saveLane(repo, b);

  const result = await tick(repo, { lane: 'beta' });
  assert.equal(result.outcome, 'ran');
  assert.equal(result.lane, 'beta');

  assert.equal((await loadLane(repo, 'alpha')).steps[0].status, 'pending', 'the untargeted lane did not run');
  assert.equal((await loadLane(repo, 'beta')).steps[0].status, 'done', 'the targeted lane advanced');
});

test('run --lane reports why a lane is not runnable (missing / idle / blocked)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const missing = await tick(repo, { lane: 'ghost' });
  assert.equal(missing.outcome, 'not-runnable');
  assert.match(missing.reason, /no such lane/);

  const idle = newLane('idle-lane'); // empty queue, no recurring default
  await saveLane(repo, idle);
  const idleRes = await tick(repo, { lane: 'idle-lane' });
  assert.equal(idleRes.outcome, 'not-runnable');
  assert.match(idleRes.reason, /nothing queued/);

  const gated = newLane('gated');
  gated.steps.push({ type: 'manual', message: 'sign off', status: 'pending' });
  await saveLane(repo, gated);
  const gatedRes = await tick(repo, { lane: 'gated' }); // scan blocks the gate, then it is not runnable
  assert.equal(gatedRes.outcome, 'not-runnable');
  assert.match(gatedRes.reason, /blocked on a gate/);
});

test('run --force overrides PAUSE for a single manual run', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'echo hi', status: 'pending' });
  await saveLane(repo, lane);
  await writeFile(pausedFile(repo), 'paused\n');

  assert.equal((await tick(repo, { lane: 'main' })).outcome, 'paused', 'a paused herd skips by default');
  assert.equal((await loadLane(repo, 'main')).steps[0].status, 'pending', 'nothing ran while paused');

  const forced = await tick(repo, { lane: 'main', force: true });
  assert.equal(forced.outcome, 'ran');
  assert.equal((await loadLane(repo, 'main')).steps[0].status, 'done', 'force ran the step despite PAUSE');
  assert.ok(existsSync(pausedFile(repo)), 'the pause switch itself is left in place');
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
  // A hand-authored step of an unknown type is unsupported -> loadLane throws.
  await writeFile(laneFile(repo, 'broken'), JSON.stringify({ name: 'broken', cursor: 0, steps: [{ type: 'frobnicate', run: 'x' }] }));

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

test('ai step runs via the scheduler and its cost lands in history (M2 exit)', async (t) => {
  const { repo, home, cleanup } = await makeRepo();
  t.after(cleanup);
  await installFakeClaude(home, FAKE_CLAUDE);

  const lane = newLane('work');
  lane.steps.push({ type: 'ai', task: '/work', provider: 'claude', status: 'pending' });
  await saveLane(repo, lane);

  const result = await tick(repo);
  assert.equal(result.result, 'done');
  assert.equal(result.cost, 0.01, 'the run reports its parsed cost');

  const history = await readHistory(repo);
  assert.equal(history.at(-1).cost, 0.01, 'cost is recorded in history.jsonl (DESIGN §10)');
  assert.equal(history.at(-1).type, 'ai');

  const reloaded = await loadLane(repo, 'work');
  assert.equal(reloaded.session.id, 's1', 'the session id is carried on the lane for the next fire');
});

test('spend cap: a cumulative budget blocks the lane once exhausted (M2 exit)', async (t) => {
  const { repo, home, cleanup } = await makeRepo();
  t.after(cleanup);
  await installFakeClaude(home, FAKE_CLAUDE); // each run costs $0.01

  // A recurring /work lane (onEmpty=default) with a $0.005 lifetime cap.
  const lane = newLane('work', {
    onEmpty: 'default',
    default: { type: 'ai', task: '/work', provider: 'claude', budget: { usd: 0.005 } },
  });
  await saveLane(repo, lane);

  const first = await tick(repo);
  assert.equal(first.outcome, 'ran', 'first fire runs (nothing spent yet)');
  assert.equal(first.cost, 0.01);

  const second = await tick(repo);
  assert.equal(second.outcome, 'idle', 'the lane is now over budget, nothing runnable');

  const reloaded = await loadLane(repo, 'work');
  assert.equal(reloaded.status, 'blocked');
  assert.match(reloaded.budgetBlock, /budget exhausted/);

  const attention = await readFile(needsAttentionFile(repo), 'utf8');
  assert.match(attention, /budget exhausted/);

  // Acking clears the (soft) budget block.
  const acked = await ackLane(repo, 'work');
  assert.equal(acked.kind, 'budget');
  const cleared = await loadLane(repo, 'work');
  assert.equal(cleared.status, 'idle');
  assert.equal(cleared.budgetBlock, undefined);
});

test('a misconfigured ai step parks immediately (setup error, not a crash)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('work');
  lane.steps.push({ type: 'ai', task: '/work', provider: 'nonesuch', status: 'pending' });
  await saveLane(repo, lane);

  const result = await tick(repo);
  assert.equal(result.result, 'failed');

  const reloaded = await loadLane(repo, 'work');
  assert.equal(reloaded.steps[0].status, 'failed', 'parked on the FIRST failure (retrying a config error is pointless)');
  assert.equal(reloaded.status, 'blocked');
  assert.match(reloaded.steps[0].parkedReason, /could not start.*unknown provider/s);
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
