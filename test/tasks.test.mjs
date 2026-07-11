import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir } from 'node:fs/promises';
import {
  newLane, saveLane, loadLane, nextAction, validateStep, LaneValidationError,
  loadAllLanesResilient, buildStep, ackLane, removeStep, forkLane, addStep,
  parseWaitRef, evaluateWaits, computeWaiting, detectWaitCycles,
} from '../src/tasks.mjs';
import { laneFile, projectConfigFile } from '../src/paths.mjs';
import { makeRepo } from './helpers.mjs';

test('lane save/load round-trip preserves steps', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'echo hi', status: 'pending' });
  lane.steps.push({ type: 'manual', message: 'sign off', status: 'pending' });
  await saveLane(repo, lane);

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps.length, 2);
  assert.equal(reloaded.steps[0].run, 'echo hi');
  assert.equal(reloaded.steps[1].message, 'sign off');
});

test('addStep positions: end appends (default), next interposes at the cursor, index inserts before (§15)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  // Build a three-step queue and advance the cursor past the first (done).
  await addStep(repo, 'main', { type: 'command', task: 'echo a' }); // step 0
  await addStep(repo, 'main', { type: 'command', task: 'echo b' }); // step 1 (cursor)
  await addStep(repo, 'main', { type: 'command', task: 'echo c' }); // step 2
  let lane = await loadLane(repo, 'main');
  lane.cursor = 1;
  await saveLane(repo, lane);

  // Default (no `at`) appends to the end.
  const appended = await addStep(repo, 'main', { type: 'command', task: 'echo end' });
  assert.equal(appended.index, 3, 'append lands at the tail');

  // `next` interposes at the cursor so it fires ahead of the pending step (echo b).
  const gated = await addStep(
    repo, 'main', { type: 'manual', message: 'look first' }, { at: 'next' },
  );
  assert.equal(gated.index, 1, "'next' lands at the cursor, not the tail");
  lane = await loadLane(repo, 'main');
  assert.equal(lane.steps[1].message, 'look first');
  assert.equal(lane.steps[2].run, 'echo b', 'the previously-pending step is pushed back one');

  // An explicit index inserts before it (must be at/after the cursor).
  const at2 = await addStep(repo, 'main', { type: 'command', task: 'echo at2' }, { at: '2' });
  assert.equal(at2.index, 2);
  assert.equal((await loadLane(repo, 'main')).steps[2].run, 'echo at2');
});

test('addStep rejects an out-of-range or below-the-cursor position loudly (no silent clamp; §1/§15)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'main', { type: 'command', task: 'echo a' });
  await addStep(repo, 'main', { type: 'command', task: 'echo b' });
  const lane = await loadLane(repo, 'main');
  lane.cursor = 1; // step 0 already ran — inserting at 0 would rewrite history
  await saveLane(repo, lane);

  await assert.rejects(
    () => addStep(repo, 'main', { type: 'command', task: 'x' }, { at: '0' }),
    (err) => err instanceof LaneValidationError && /cannot insert/.test(err.message),
  );
  await assert.rejects(
    () => addStep(repo, 'main', { type: 'command', task: 'x' }, { at: '99' }),
    /cannot insert/,
  );
  await assert.rejects(
    () => addStep(repo, 'main', { type: 'command', task: 'x' }, { at: 'bogus' }),
    /cannot insert/,
  );
});

test('parseWaitRef: lane:id, :id (self), bare lane; rejects malformed refs (§22)', () => {
  assert.deepEqual(parseWaitRef('grammar-unification:U2'), { lane: 'grammar-unification', stepId: 'U2' });
  assert.deepEqual(parseWaitRef(':U2'), { lane: null, stepId: 'U2' });
  assert.deepEqual(parseWaitRef('grammar-unification'), { lane: 'grammar-unification', stepId: null });
  assert.throws(() => parseWaitRef('lane:'), LaneValidationError); // empty id
  assert.throws(() => parseWaitRef('bad/lane:x'), LaneValidationError); // bad lane token
  assert.throws(() => parseWaitRef(''), LaneValidationError);
});

test('validateStep + buildStep carry id/waitsFor and reject bad shapes (§22)', () => {
  const step = buildStep({ type: 'command', task: 'echo hi', id: 'M-G', waitsFor: ['g:U2', 'g:C2'] });
  assert.equal(step.id, 'M-G');
  assert.deepEqual(step.waitsFor, ['g:U2', 'g:C2']);
  // A comma/space string normalizes to an array.
  assert.deepEqual(buildStep({ type: 'command', task: 'x', waitsFor: 'a:1, b:2' }).waitsFor, ['a:1', 'b:2']);
  assert.throws(() => validateStep({ type: 'command', run: 'x', id: 'bad:id', status: 'pending' }), LaneValidationError);
  assert.throws(() => validateStep({ type: 'command', run: 'x', waitsFor: 'notarray', status: 'pending' }), LaneValidationError);
  assert.throws(() => validateStep({ type: 'command', run: 'x', waitsFor: ['ok', 'lane:'], status: 'pending' }), LaneValidationError);
});

