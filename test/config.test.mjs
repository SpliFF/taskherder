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

test('resolveConfig: provider falls back to the `default` step template (lane → project → user) when the chain sets none', () => {
  const project = { default: { type: 'ai', provider: 'claude', task: '/work' } };
  assert.equal(resolveConfig({}, {}, project, {}).provider, 'claude', 'the §5 example config shape resolves');
  const lane = { default: { type: 'ai', provider: 'codex', task: '/work' } };
  assert.equal(resolveConfig({}, lane, project, {}).provider, 'codex', 'lane template beats project template');
  const user = { default: { type: 'ai', provider: 'copilot', task: '/work' } };
  assert.equal(resolveConfig({}, {}, {}, user).provider, 'copilot', 'user template is the last resort');
});

test('resolveConfig: an explicit provider anywhere in the chain beats every default template, and other template fields never leak', () => {
  const lane = { default: { type: 'ai', provider: 'codex', task: '/work' } };
  assert.equal(resolveConfig({}, lane, {}, { provider: 'claude' }).provider, 'claude', 'top-level chain wins over templates');
  assert.equal(resolveConfig({ provider: 'copilot' }, lane, {}, {}).provider, 'copilot', 'step wins outright');
  const project = { default: { type: 'ai', provider: 'claude', model: 'sonnet', task: '/work' } };
  const r = resolveConfig({}, {}, project, {});
  assert.equal(r.model, undefined, "a template's model/task are its own — only provider backfills");
});
