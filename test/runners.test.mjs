import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveRunner, wrapForRunner, shquote, loadRunners,
} from '../src/runners.mjs';

// A minimal inner invocation (what a provider/shell step rendered).
const INNER = { file: 'claude', args: ['-p', 'hi there'] };

test('resolveRunner: local / inline docker: / inline ssh: shorthands', async () => {
  assert.deepEqual(await resolveRunner(null), { kind: 'local' });
  assert.deepEqual(await resolveRunner('local'), { kind: 'local' });
  assert.deepEqual(await resolveRunner('docker:web'), { kind: 'docker', container: 'web', name: 'docker:web' });
  assert.deepEqual(await resolveRunner('ssh:user@box'), { kind: 'ssh', host: 'user@box', name: 'ssh:user@box' });
});

test('resolveRunner: an unknown runner name / kind fails loudly (parks, never silent-local)', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'th-run-'));
  const prev = process.env.TASKHERD_HOME;
  process.env.TASKHERD_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.TASKHERD_HOME; else process.env.TASKHERD_HOME = prev;
    return rm(home, { recursive: true, force: true });
  });
  await assert.rejects(() => resolveRunner('nope'), /unknown runner/);
  await assert.rejects(() => resolveRunner('podman:box'), /unknown runner kind/);
  await writeFile(path.join(home, 'runners.json'), JSON.stringify({ bad: { image: 'x' } }));
  await assert.rejects(() => resolveRunner('bad'), /needs "kind"/);
});

test('resolveRunner: a named runner resolves from ~/.taskherd/runners.json', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'th-run-'));
  const prev = process.env.TASKHERD_HOME;
  process.env.TASKHERD_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.TASKHERD_HOME; else process.env.TASKHERD_HOME = prev;
    return rm(home, { recursive: true, force: true });
  });
  await writeFile(path.join(home, 'runners.json'), JSON.stringify({
    sandbox: { kind: 'docker', image: 'taskherder/agent', mounts: ['{worktree}:/work'], workdir: '/work' },
  }));
  const r = await resolveRunner('sandbox');
  assert.equal(r.kind, 'docker');
  assert.equal(r.image, 'taskherder/agent');
  assert.equal(r.name, 'sandbox');
  assert.deepEqual(Object.keys(await loadRunners()), ['sandbox']);
});

test('wrapForRunner(local): pass-through argv; profile + taskherd env merged onto process.env', () => {
  const w = wrapForRunner({ kind: 'local' }, {
    ...INNER, extraEnv: { ANTHROPIC_API_KEY: 'sk-secret' }, cwd: '/wt', taskherdEnv: { TASKHERD_LANE: 'main' },
  });
  assert.equal(w.file, 'claude');
  assert.deepEqual(w.args, ['-p', 'hi there']);
  assert.equal(w.cwd, '/wt');
  assert.equal(w.env.ANTHROPIC_API_KEY, 'sk-secret');
  assert.equal(w.env.TASKHERD_LANE, 'main');
  assert.equal(w.env.PATH, process.env.PATH, 'inherits ambient env');
  assert.deepEqual(w.warnings, []);
});

test('wrapForRunner(docker exec): wraps into `docker exec`, forwards auth by NAME not value (no argv leak)', () => {
  const w = wrapForRunner({ kind: 'docker', container: 'web', name: 'docker:web' }, {
    ...INNER, extraEnv: { ANTHROPIC_API_KEY: 'sk-secret' }, cwd: '/wt', repo: '/repo',
  });
  assert.equal(w.file, 'docker');
  assert.equal(w.args[0], 'exec');
  // the container name precedes the inner command
  const ci = w.args.indexOf('web');
  assert.ok(ci !== -1 && w.args[ci + 1] === 'claude' && w.args[ci + 2] === '-p', 'inner argv follows the container');
  // -e KEY is present by NAME; the secret VALUE never appears on the argv
  assert.ok(w.args.includes('-e') && w.args.includes('ANTHROPIC_API_KEY'), 'forwards env var by name');
  assert.ok(!w.args.some((a) => a.includes('sk-secret')), 'secret value is NOT on the command line (events.jsonl/log)');
  // ...it travels via the local docker client env instead, for `-e KEY` passthrough
  assert.equal(w.env.ANTHROPIC_API_KEY, 'sk-secret');
});