test('evaluateWaits: satisfied only when the target step is done; classifies misses (§22)', () => {
  const lanes = {
    main: newLane('main'),
    g: { ...newLane('g'), cursor: 1, steps: [{ type: 'command', run: 'x', id: 'U2', status: 'done' }, { type: 'command', run: 'y', id: 'C2', status: 'pending' }] },
  };
  const waiterDone = { type: 'ai', task: 't', waitsFor: ['g:U2'] };
  assert.equal(evaluateWaits(waiterDone, 'main', lanes).satisfied, true);

  const waiterPending = { type: 'ai', task: 't', waitsFor: ['g:C2'] };
  const p = evaluateWaits(waiterPending, 'main', lanes);
  assert.equal(p.satisfied, false);
  assert.equal(p.unmet[0].reason, 'step-pending');

  assert.equal(evaluateWaits({ waitsFor: ['g:NOPE'] }, 'main', lanes).unmet[0].reason, 'missing-step');
  assert.equal(evaluateWaits({ waitsFor: ['ghost:x'] }, 'main', lanes).unmet[0].reason, 'missing-lane');
  // Whole-lane ref: g still has a pending step (cursor 1 < 2) → not satisfied.
  assert.equal(evaluateWaits({ waitsFor: ['g'] }, 'main', lanes).satisfied, false);
  // A step with no waitsFor is trivially satisfied.
  assert.equal(evaluateWaits({ type: 'command', run: 'x' }, 'main', lanes).satisfied, true);
});

test('computeWaiting + detectWaitCycles: flags waiting lanes and true deadlocks (§22)', () => {
  // main waits on g:U2 (not done) → waiting; g is runnable, no cycle.
  const soft = [
    { ...newLane('main'), steps: [{ type: 'ai', task: 't', waitsFor: ['g:U2'], status: 'pending' }] },
    { ...newLane('g'), steps: [{ type: 'command', run: 'x', id: 'U2', status: 'pending' }] },
  ];
  const waitingSoft = computeWaiting(soft);
  assert.deepEqual(waitingSoft.map((w) => w.lane), ['main']);
  assert.equal(detectWaitCycles(waitingSoft).length, 0, 'a wait on a runnable lane is not a cycle');

  // a waits on b:x, b waits on a:y → both waiting, a true cycle.
  const dead = [
    { ...newLane('a'), steps: [{ type: 'command', run: 'x', id: 'y', waitsFor: ['b:x'], status: 'pending' }] },
    { ...newLane('b'), steps: [{ type: 'command', run: 'x', id: 'x', waitsFor: ['a:y'], status: 'pending' }] },
  ];
  const waitingDead = computeWaiting(dead);
  assert.deepEqual(waitingDead.map((w) => w.lane).sort(), ['a', 'b']);
  assert.deepEqual(detectWaitCycles(waitingDead).sort(), ['a', 'b']);
});

test('lane mutations reject path-traversal names at every entry point (MCP/serve reach these; §12)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const evil = '../../../../etc/whatever';
  await assert.rejects(() => ackLane(repo, evil), /invalid lane name/);
  await assert.rejects(() => removeStep(repo, evil, 0), /invalid lane name/);
  await assert.rejects(() => forkLane(repo, 'ok', evil), /invalid lane name/); // the parent (from)
  await assert.rejects(() => forkLane(repo, '../escape', 'parent'), /invalid lane name/); // the new name
});

test('validateStep rejects unknown types and missing required fields', () => {
  assert.throws(() => validateStep({ type: 'frobnicate' }), LaneValidationError);
  assert.throws(() => validateStep({ type: 'command' }), LaneValidationError);
  assert.throws(() => validateStep({ type: 'manual' }), LaneValidationError);
  // ai needs a prompt source (task or file); provider is resolved by inheritance.
  assert.throws(() => validateStep({ type: 'ai', provider: 'claude' }), LaneValidationError);
  assert.doesNotThrow(() => validateStep({ type: 'command', run: 'echo hi' }));
  assert.doesNotThrow(() => validateStep({ type: 'manual', message: 'ok' }));
  assert.doesNotThrow(() => validateStep({ type: 'ai', task: '/work' }));
  assert.doesNotThrow(() => validateStep({ type: 'ai', file: 'desc/x.md' }));
});

