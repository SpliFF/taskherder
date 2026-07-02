// M3 — git isolation (DESIGN §7): worktree/inplace/none, taskherd/<lane>
// branches, land policies, the worktree pool + gc — plus the DESIGN §6
// default/onEmpty fallbacks that were deferred from M2 into M3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { makeRepo, makeGitRepo, gitIn } from './helpers.mjs';
import { tick } from '../src/scheduler.mjs';
import {
  newLane, saveLane, loadLane, ackLane, nextAction, defaultFallback,
} from '../src/tasks.mjs';
import { gcWorktrees } from '../src/git.mjs';
import { worktreeDir, projectConfigFile, laneFile } from '../src/paths.mjs';
import { readHistory } from '../src/history.mjs';

function commandStep(run) {
  return { type: 'command', run, status: 'pending' };
}

const COMMIT_A = 'echo A > a.txt && git add a.txt && git commit -m feat-a';
const COMMIT_B = 'echo B > b.txt && git add b.txt && git commit -m feat-b';

test('init scaffolds isolation worktree in a git repo, none elsewhere (DESIGN §7 default)', async (t) => {
  const g = await makeGitRepo();
  t.after(g.cleanup);
  const gitCfg = JSON.parse(await readFile(projectConfigFile(g.repo), 'utf8'));
  assert.equal(gitCfg.isolation, 'worktree');

  const plain = await makeRepo();
  t.after(plain.cleanup);
  const plainCfg = JSON.parse(await readFile(projectConfigFile(plain.repo), 'utf8'));
  assert.equal(plainCfg.isolation, 'none');
});

test('worktree isolation: steps run in the pool worktree on taskherd/<lane>; main checkout untouched', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await saveLane(repo, newLane('feat', {
    steps: [
      commandStep('git rev-parse --abbrev-ref HEAD > branch.txt'),
      commandStep('test -f branch.txt'), // second fire reuses the SAME worktree (the pool)
    ],
  }));

  const first = await tick(repo);
  assert.equal(first.outcome, 'ran');
  const wt = worktreeDir(repo, 'feat');
  assert.ok(existsSync(wt), 'worktree exists under ~/.taskherd/wt');
  assert.equal((await readFile(path.join(wt, 'branch.txt'), 'utf8')).trim(), 'taskherd/feat');
  assert.ok(!existsSync(path.join(repo, 'branch.txt')), 'main checkout untouched');
  assert.equal(await gitIn(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');

  const second = await tick(repo);
  assert.equal(second.result, 'done', 'pool reuse: step 2 sees step 1 output');
  const lane = await loadLane(repo, 'feat');
  assert.equal(lane.cursor, 2);
});

test('exit criterion: two lanes edit code in parallel worktrees; land via gate', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await saveLane(repo, newLane('a', { steps: [commandStep(COMMIT_A)] }));
  await saveLane(repo, newLane('b', { steps: [commandStep(COMMIT_B)] }));

  assert.equal((await tick(repo)).outcome, 'ran');
  assert.equal((await tick(repo)).outcome, 'ran');

  // Both lanes hold their edits in their own worktrees; main has neither.
  assert.ok(existsSync(path.join(worktreeDir(repo, 'a'), 'a.txt')));
  assert.ok(existsSync(path.join(worktreeDir(repo, 'b'), 'b.txt')));
  assert.ok(!existsSync(path.join(repo, 'a.txt')));
  assert.ok(!existsSync(path.join(repo, 'b.txt')));

  // Completion appended a land gate carrying branch+base (DESIGN §7).
  const laneA = await loadLane(repo, 'a');
  assert.equal(laneA.status, 'blocked');
  assert.equal(laneA.steps.length, 2);
  assert.deepEqual(laneA.steps[1].land, { branch: 'taskherd/a', base: 'main' });
  assert.match(laneA.steps[1].message, /ahead of main/);

  // The run's resulting commit is in the audit trail (DESIGN §6).
  const history = await readHistory(repo);
  assert.ok(history.some((h) => h.lane === 'a' && h.commit), 'history carries the commit');

  // ack = approve the land -> merge into base; no re-gate (branch no longer ahead).
  const acked = await ackLane(repo, 'a');
  assert.equal(acked.kind, 'land');
  assert.ok(existsSync(path.join(repo, 'a.txt')), 'merged into the main checkout');
  const log = await gitIn(repo, 'log', '--oneline', 'main');
  assert.match(log, /feat-a/);
  assert.match(log, /taskherd: land taskherd\/a/);
  const after = await loadLane(repo, 'a');
  assert.equal(after.status, 'idle');
  assert.equal(after.cursor, 2);
  assert.equal(after.steps.length, 2, 'no second land gate after the merge');

  // b is untouched by a's land.
  assert.ok(!existsSync(path.join(repo, 'b.txt')));
});

