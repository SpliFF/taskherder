import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newLane, saveLane, loadLane, nextAction, validateStep, LaneValidationError,
} from '../src/tasks.mjs';
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

test('validateStep rejects unknown types and missing required fields', () => {
  assert.throws(() => validateStep({ type: 'ai', task: '/work' }), LaneValidationError);
  assert.throws(() => validateStep({ type: 'command' }), LaneValidationError);
  assert.throws(() => validateStep({ type: 'manual' }), LaneValidationError);
  assert.doesNotThrow(() => validateStep({ type: 'command', run: 'echo hi' }));
  assert.doesNotThrow(() => validateStep({ type: 'manual', message: 'ok' }));
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