test('buildStep: a command step carries the runner axis (M6 — was silently dropped)', () => {
  const cmd = buildStep({ type: 'command', run: 'make build', runner: 'docker:ci' });
  assert.equal(cmd.type, 'command');
  assert.equal(cmd.run, 'make build');
  assert.equal(cmd.runner, 'docker:ci', 'a containerized/remote command must keep its runner (DESIGN §11)');
  // still optional — a plain local command has no runner key
  assert.equal(buildStep({ type: 'command', run: 'ls' }).runner, undefined);
  // ai parity (unchanged)
  assert.equal(buildStep({ type: 'ai', task: '/work', runner: 'ssh:box' }).runner, 'ssh:box');
});

test('nextAction: pending step at cursor is the next action', () => {
  const lane = newLane('main');
  lane.steps = [{ type: 'command', run: 'echo hi', status: 'pending' }];
  const action = nextAction(lane);
  assert.equal(action.kind, 'step');
  assert.equal(action.index, 0);
});

test('nextAction: cursor past end with onEmpty idle -> idle', () => {
  const lane = newLane('main');
  lane.steps = [{ type: 'command', run: 'echo hi', status: 'done' }];
  lane.cursor = 1;
  assert.equal(nextAction(lane).kind, 'idle');
});

test('nextAction: cursor past end with onEmpty default -> synthetic default step', () => {
  const lane = newLane('main', { onEmpty: 'default', default: { type: 'command', run: 'echo default' } });
  lane.steps = [];
  const action = nextAction(lane);
  assert.equal(action.kind, 'default');
  assert.equal(action.step.run, 'echo default');
});

test('nextAction: blocked or failed step at cursor is reported as-is (scheduler decides gating)', () => {
  const lane = newLane('main');
  lane.steps = [{ type: 'manual', message: 'gate', status: 'blocked' }];
  const action = nextAction(lane);
  assert.equal(action.kind, 'step');
  assert.equal(action.step.status, 'blocked');
});

test('loadAllLanesResilient separates healthy lanes from unloadable ones (bug #5)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const good = newLane('good');
  good.steps.push({ type: 'command', run: 'echo hi', status: 'pending' });
  await saveLane(repo, good);
  await writeFile(laneFile(repo, 'bad'), '{ this is not json');

  const { lanes, unloadable } = await loadAllLanesResilient(repo);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].name, 'good');
  assert.equal(unloadable.length, 1);
  assert.equal(unloadable[0].name, 'bad');
  assert.match(unloadable[0].error, /malformed lane JSON/);
});

test('addStep rejects an ai step that resolves NO provider — loud at add time, not a parked lane at fire time (§1/§12)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await assert.rejects(
    addStep(repo, 'ai', { type: 'ai', task: '/work' }),
    (err) => err instanceof LaneValidationError && /provider/.test(err.message) && /park/.test(err.message),
  );
  // provider is an ai-only axis — command/manual steps are unaffected.
  await addStep(repo, 'ai', { type: 'command', task: 'echo ok' });
  await addStep(repo, 'ai', { type: 'manual', message: 'gate' });
});

test('addStep accepts a provider-less ai step when a default is inheritable — incl. the §5 example shape (provider only inside the `default` template)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await writeFile(
    projectConfigFile(repo),
    `${JSON.stringify({ default: { type: 'ai', provider: 'claude', task: '/work' } })}\n`,
  );
  const { step } = await addStep(repo, 'ai', { type: 'ai', task: '/review' });
  assert.equal(step.provider, undefined, 'provider stays late-bound — never materialized into the step');
});

test('forkLane runs the same add-time provider check on its initial step', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'main', { type: 'command', task: 'echo seed' });
  await assert.rejects(
    forkLane(repo, 'kid', 'main', { stepOpts: { type: 'ai', task: '/work' } }),
    LaneValidationError,
  );
  const lane = await forkLane(repo, 'kid', 'main', { stepOpts: { type: 'ai', provider: 'claude', task: '/work' } });
  assert.equal(lane.steps[0].provider, 'claude');
});

test('saveLane writes atomically and leaves no temp file behind (bug #2)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const lane = newLane('main');
  lane.steps.push({ type: 'command', run: 'echo hi', status: 'pending' });
  await saveLane(repo, lane);

  const entries = await readdir(`${repo}/.tasks`);
  assert.ok(entries.includes('main.json'));
  assert.ok(!entries.some((f) => f.includes('.tmp')), 'no .tmp file lingers after an atomic save');

  const reloaded = await loadLane(repo, 'main');
  assert.equal(reloaded.steps[0].run, 'echo hi');
});
