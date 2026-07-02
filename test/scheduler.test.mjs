import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { newLane, saveLane, loadLane, ackLane } from '../src/tasks.mjs';
import { tick } from '../src/scheduler.mjs';
import { needsAttentionFile, pausedFile } from '../src/paths.mjs';
import { readHistory } from '../src/history.mjs';
import { makeRepo } from './helpers.mjs';

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

  await import('node:fs/promises').then((fs) => fs.writeFile(pausedFile(repo), 'x'));
  const result = await tick(repo);
  assert.equal(result.outcome, 'paused');
  assert.ok(existsSync(pausedFile(repo)));

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].status, 'pending', 'nothing ran while paused');
});
