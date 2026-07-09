// M9 — worktree bootstrap: the seed manifest (DESIGN §24). Seeding verbs
// (link/copy/generate), fail-closed manifest validation, the creation-only +
// finish-interrupted-seeding pool semantics, the ignored-file advisory, and
// lane notes (the durable write path for shared working memory).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, rm, mkdir, writeFile, readFile, readlink, unlink,
} from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeRepo, makeGitRepo, gitIn } from './helpers.mjs';
import {
  parseBootstrap, seedWorktree, copyPath, ignoredAdvisory,
} from '../src/bootstrap.mjs';
import { ensureWorktree } from '../src/git.mjs';
import { resolveConfig } from '../src/config.mjs';
import {
  newLane, saveLane, loadLane, ackLane, addStep, noteLane,
} from '../src/tasks.mjs';
import { tick } from '../src/scheduler.mjs';
import { statusData, renderStatus } from '../src/history.mjs';
import { worktreeDir, projectConfigFile, notesFile } from '../src/paths.mjs';

async function makeDirs(t) {
  const main = await mkdtemp(path.join(os.tmpdir(), 'th-boot-main-'));
  const wt = await mkdtemp(path.join(os.tmpdir(), 'th-boot-wt-'));
  t.after(() => rm(main, { recursive: true, force: true }));
  t.after(() => rm(wt, { recursive: true, force: true }));
  return { main, wt };
}

test('parseBootstrap: unknown verbs, non-arrays, unsafe entries all throw loudly; .tasks/ is never seedable (§24 rule 3)', () => {
  assert.equal(parseBootstrap(null), null);
  assert.equal(parseBootstrap(undefined), null);
  const ok = { link: ['.env', 'certs/'], copy: ['PLAN*.md'], generate: ['npm ci'] };
  assert.equal(parseBootstrap(ok), ok);

  assert.throws(() => parseBootstrap(['npm ci']), /must be an object/);
  assert.throws(() => parseBootstrap({ install: ['npm ci'] }), /unknown bootstrap verb/);
  assert.throws(() => parseBootstrap({ link: '.env' }), /must be an array/);
  assert.throws(() => parseBootstrap({ copy: [42] }), /non-empty strings/);
  assert.throws(() => parseBootstrap({ generate: ['  '] }), /non-empty strings/);
  // Path safety: entries become paths under both trees.
  assert.throws(() => parseBootstrap({ link: ['/etc/passwd'] }), /relative path/);
  assert.throws(() => parseBootstrap({ copy: ['../outside.md'] }), /relative path/);
  // The single source of coordination truth is never forked into a worktree.
  assert.throws(() => parseBootstrap({ copy: ['.tasks'] }), /never seed .tasks|must not seed .tasks/);
  assert.throws(() => parseBootstrap({ link: ['.tasks/config.json'] }), /must not seed .tasks/);
  // Globs: copy-only, final segment only.
  assert.throws(() => parseBootstrap({ link: ['*.env'] }), /globs are only supported/);
  assert.throws(() => parseBootstrap({ copy: ['docs/*/notes.md'] }), /final path segment/);
});

test('seedWorktree: link symlinks live to the main checkout, copy snapshots via glob and diverges, generate runs serially with cwd = the tree', async (t) => {
  const { main, wt } = await makeDirs(t);
  await writeFile(path.join(main, '.env'), 'SECRET=1\n');
  await mkdir(path.join(main, 'certs'));
  await writeFile(path.join(main, 'certs', 'dev.pem'), 'PEM\n');
  await writeFile(path.join(main, 'PLAN.md'), 'plan\n');
  await writeFile(path.join(main, 'PLAN-rules.md'), 'rules\n');
  await writeFile(path.join(main, 'UNRELATED.md'), 'no\n');

  const report = await seedWorktree(main, wt, {
    link: ['.env', 'certs/'],
    copy: ['PLAN*.md'],
    generate: ['echo one >> gen.txt', 'echo two >> gen.txt'],
  }, { log: () => {} });

  // link: a live symlink — an edit in the main checkout is visible in the tree.
  assert.deepEqual(report.linked, ['.env', 'certs']);
  assert.ok(lstatSync(path.join(wt, '.env')).isSymbolicLink());
  assert.equal(await readlink(path.join(wt, '.env')), path.join(main, '.env'));
  await writeFile(path.join(main, '.env'), 'SECRET=2\n');
  assert.equal(await readFile(path.join(wt, '.env'), 'utf8'), 'SECRET=2\n');
  assert.equal(await readFile(path.join(wt, 'certs', 'dev.pem'), 'utf8'), 'PEM\n');

  // copy: the glob matched both PLAN files and nothing else; the snapshot
  // diverges by design — an edit in the tree never reaches the main checkout.
  assert.deepEqual(report.copied, ['PLAN-rules.md', 'PLAN.md']);
  assert.ok(!existsSync(path.join(wt, 'UNRELATED.md')));
  await writeFile(path.join(wt, 'PLAN.md'), 'diverged\n');
  assert.equal(await readFile(path.join(main, 'PLAN.md'), 'utf8'), 'plan\n');

  // generate: serial, in order, in the tree (not the main checkout).
  assert.deepEqual(report.generated, ['echo one >> gen.txt', 'echo two >> gen.txt']);
  assert.equal(await readFile(path.join(wt, 'gen.txt'), 'utf8'), 'one\ntwo\n');
  assert.ok(!existsSync(path.join(main, 'gen.txt')));
  assert.deepEqual(report.warnings, []);
});