test('land "leave" leaves branch + worktree alone; no gate', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await saveLane(repo, newLane('lv', { land: 'leave', steps: [commandStep(COMMIT_A)] }));
  await tick(repo);
  const lane = await loadLane(repo, 'lv');
  assert.equal(lane.steps.length, 1, 'no land gate appended');
  assert.equal(lane.status, 'idle');
  assert.equal(Number(await gitIn(repo, 'rev-list', '--count', 'main..taskherd/lv')), 1);
});

test('inplace isolation: the main checkout switches to taskherd/<lane>', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await saveLane(repo, newLane('hot', {
    isolation: 'inplace',
    steps: [commandStep('echo live > inplace.txt')],
  }));
  const result = await tick(repo);
  assert.equal(result.result, 'done');
  assert.equal(await gitIn(repo, 'symbolic-ref', '--short', 'HEAD'), 'taskherd/hot');
  assert.ok(existsSync(path.join(repo, 'inplace.txt')), 'ran in the main checkout');
  // The recorded fork point survives the checkout switch (land-time base).
  assert.equal(await gitIn(repo, 'config', 'branch.taskherd/hot.taskherdbase'), 'main');
});

test('git isolation on a non-git repo parks the lane loudly (setup error, no retry)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await saveLane(repo, newLane('x', {
    isolation: 'worktree',
    steps: [commandStep('echo never')],
  }));
  const result = await tick(repo);
  assert.equal(result.result, 'failed');
  const lane = await loadLane(repo, 'x');
  assert.equal(lane.status, 'blocked');
  assert.equal(lane.steps[0].status, 'failed');
  assert.match(lane.steps[0].parkedReason, /not a git repository/);
});

test('gc: removes merged worktrees (+branch), keeps unmerged and dirty ones — and says why', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await saveLane(repo, newLane('a', { steps: [commandStep(COMMIT_A)] }));
  await saveLane(repo, newLane('b', { steps: [commandStep(COMMIT_B)] }));
  await saveLane(repo, newLane('c', { steps: [commandStep('echo dirty > c.txt')] }));
  await tick(repo);
  await tick(repo);
  await tick(repo);
  await ackLane(repo, 'a'); // land a -> merged into main

  const report = await gcWorktrees(repo);
  const byLane = Object.fromEntries(report.map((r) => [r.lane, r]));
  assert.equal(byLane.a.action, 'removed');
  assert.equal(byLane.b.action, 'kept');
  assert.match(byLane.b.reason, /unmerged/);
  assert.equal(byLane.c.action, 'kept');
  assert.match(byLane.c.reason, /uncommitted/);

  assert.ok(!existsSync(worktreeDir(repo, 'a')));
  assert.ok(existsSync(worktreeDir(repo, 'b')));
  assert.ok(existsSync(worktreeDir(repo, 'c')));
  assert.equal(await gitIn(repo, 'branch', '--list', 'taskherd/a'), '', 'merged branch deleted');
  assert.notEqual(await gitIn(repo, 'branch', '--list', 'taskherd/b'), '', 'unmerged branch kept');
});

test('zero-config fallback (DESIGN §6): no lanes at all -> the configured default runs, nothing persisted', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const marker = path.join(repo, 'default-ran.txt');
  await writeFile(projectConfigFile(repo), JSON.stringify({
    isolation: 'none',
    default: { type: 'command', run: `touch ${marker}`, onEmpty: 'default' },
  }));
  const result = await tick(repo);
  assert.equal(result.outcome, 'ran');
  assert.equal(result.lane, 'default');
  assert.ok(existsSync(marker));
  assert.ok(!existsSync(laneFile(repo, 'default')), 'synthetic: no lane file created');
  const history = await readHistory(repo);
  assert.equal(history[0].lane, 'default');
  assert.equal(history[0].kind, 'default');
});

test('project-level default/onEmpty fallback (DESIGN §6): an empty lane runs the project default', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const marker = path.join(repo, 'lane-default-ran.txt');
  await writeFile(projectConfigFile(repo), JSON.stringify({
    isolation: 'none',
    onEmpty: 'default',
    default: { type: 'command', run: `touch ${marker}` },
  }));
  await saveLane(repo, newLane('web')); // no steps, no own default/onEmpty
  const result = await tick(repo);
  assert.equal(result.outcome, 'ran');
  assert.equal(result.lane, 'web');
  assert.ok(existsSync(marker));
  const lane = await loadLane(repo, 'web');
  assert.ok(lane.lastRun > 0, 'fair-pick rotation still advances');
});

test('nextAction fallback unit: lane-level values win; the config onEmpty marker is stripped', () => {
  const fallback = defaultFallback(
    { default: { type: 'command', run: 'echo d', onEmpty: 'default' } },
    {},
  );
  const action = nextAction(newLane('x'), fallback);
  assert.equal(action.kind, 'default');
  assert.equal(action.step.run, 'echo d');
  assert.equal(action.step.onEmpty, undefined);
  assert.equal(nextAction(newLane('y', { onEmpty: 'idle' }), fallback).kind, 'idle');
});
