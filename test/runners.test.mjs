import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveRunner, wrapForRunner, shquote, loadRunners, shellInvocation, graphicalEndpoint,
} from '../src/runners.mjs';

// A minimal inner invocation (what a provider/shell step rendered).
const INNER = { file: 'claude', args: ['-p', 'hi there'] };

test('resolveRunner: local / inline docker: / inline ssh: shorthands', async () => {
  assert.deepEqual(await resolveRunner(null), { kind: 'local' });
  assert.deepEqual(await resolveRunner('local'), { kind: 'local' });
  assert.deepEqual(await resolveRunner('docker:web'), { kind: 'docker', container: 'web', name: 'docker:web' });
  assert.deepEqual(await resolveRunner('ssh:user@box'), { kind: 'ssh', host: 'user@box', name: 'ssh:user@box' });
});

test('resolveRunner: rejects argv option-injection targets, allows internal dashes (§12)', async () => {
  // A leading-dash target is parsed by ssh/docker as an OPTION — `ssh:-oProxyCommand=…`
  // is arbitrary host RCE. Reject it (and any whitespace); never silently pass it through.
  await assert.rejects(() => resolveRunner('ssh:-oProxyCommand=touch /tmp/pwn'), /must not start with '-'/);
  await assert.rejects(() => resolveRunner('docker:-v/etc:/host'), /must not start with '-'/);
  await assert.rejects(() => resolveRunner('ssh:has space'), /whitespace/);
  // Legitimate hosts/containers with INTERNAL dashes still resolve.
  assert.deepEqual(await resolveRunner('ssh:web-01.example.com'), { kind: 'ssh', host: 'web-01.example.com', name: 'ssh:web-01.example.com' });
  assert.deepEqual(await resolveRunner('docker:my-container'), { kind: 'docker', container: 'my-container', name: 'docker:my-container' });
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

test('wrapForRunner: tty:false drops docker -t / ssh -tt (a §23 probe has no pty behind it)', () => {
  const dockerTty = wrapForRunner({ kind: 'docker', container: 'web' }, { ...INNER, repo: '/repo' });
  assert.ok(dockerTty.args.includes('-t'), 'default stays interactive for the pty seam');
  const dockerNo = wrapForRunner({ kind: 'docker', container: 'web' }, { ...INNER, repo: '/repo', tty: false });
  assert.ok(!dockerNo.args.includes('-t'), 'docker refuses -t without a terminal on stdin');
  assert.ok(dockerNo.args.includes('-i'), 'stdin stays open');
  const sshNo = wrapForRunner({ kind: 'ssh', host: 'box' }, { ...INNER, repo: '/repo', tty: false });
  assert.ok(!sshNo.args.includes('-tt'), 'no forced remote pty for a probe');
  assert.equal(sshNo.args[0], 'box');
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

// ── shellInvocation (web-SSH, DESIGN §15 L2) ──────────────────────────────

test('shellInvocation(local): runs the host $SHELL as a bare interactive shell in cwd', () => {
  const prev = process.env.SHELL;
  process.env.SHELL = '/bin/zsh';
  try {
    const s = shellInvocation({ kind: 'local' }, { cwd: '/repo' });
    assert.equal(s.file, '/bin/zsh');
    assert.deepEqual(s.args, [], 'no command — an interactive shell, not a one-shot');
    assert.equal(s.cwd, '/repo');
    assert.equal(s.env.PATH, process.env.PATH, 'inherits ambient env');
    assert.equal(s.label, 'local');
  } finally {
    if (prev === undefined) delete process.env.SHELL; else process.env.SHELL = prev;
  }
});

test('shellInvocation(docker exec): opens a shell inside the container, no auth env crosses', () => {
  const s = shellInvocation({ kind: 'docker', container: 'web', name: 'docker:web' }, { cwd: '/repo' });
  assert.equal(s.file, 'docker');
  assert.deepEqual(s.args, ['exec', '-i', '-t', 'web', '/bin/sh'], 'docker exec into the container running /bin/sh');
  assert.ok(!s.args.includes('-e'), 'no profile secrets forwarded to a web shell');
  assert.equal(s.label, 'docker:web');
});

test('shellInvocation(ssh): a -tt login shell on the remote host', () => {
  const s = shellInvocation({ kind: 'ssh', host: 'box', name: 'ssh:box' }, { cwd: '/repo' });
  assert.equal(s.file, 'ssh');
  assert.deepEqual(s.args.slice(0, 2), ['-tt', 'box']);
  assert.match(s.args[2], /exec '\/bin\/sh'/, 'runs an interactive shell on the remote through the forced pty');
  assert.equal(s.label, 'ssh:box');
});

test('shellInvocation: an explicit shell overrides the default', () => {
  const s = shellInvocation({ kind: 'docker', container: 'c', name: 'docker:c' }, { cwd: '/r', shell: '/bin/bash' });
  assert.equal(s.args[s.args.length - 1], '/bin/bash');
});

// ── graphical streaming (M7c, DESIGN §15 Layer 2 / §11) ────────────────────

test('graphicalEndpoint: a runner with no graphical block returns null (caller fires a FIDELITY-STANDIN)', () => {
  assert.equal(graphicalEndpoint({ kind: 'local' }), null);
  assert.equal(graphicalEndpoint({ kind: 'docker', container: 'x' }), null);
  assert.equal(graphicalEndpoint(null), null);
});

test('graphicalEndpoint: novnc/xpra endpoints normalize (httpBase, origin, ws scheme, client page)', () => {
  const nv = graphicalEndpoint({ name: 'desk', kind: 'docker', graphical: { kind: 'novnc', url: 'http://127.0.0.1:8080/' } });
  assert.equal(nv.kind, 'novnc');
  assert.equal(nv.name, 'desk');
  assert.equal(nv.httpBase, 'http://127.0.0.1:8080/');
  assert.equal(nv.origin, 'http://127.0.0.1:8080');
  assert.equal(nv.wsScheme, 'ws:'); // derived from http
  assert.equal(nv.clientPath, 'vnc.html'); // noVNC default entry page

  // Xpra: served at the server root by default; https → wss; explicit path wins.
  const xp = graphicalEndpoint({ name: 'app', kind: 'docker', graphical: { kind: 'xpra', url: 'https://gui.box/xpra/', path: '/index.html' } });
  assert.equal(xp.kind, 'xpra');
  assert.equal(xp.wsScheme, 'wss:');
  assert.equal(xp.httpBase, 'https://gui.box/xpra/');
  assert.equal(xp.origin, 'https://gui.box');
  assert.equal(xp.clientPath, 'index.html'); // leading slash stripped for relative embed
  assert.equal(graphicalEndpoint({ kind: 'd', graphical: { kind: 'xpra', url: 'http://h:1/' } }).clientPath, '');
});

test('graphicalEndpoint: a malformed graphical block fails loud (misconfig never degrades silently, §12)', () => {
  assert.throws(() => graphicalEndpoint({ graphical: { kind: 'weston', url: 'http://h/' } }), /use xpra \| novnc \| kasmvnc/);
  assert.throws(() => graphicalEndpoint({ graphical: { kind: 'novnc' } }), /needs a "url"/);
  assert.throws(() => graphicalEndpoint({ graphical: { kind: 'novnc', url: 'not a url' } }), /not a valid URL/);
  assert.throws(() => graphicalEndpoint({ graphical: { kind: 'novnc', url: 'ftp://h/' } }), /must be http/);
});