test('seedWorktree: missing sources warn loudly and continue; existing targets are never clobbered (§24 rule 1)', async (t) => {
  const { main, wt } = await makeDirs(t);
  await writeFile(path.join(main, 'PLAN.md'), 'theirs\n');
  await writeFile(path.join(wt, 'PLAN.md'), 'mine\n'); // pre-existing in the tree

  const warnings = [];
  const report = await seedWorktree(main, wt, {
    link: ['.env'], // absent from main
    copy: ['nope*.md', 'PLAN.md'],
  }, { log: (m) => warnings.push(m) });

  assert.deepEqual(report.linked, []);
  assert.deepEqual(report.copied, []);
  assert.ok(warnings.some((w) => /WARNING bootstrap link source \.env missing/.test(w)));
  assert.ok(warnings.some((w) => /WARNING bootstrap copy source nope\*\.md matched nothing/.test(w)));
  assert.ok(warnings.some((w) => /WARNING bootstrap copy target PLAN\.md already exists/.test(w)));
  assert.equal(await readFile(path.join(wt, 'PLAN.md'), 'utf8'), 'mine\n', 'never clobbered');
});

test('copyPath: a failed reflink attempt falls back to a plain recursive copy', async (t) => {
  const { main, wt } = await makeDirs(t);
  await mkdir(path.join(main, 'deps', 'pkg'), { recursive: true });
  await writeFile(path.join(main, 'deps', 'pkg', 'index.js'), 'x\n');
  // `false` exits 1 → the reflink attempt fails → fs.cp fallback must land it.
  await copyPath(path.join(main, 'deps'), path.join(wt, 'deps'), ['false']);
  assert.equal(await readFile(path.join(wt, 'deps', 'pkg', 'index.js'), 'utf8'), 'x\n');
});

test('seedWorktree: a failed generate throws loudly with the exit code and stderr (setup-error discipline)', async (t) => {
  const { main, wt } = await makeDirs(t);
  await assert.rejects(
    () => seedWorktree(main, wt, { generate: ['echo boom >&2; exit 7'] }, { log: () => {} }),
    (err) => /bootstrap generate .* failed/.test(err.message)
      && /exit 7/.test(err.message)
      && /boom/.test(err.message),
  );
});

test('ensureWorktree: creation seeds; a pool hit never re-seeds (§24 rule 2)', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await writeFile(path.join(repo, '.gitignore'), '.env\n');
  await gitIn(repo, 'add', '.gitignore');
  await gitIn(repo, 'commit', '-m', 'ignore env');
  await writeFile(path.join(repo, '.env'), 'KEY=v\n');

  const wt = await ensureWorktree(repo, 'seeded', 'main', { bootstrap: { link: ['.env'] } });
  assert.ok(lstatSync(path.join(wt, '.env')).isSymbolicLink(), 'creation seeded the tree');

  // Seeding belongs to creation: a deliberately removed seed is not re-applied
  // on the next fire (gc + recreate is the re-seed path).
  await unlink(path.join(wt, '.env'));
  const again = await ensureWorktree(repo, 'seeded', 'main', { bootstrap: { link: ['.env'] } });
  assert.equal(again, wt);
  assert.ok(!existsSync(path.join(wt, '.env')), 'pool hit does not re-seed');

  // A malformed manifest fails closed BEFORE any git op.
  await assert.rejects(
    () => ensureWorktree(repo, 'other', 'main', { bootstrap: { install: ['x'] } }),
    /unknown bootstrap verb/,
  );
  assert.ok(!existsSync(worktreeDir(repo, 'other')), 'no unseeded pool tree left behind');
});

