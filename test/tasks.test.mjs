import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir } from 'node:fs/promises';
import {
  newLane, saveLane, loadLane, nextAction, validateStep, LaneValidationError,
  loadAllLanesResilient, buildStep, ackLane, removeStep, forkLane,
} from '../src/tasks.mjs';
import { laneFile } from '../src/paths.mjs';
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
