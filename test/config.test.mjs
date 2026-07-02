import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.mjs';

test('resolveConfig: step overrides lane overrides project overrides user', () => {
  const step = { model: 'opus' };
  const lane = { model: 'sonnet', profile: 'work' };
  const project = { profile: 'personal', runner: 'local' };
  const user = { runner: 'local', timeout: '45m' };
  const resolved = resolveConfig(step, lane, project, user);
  assert.equal(resolved.model, 'opus', 'step wins over lane/project/user');
  assert.equal(resolved.profile, 'work', 'lane wins over project/user');
  assert.equal(resolved.runner, 'local', 'project wins over user');
  assert.equal(resolved.timeout, '45m', 'falls back to user when nothing more specific sets it');
});

test('resolveConfig: object-valued keys (budget) merge shallowly instead of replacing wholesale', () => {
  const step = { budget: { usd: 2 } };
  const lane = {};
  const project = { budget: { usd: 5, perRun: true } };
  const user = {};
  const resolved = resolveConfig(step, lane, project, user);
  assert.equal(resolved.budget.usd, 2, 'step-level usd wins');
  assert.equal(resolved.budget.perRun, true, 'project-level perRun survives the merge');
});

test('resolveConfig: omits keys nobody set', () => {
  const resolved = resolveConfig({}, {}, {}, {});
  assert.deepEqual(resolved, {});
});