test('a failed generate parks the lane as a setup error; the retried fire finishes seeding instead of running half-seeded', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  const cfg = JSON.parse(await readFile(projectConfigFile(repo), 'utf8'));
  cfg.bootstrap = { generate: ['echo boom >&2; exit 7'] };
  await writeFile(projectConfigFile(repo), JSON.stringify(cfg, null, 2));
  await saveLane(repo, newLane('feat', { steps: [{ type: 'command', run: 'test -f seeded.txt', status: 'pending' }] }));

  const first = await tick(repo);
  assert.equal(first.result, 'failed');
  let lane = await loadLane(repo, 'feat');
  assert.equal(lane.status, 'blocked', 'setup error parks on the FIRST failure');
  assert.match(lane.steps[0].parkedReason, /could not start/);
  assert.match(lane.steps[0].parkedReason, /generate/);
  assert.match(lane.steps[0].parkedReason, /boom/);
  const wt = worktreeDir(repo, 'feat');
  assert.ok(existsSync(path.join(wt, '.git')), 'the worktree exists but is half-seeded');

  // Fix the manifest, ack the parked failure: the pool hit must FINISH the
  // interrupted seeding (never run a half-seeded tree silently), then run.
  cfg.bootstrap = { generate: ['echo ok > seeded.txt'] };
  await writeFile(projectConfigFile(repo), JSON.stringify(cfg, null, 2));
  await ackLane(repo, 'feat');
  const second = await tick(repo);
  assert.equal(second.result, 'done', 'step sees the completed seeding');
  lane = await loadLane(repo, 'feat');
  assert.equal(lane.cursor, 1);
  assert.equal((await readFile(path.join(wt, 'seeded.txt'), 'utf8')).trim(), 'ok');
});

test('ignoredAdvisory: lists top-level gitignored entries the tree lacks, one loud line naming the manifest; .tasks/ excluded', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await writeFile(path.join(repo, '.gitignore'), '.env\nnode_modules/\n.tasks/\n');
  await gitIn(repo, 'add', '.gitignore');
  await gitIn(repo, 'commit', '-m', 'ignores');
  await writeFile(path.join(repo, '.env'), 'KEY=v\n');
  await mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(repo, 'node_modules', 'pkg', 'i.js'), 'x\n');

  const wt = await ensureWorktree(repo, 'bare', 'main'); // no manifest
  const logs = [];
  const missing = await ignoredAdvisory(repo, wt, { log: (m) => logs.push(m) });
  assert.deepEqual(missing.sort(), ['.env', 'node_modules']);
  assert.equal(logs.length, 1, 'ONE warning, not one per file');
  assert.match(logs[0], /bootstrap manifest/);
  assert.match(logs[0], /\.env/);
  assert.ok(!missing.includes('.tasks'), '.tasks/ is never advised — it is never seeded (§24 rule 3)');

  // Nothing missing → silent (advisory only fires when actionable).
  await writeFile(path.join(wt, '.env'), 'KEY=v\n');
  await mkdir(path.join(wt, 'node_modules'), { recursive: true });
  const quiet = [];
  assert.deepEqual(await ignoredAdvisory(repo, wt, { log: (m) => quiet.push(m) }), []);
  assert.equal(quiet.length, 0);
});

test('bootstrap manifest resolution: lane-level REPLACES project-level wholly (§5/§24) — never a half-merged recipe', () => {
  const project = { bootstrap: { link: ['.env'], generate: ['npm ci'] } };
  const lane = { bootstrap: { copy: ['DATA.md'] } };
  assert.deepEqual(resolveConfig(null, lane, project, {}).bootstrap, { copy: ['DATA.md'] });
  assert.deepEqual(resolveConfig(null, {}, project, {}).bootstrap, project.bootstrap);
  assert.equal(resolveConfig(null, {}, {}, {}).bootstrap, undefined);
});

test('noteLane: append-only timestamped entries; bad lane names and empty text refused; status surfaces the notes path', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'research', { type: 'command', task: 'true' });

  await noteLane(repo, 'research', 'first finding');
  await noteLane(repo, 'research', 'second finding\nwith detail');
  const notes = await readFile(notesFile(repo, 'research'), 'utf8');
  assert.equal((notes.match(/^## \d{4}-/gm) || []).length, 2, 'one timestamped header per entry');
  assert.ok(notes.indexOf('first finding') < notes.indexOf('second finding'), 'append-only');

  await assert.rejects(() => noteLane(repo, '../evil', 'x'), /invalid lane name/);
  assert.ok(!existsSync(path.join(repo, '.tasks', 'notes', '..', 'evil.md')));
  await assert.rejects(() => noteLane(repo, 'research', '   '), /non-empty text/);

  const { lanes } = await statusData(repo);
  assert.equal(lanes[0].notes, path.join('.tasks', 'notes', 'research.md'));
  assert.match(await renderStatus(repo), /notes: \.tasks\/notes\/research\.md/);
});
