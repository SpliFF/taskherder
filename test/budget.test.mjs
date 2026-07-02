import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sumSpend, startOfDay, checkDailyBudget, checkCumulativeBudget, checkPerRunBudget,
} from '../src/budget.mjs';

const history = [
  { ts: '2026-07-01T10:00:00.000Z', lane: 'work', cost: 0.02 },
  { ts: '2026-07-02T09:00:00.000Z', lane: 'work', cost: 0.03 },
  { ts: '2026-07-02T11:00:00.000Z', lane: 'other', cost: 0.5 },
  { ts: '2026-07-02T12:00:00.000Z', lane: 'work' }, // no cost (e.g. a command step)
];

test('sumSpend: totals a lane, optionally since a timestamp', () => {
  assert.equal(sumSpend(history, { lane: 'work' }), 0.05);
  assert.equal(sumSpend(history, { lane: 'work', since: startOfDay('2026-07-02T12:00:00.000Z') }), 0.03);
  assert.equal(sumSpend(history, {}), 0.55, 'no lane filter sums everything');
});

test('checkDailyBudget: over today\'s cap returns a reason, under is null (soft)', () => {
  const now = '2026-07-02T15:00:00.000Z';
  assert.match(checkDailyBudget({ usdPerDay: 0.02 }, history, 'work', now), /over daily budget/);
  assert.equal(checkDailyBudget({ usdPerDay: 0.10 }, history, 'work', now), null);
  assert.equal(checkDailyBudget({}, history, 'work', now), null, 'no usdPerDay -> never daily-blocks');
});

test('checkCumulativeBudget: lifetime spend at/over the cap gates; perRun budgets are skipped here', () => {
  assert.match(checkCumulativeBudget({ usd: 0.05 }, history, 'work'), /budget exhausted/);
  assert.equal(checkCumulativeBudget({ usd: 0.10 }, history, 'work'), null);
  assert.equal(checkCumulativeBudget({ usd: 0.01, perRun: true }, history, 'work'), null, 'perRun is a post-run check');
});

test('checkPerRunBudget: a single run over its per-run ceiling is flagged', () => {
  assert.match(checkPerRunBudget({ usd: 0.01, perRun: true }, 0.02), /exceeded per-run budget/);
  assert.equal(checkPerRunBudget({ usd: 0.05, perRun: true }, 0.02), null);
  assert.equal(checkPerRunBudget({ usd: 0.01 }, 0.02), null, 'non-perRun budgets are not per-run checks');
  assert.equal(checkPerRunBudget({ usd: 0.01, perRun: true }, null), null, 'no cost -> nothing to check');
});