test('wrapForRunner(docker run): image + templated bind-mount + workdir', () => {
  const w = wrapForRunner(
    {
      kind: 'docker', image: 'alpine', mounts: ['{worktree}:/work'], workdir: '/work', name: 'sandbox',
    },
    {
      ...INNER, cwd: '/home/u/.taskherd/wt/repo/main', worktree: '/home/u/.taskherd/wt/repo/main', repo: '/repo',
    },
  );
  assert.deepEqual(w.args.slice(0, 3), ['run', '--rm', '-i']);
  const vi = w.args.indexOf('-v');
  assert.equal(w.args[vi + 1], '/home/u/.taskherd/wt/repo/main:/work', '{worktree} substituted into the mount');
  assert.ok(w.args.includes('-w') && w.args.includes('/work'));
  const ii = w.args.indexOf('alpine');
  assert.deepEqual(w.args.slice(ii + 1), ['claude', '-p', 'hi there'], 'inner argv trails the image');
});

test('wrapForRunner(ssh): builds a shell-quoted remote command; profile env is NOT forwarded (warns)', () => {
  const w = wrapForRunner({ kind: 'ssh', host: 'user@box', name: 'ssh:user@box', cwd: '/srv/{lane}' }, {
    ...INNER, extraEnv: { ANTHROPIC_API_KEY: 'sk-secret' }, laneName: 'main', repo: '/repo',
  });
  assert.equal(w.file, 'ssh');
  assert.deepEqual(w.args.slice(0, 2), ['-tt', 'user@box']);
  const remote = w.args[2];
  assert.match(remote, /^cd '\/srv\/main' &&/, '{lane} templated into the remote cwd, shell-quoted');
  assert.match(remote, /exec 'claude' '-p' 'hi there'/, 'inner argv single-quoted for the remote shell');
  assert.ok(!w.args.some((a) => a.includes('sk-secret')), 'ssh does not forward the profile secret');
  assert.ok(w.warnings.some((m) => /NOT forwarded over the ssh runner/.test(m)), 'the dropped auth is flagged, not silent');
});

test('wrapForRunner(ssh): no cwd → runs in the login dir with a loud unsynced-worktree warning', () => {
  const w = wrapForRunner({ kind: 'ssh', host: 'box', name: 'ssh:box' }, { ...INNER, repo: '/repo' });
  assert.equal(w.args[2], "exec 'claude' '-p' 'hi there'", 'no cd prefix when there is no remote cwd');
  assert.ok(w.warnings.some((m) => /host worktree is NOT synced/.test(m)));
});

test('wrapForRunner: an ai step on a non-local runner warns that taskherd-mcp is unreachable (§11 gap)', () => {
  const local = wrapForRunner({ kind: 'local' }, { ...INNER, isAi: true });
  assert.deepEqual(local.warnings, [], 'local ai keeps its mcp tools');
  const docker = wrapForRunner({ kind: 'docker', container: 'web', name: 'docker:web' }, { ...INNER, isAi: true, repo: '/repo' });
  assert.ok(docker.warnings.some((m) => /FIDELITY-STANDIN.*taskherd-mcp/.test(m)), 'the missing finalization tools are flagged loudly');
});

test('wrapForRunner(docker): a def with neither container nor image is a loud setup error', () => {
  assert.throws(
    () => wrapForRunner({ kind: 'docker', name: 'broken' }, { ...INNER, repo: '/repo' }),
    /needs a "container" or an "image"/,
  );
});

test('shquote: wraps and escapes embedded single quotes the POSIX way', () => {
  assert.equal(shquote('plain'), "'plain'");
  assert.equal(shquote("a'b"), "'a'\\''b'");
  assert.equal(shquote('a b; rm -rf /'), "'a b; rm -rf /'", 'metacharacters are inert inside single quotes');
});
