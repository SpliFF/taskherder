// M5 — the web console control plane (DESIGN §15): project registry, queue
// editing, the §14 os notify-once ping, the serve API (auth, state,
// mutations), the events WS tail, and the WS pty bridge that makes
// answer-a-gate / interrupt-a-task work from a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

import { makeRepo, makeGitRepo, waitFor } from './helpers.mjs';
import { tick } from '../src/scheduler.mjs';
import { registerProject, listProjects } from '../src/registry.mjs';
import {
  addStep, loadLane, saveLane, removeStep, moveStep, editStep,
} from '../src/tasks.mjs';
import { notifyArgv } from '../src/notify.mjs';
import { appendEvent } from '../src/events.mjs';
import { runStep } from '../src/executor.mjs';
import { newLane } from '../src/tasks.mjs';
import { createConsoleServer } from '../src/serve.mjs';
import {
  repoId, runSocketLink, pausedFile, projectConfigFile,
} from '../src/paths.mjs';

// ── helpers ──────────────────────────────────────────────────────────────

async function startServer() {
  const console_ = await createConsoleServer();
  const addr = await console_.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const api = async (method, p, body, token = console_.token) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    console_, base, api, port: addr.port,
  };
}

// A lane blocked on a manual gate, the way the scheduler leaves one.
async function makeGatedLane(repo, name, message) {
  await addStep(repo, name, { type: 'manual', message });
  const lane = await loadLane(repo, name);
  lane.steps[lane.cursor].status = 'blocked';
  lane.status = 'blocked';
  await saveLane(repo, lane);
  return lane;
}

// ── registry ─────────────────────────────────────────────────────────────

test('registry: init registers the project; listProjects flags a vanished path', async (t) => {
  const { repo, cleanup } = await makeRepo(); // initTasksDir ran inside
  t.after(cleanup);
  const projects = await listProjects();
  const mine = projects.find((p) => p.id === repoId(repo));
  assert.ok(mine, 'init must register the project');
  assert.equal(mine.path, path.resolve(repo));
  assert.equal(mine.missing, false);

  await registerProject('/nonexistent/elsewhere');
  const again = await listProjects();
  assert.equal(again.find((p) => p.path === '/nonexistent/elsewhere').missing, true);

  // Idempotent: re-registering doesn't duplicate.
  await registerProject(repo);
  const ids = (await listProjects()).map((p) => p.id);
  assert.equal(ids.filter((id) => id === repoId(repo)).length, 1);
});

// ── queue editing ────────────────────────────────────────────────────────

test('queue ops: remove/move/edit pending steps; history and non-pending refuse', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'main', { type: 'command', task: 'echo a' });
  await addStep(repo, 'main', { type: 'command', task: 'echo b' });
  await addStep(repo, 'main', { type: 'command', task: 'echo c' });
  let lane = await loadLane(repo, 'main');
  lane.steps[0].status = 'done';
  lane.cursor = 1;
  await saveLane(repo, lane);

  await assert.rejects(() => removeStep(repo, 'main', 0), /already ran/);
  await assert.rejects(() => removeStep(repo, 'main', 9), /no step 9/);
  await assert.rejects(() => moveStep(repo, 'main', 2, 0), /already ran/);

  await moveStep(repo, 'main', 2, 1); // c before b
  lane = await loadLane(repo, 'main');
  assert.equal(lane.steps[1].run, 'echo c');

  const { step } = await editStep(repo, 'main', 1, { run: 'echo edited' });
  assert.equal(step.run, 'echo edited');
  await assert.rejects(() => editStep(repo, 'main', 1, { run: null }), /needs/); // must stay valid
  await assert.rejects(
    () => editStep(repo, 'main', 1, { status: 'done' }).then(() => loadLane(repo, 'main'))
      .then((l) => { if (l.steps[1].status !== 'pending') throw new Error('status rode in'); return removeStep(repo, 'main', 99); }),
    /no step 99/,
  );

  await removeStep(repo, 'main', 2);
  lane = await loadLane(repo, 'main');
  assert.equal(lane.steps.length, 2);
});

test('queue ops: the running step (live control socket) is off-limits, later steps are not', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'main', { type: 'command', task: 'echo now' });
  await addStep(repo, 'main', { type: 'command', task: 'echo later' });
  // A live run is signalled by the run/<lane>.sock symlink (DESIGN §13).
  await writeFile(runSocketLink(repo, 'main'), 'stub');

  await assert.rejects(() => removeStep(repo, 'main', 0), /running/);
  await assert.rejects(() => editStep(repo, 'main', 0, { run: 'x' }), /running/);
  const { lane } = await removeStep(repo, 'main', 1); // beyond the live index is fine
  assert.equal(lane.steps.length, 1);
});

// ── notifications (§14 os channel) ───────────────────────────────────────

test('notifyArgv: platform argv shapes, and the override command', () => {
  const mac = notifyArgv('darwin', 'title "quoted"', 'body\\slash');
  assert.equal(mac[0], 'osascript');
  assert.ok(mac[2].includes('\\"quoted\\"'), 'quotes must be escaped into osascript');
  assert.ok(mac[2].includes('body\\\\slash'), 'backslashes must be escaped');
  assert.deepEqual(notifyArgv('linux', 't', 'b'), ['notify-send', 't', 'b']);
  assert.deepEqual(notifyArgv('darwin', 't', 'b', '/x/notify.sh'), ['/x/notify.sh', 't', 'b']);
});

test('gate.blocked emission pings the notifier once; notify:"none" (the test default) stays silent', async (t) => {
  const { repo, home, cleanup } = await makeRepo();
  t.after(cleanup);
  const out = path.join(home, 'notified.txt');
  const script = path.join(home, 'notify.sh');
  await writeFile(script, `#!/bin/sh\nprintf '%s|%s' "$1" "$2" >> ${out}\n`);
  chmodSync(script, 0o755);
  process.env.TASKHERD_NOTIFY_CMD = script;
  t.after(() => { delete process.env.TASKHERD_NOTIFY_CMD; });

  // helpers' user config says notify:"none" — no ping.
  await appendEvent(repo, { event: 'gate.blocked', lane: 'main', reason: 'quiet' });
  await new Promise((r) => { setTimeout(r, 200); });
  assert.ok(!existsSync(out), 'notify:"none" must suppress the ping');

  // Project-level notify:"os" overrides the user default.
  const cfg = JSON.parse(await readFile(projectConfigFile(repo), 'utf8'));
  cfg.notify = 'os';
  await writeFile(projectConfigFile(repo), JSON.stringify(cfg));
  await appendEvent(repo, { event: 'gate.blocked', lane: 'main', reason: 'look at me' });
  await waitFor(() => existsSync(out));
  const ping = await readFile(out, 'utf8');
  assert.ok(ping.includes('main'), 'title carries the lane');
  assert.ok(ping.includes('look at me'), 'body carries the reason');

  // Non-gate events never ping.
  await appendEvent(repo, { event: 'run.exit', lane: 'main', code: 0 });
  await new Promise((r) => { setTimeout(r, 200); });
  assert.equal(await readFile(out, 'utf8'), ping, 'only gate.blocked notifies');
});

// ── serve: auth + state + mutations ──────────────────────────────────────

test('serve: API and WS refuse without the token; static assets and the SPA are served', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const { console_, base, api } = await startServer();
  t.after(() => console_.close());

  assert.equal((await api('GET', '/api/projects', null, null)).status, 401);
  assert.equal((await api('GET', '/api/projects', null, 'wrong-token')).status, 401);
  assert.equal((await api('GET', '/api/projects')).status, 200);

  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('taskherd console'));
  for (const asset of ['/app.mjs', '/style.css', '/vendor/xterm.mjs', '/vendor/xterm.css', '/vendor/addon-fit.mjs']) {
    assert.equal((await fetch(`${base}${asset}`)).status, 200, `${asset} must serve`);
  }

  const wsFail = new WebSocket(`ws://127.0.0.1:${console_.server.address().port}/ws/events?project=${repoId(repo)}`);
  await new Promise((resolve) => { wsFail.on('error', resolve); wsFail.on('close', resolve); });
  assert.notEqual(wsFail.readyState, WebSocket.OPEN, 'tokenless WS upgrade must be refused');
});

test('serve: GET /diff returns a lane branch diff for review; missing lane is a 400 (§15 L2)', async (t) => {
  const { repo, cleanup } = await makeGitRepo();
  t.after(cleanup);
  await registerProject(repo);
  // A worktree lane commits a file on taskherd/feat.
  await saveLane(repo, newLane('feat', {
    steps: [{ type: 'command', run: 'echo hello > f.txt && git add f.txt && git commit -m add-f', status: 'pending' }],
  }));
  assert.equal((await tick(repo)).outcome, 'ran');

  const { console_, api } = await startServer();
  t.after(() => console_.close());
  const id = repoId(repo);

  const { status, body: d } = await api('GET', `/api/projects/${id}/diff?lane=feat`);
  assert.equal(status, 200);
  assert.equal(d.exists, true);
  assert.equal(d.branch, 'taskherd/feat');
  assert.equal(d.ahead, 1);
  assert.deepEqual(d.files.map((f) => f.path), ['f.txt']);
  assert.match(d.patch, /\+hello/);

  // A lane with no branch yet → exists:false (not an error).
  assert.equal((await api('GET', `/api/projects/${id}/diff?lane=none`)).body.exists, false);
  // Missing lane param → 400. No token → 401.
  assert.equal((await api('GET', `/api/projects/${id}/diff`)).status, 400);
  assert.equal((await api('GET', `/api/projects/${id}/diff?lane=feat`, null, null)).status, 401);
});

test('serve: RUN fires one lane in the serve process; force overrides pause', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'main', { type: 'command', task: 'echo hi' });
  await addStep(repo, 'main', { type: 'command', task: 'echo again' });

  const { console_, api } = await startServer();
  t.after(() => console_.close());
  const id = repoId(repo);

  const untilStep = async (index, status, timeout = 5000) => {
    const start = Date.now();
    // eslint-disable-next-line no-await-in-loop
    while ((await loadLane(repo, 'main')).steps[index].status !== status) {
      if (Date.now() - start > timeout) throw new Error(`step ${index} never became ${status}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 20); });
    }
  };

  // RUN the lane now; the command is quick, so it starts running (or finishes)
  // and the response reports which — never blocking the HTTP call on the step.
  const run = await api('POST', `/api/projects/${id}/run`, { lane: 'main' });
  assert.equal(run.status, 200);
  assert.ok(['running', 'ran'].includes(run.body.outcome), `unexpected outcome ${run.body.outcome}`);
  await untilStep(0, 'done');
  assert.equal((await loadLane(repo, 'main')).cursor, 1);

  // A missing lane is reported (200 + reason), never a crash.
  const missing = await api('POST', `/api/projects/${id}/run`, { lane: 'ghost' });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.outcome, 'not-runnable');
  assert.match(missing.body.reason, /no such lane/);

  // Paused: a plain RUN skips; force overrides for this one run.
  await api('POST', `/api/projects/${id}/pause`, {});
  const paused = await api('POST', `/api/projects/${id}/run`, { lane: 'main' });
  assert.equal(paused.body.outcome, 'paused');
  assert.equal((await loadLane(repo, 'main')).steps[1].status, 'pending', 'nothing ran while paused');

  const forced = await api('POST', `/api/projects/${id}/run`, { lane: 'main', force: true });
  assert.ok(['running', 'ran'].includes(forced.body.outcome));
  await untilStep(1, 'done');
  assert.ok(existsSync(pausedFile(repo)), 'force leaves the pause switch itself in place');
});

test('serve: answer a gate + edit the queue + pause through the API (the phone flow)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await makeGatedLane(repo, 'main', 'sign off on the release');
  await addStep(repo, 'main', { type: 'command', task: 'echo after-gate' });

  const { console_, api } = await startServer();
  t.after(() => console_.close());
  const id = repoId(repo);

  // The console sees the gate.
  const { body: state } = await api('GET', '/api/projects');
  const project = state.projects.find((p) => p.id === id);
  const lane = project.lanes.find((l) => l.name === 'main');
  assert.equal(lane.gate, 'sign off on the release');

  // ACK answers it.
  const ack = await api('POST', `/api/projects/${id}/ack`, { lane: 'main' });
  assert.equal(ack.status, 200);
  assert.equal((await loadLane(repo, 'main')).cursor, 1);

  // Queue edit: add, then remove; a bad index is a 400, not a 500.
  const add = await api('POST', `/api/projects/${id}/add`, { lane: 'main', step: { type: 'command', task: 'echo queued' } });
  assert.equal(add.status, 200);
  assert.equal(add.body.index, 2);
  assert.equal((await api('POST', `/api/projects/${id}/remove-step`, { lane: 'main', index: 99 })).status, 400);
  assert.equal((await api('POST', `/api/projects/${id}/remove-step`, { lane: 'main', index: 2 })).status, 200);

  // Fork from the console.
  assert.equal((await api('POST', `/api/projects/${id}/fork`, { name: 'side', from: 'main' })).status, 200);
  assert.equal((await loadLane(repo, 'side')).parent, 'main');

  // Pause / resume flips the kill-switch file.
  await api('POST', `/api/projects/${id}/pause`, {});
  assert.ok(existsSync(pausedFile(repo)));
  await api('POST', `/api/projects/${id}/resume`, {});
  assert.ok(!existsSync(pausedFile(repo)));

  // Interrupting an idle lane is a clean 409.
  const sig = await api('POST', `/api/projects/${id}/signal`, { lane: 'main', signal: 'SIGINT' });
  assert.equal(sig.status, 409);
  // Unknown project: 400 family, not a crash.
  assert.equal((await api('POST', '/api/projects/nope/ack', { lane: 'main' })).status, 400);
});

// ── serve: live seams ────────────────────────────────────────────────────

test('serve: the events WS streams new events.jsonl lines as they land', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const { console_, port } = await startServer();
  t.after(() => console_.close());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events?project=${repoId(repo)}&token=${console_.token}`);
  const lines = [];
  ws.on('message', (d) => lines.push(JSON.parse(d.toString())));
  // The tail is only live once the server says hello (the WS handshake lands
  // before the server's async watcher install — events sent earlier may
  // legitimately predate the tail).
  await waitFor(() => lines.some((l) => l.event === 'hello'));

  await appendEvent(repo, { event: 'gate.blocked', lane: 'main', reason: 'ping' });
  await waitFor(() => lines.some((l) => l.event === 'gate.blocked' && l.reason === 'ping'));
  ws.close();
});

test('serve: WS pty bridge — watch output, type input, interrupt from the console (exit-criterion seam)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const { console_, port, api } = await startServer();
  t.after(() => console_.close());
  const id = repoId(repo);
  const lane = newLane('live');

  // A step that proves the full loop: prints, echoes a typed line, then hangs
  // until a signal lands.
  const step = { type: 'command', run: 'echo READY; read line; echo "GOT:$line"; sleep 30' };
  const running = runStep(repo, lane, step, 0, { timeout: '25s' });

  await waitFor(() => existsSync(runSocketLink(repo, 'live')));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?project=${id}&lane=live&token=${console_.token}`);
  let output = '';
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.event === 'output') output += Buffer.from(msg.data, 'base64').toString('utf8');
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

  await waitFor(() => output.includes('READY')); // ring-buffer replay or live
  ws.send(JSON.stringify({ type: 'input', data: 'hello-from-phone\n' }));
  await waitFor(() => output.includes('GOT:hello-from-phone'));

  // Interrupt via the REST endpoint (the lane-card button), not the bridge —
  // both paths go through the same control socket.
  const sig = await api('POST', `/api/projects/${id}/signal`, { lane: 'live', signal: 'SIGTERM' });
  assert.equal(sig.status, 200);
  const result = await running;
  // Regression guard for the M5-found executor bug: node-pty reports a
  // signal-killed child as {exitCode: 0, signal: N} — that must never read as
  // 'done' (the interrupt button would otherwise mark the step complete).
  assert.equal(result.status, 'failed');
  assert.ok(result.signal, 'the killing signal is recorded');
  assert.equal(result.exitCode, null, 'a 0-from-a-signal is not reported as a real exit code');
  assert.equal(result.timedOut, false, 'killed by the signal, not the timeout');
  ws.close();
});

// ── web-SSH: serve-owned runner shells (M7b, DESIGN §15 Layer 2) ───────────

// Resolves to the WS close code (or -1 if it errored before opening).
function wsCloseCode(ws) {
  return new Promise((resolve) => {
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

test('web-SSH: an --allow-shell console opens a serve-owned shell; disconnect reaps the shell process', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await registerProject(repo);
  // Force a clean POSIX shell so the test doesn't depend on the machine's
  // interactive rc files (speed + hermeticity); restore after.
  const prevShell = process.env.SHELL;
  process.env.SHELL = '/bin/sh';
  t.after(() => { if (prevShell === undefined) delete process.env.SHELL; else process.env.SHELL = prevShell; });

  const console_ = await createConsoleServer({ allowShell: true });
  const addr = await console_.listen(0, '127.0.0.1');
  t.after(() => console_.close());
  const id = repoId(repo);

  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/shell?project=${id}&runner=local&token=${console_.token}`);
  let output = '';
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.event === 'output') output += Buffer.from(msg.data, 'base64').toString('utf8');
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  // The session is registered inside the server's async upgrade path, a beat
  // after the client's `open` fires — poll rather than assume it is synchronous.
  await waitFor(() => console_.shellSessionCount() === 1); // tracked (capacity + teardown accounting)

  // A real interactive shell: it runs a typed command and reports its own pid.
  ws.send(JSON.stringify({ type: 'input', data: 'echo "SHELL_PID:$$"; echo READY\n' }));
  await waitFor(() => /SHELL_PID:\d+/.test(output) && output.includes('READY'));
  const shellPid = Number(/SHELL_PID:(\d+)/.exec(output)[1]);
  assert.doesNotThrow(() => process.kill(shellPid, 0), 'the serve-owned shell is alive while connected');

  // Kill-on-disconnect: a dropped client must leave NO orphan shell (the whole
  // point of gating this behind --allow-shell — an interactive RCE surface, §12).
  ws.close();
  await waitFor(() => console_.shellSessionCount() === 0);
  await waitFor(() => {
    try { process.kill(shellPid, 0); return false; } catch { return true; }
  }, { timeout: 6000 });
});

test('web-SSH: /ws/shell is refused (4403) when the console was NOT started with --allow-shell', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await registerProject(repo);
  const console_ = await createConsoleServer(); // default: web-SSH off
  const addr = await console_.listen(0, '127.0.0.1');
  t.after(() => console_.close());

  assert.equal(console_.allowShell, false);
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/shell?project=${repoId(repo)}&runner=local&token=${console_.token}`);
  assert.equal(await wsCloseCode(ws), 4403, 'the disabled endpoint closes with a greppable 4403');
});

test('web-SSH: a tokenless /ws/shell upgrade is refused (auth is required for every WS)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await registerProject(repo);
  const console_ = await createConsoleServer({ allowShell: true });
  const addr = await console_.listen(0, '127.0.0.1');
  t.after(() => console_.close());

  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/shell?project=${repoId(repo)}&runner=local`);
  await new Promise((resolve) => { ws.on('open', resolve); ws.on('error', resolve); ws.on('close', resolve); });
  assert.notEqual(ws.readyState, WebSocket.OPEN, 'no shell without the token');
  assert.equal(console_.shellSessionCount(), 0, 'a rejected upgrade never spawns a shell');
});

test('web-SSH: concurrent shell sessions are capped (bounds the RCE surface, §12)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await registerProject(repo);
  const prevShell = process.env.SHELL;
  process.env.SHELL = '/bin/sh';
  t.after(() => { if (prevShell === undefined) delete process.env.SHELL; else process.env.SHELL = prevShell; });

  const console_ = await createConsoleServer({ allowShell: true, maxShellSessions: 1 });
  const addr = await console_.listen(0, '127.0.0.1');
  t.after(() => console_.close());
  const id = repoId(repo);

  const ws1 = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/shell?project=${id}&runner=local&token=${console_.token}`);
  await new Promise((resolve, reject) => { ws1.on('open', resolve); ws1.on('error', reject); });
  await waitFor(() => console_.shellSessionCount() === 1);

  const ws2 = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/shell?project=${id}&runner=local&token=${console_.token}`);
  assert.equal(await wsCloseCode(ws2), 4429, 'the second session over the cap is turned away');
  assert.equal(console_.shellSessionCount(), 1, 'the capped session never spawned a shell');
  ws1.close();
});

test('web-SSH: an unknown runner closes the shell WS loudly (4400), never a silent local fallback', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await registerProject(repo);
  const console_ = await createConsoleServer({ allowShell: true });
  const addr = await console_.listen(0, '127.0.0.1');
  t.after(() => console_.close());

  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/shell?project=${repoId(repo)}&runner=podman:box&token=${console_.token}`);
  assert.equal(await wsCloseCode(ws), 4400, 'a bad runner is rejected, not silently run on localhost');
  assert.equal(console_.shellSessionCount(), 0);
});

// ── graphical streaming: reverse proxy to an in-runner GUI (M7c, DESIGN §15 L2) ──

// Stands in for an Xpra/noVNC HTML5 server running inside a runner (none is
// installed on this machine): an HTTP page/asset server + a WS echo endpoint.
async function startFakeGfxServer(t) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`GFX-CLIENT ${req.url}`);
  });
  const gws = new WebSocketServer({ server: srv, path: '/websockify' });
  gws.on('connection', (ws) => ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary })));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return srv.address().port;
}

test('graphical: gfx-open mints a capability; HTTP + WS proxy reach the in-runner GUI; no-graphical runner is a loud standin (§15 L2)', async (t) => {
  const { repo, home, cleanup } = await makeRepo();
  t.after(cleanup);
  await registerProject(repo);
  const gfxPort = await startFakeGfxServer(t);

  // Declare the fake server as a runner's graphical endpoint (runners.json).
  await writeFile(path.join(home, 'runners.json'), JSON.stringify({
    desktop: {
      kind: 'docker', container: 'gui',
      graphical: { kind: 'novnc', url: `http://127.0.0.1:${gfxPort}/`, path: 'vnc.html' },
    },
  }));

  const console_ = await createConsoleServer({ allowGfx: true });
  const addr = await console_.listen(0, '127.0.0.1');
  t.after(() => console_.close());
  const base = `http://127.0.0.1:${addr.port}`;
  const id = repoId(repo);
  const authed = (method, p, body) => fetch(`${base}${p}`, {
    method,
    headers: { authorization: `Bearer ${console_.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  // The console learns the capability is on + which runners can be streamed.
  const projects = await (await authed('GET', '/api/projects')).json();
  assert.equal(projects.allowGfx, true);
  assert.deepEqual(projects.gfxRunners, ['desktop']);

  // gfx-open mints a session URL under an unguessable capability path, served on
  // a SEPARATE origin (a distinct port) from the console so a proxied runner GUI
  // cannot read the console token (localStorage is per-origin).
  const openRes = await authed('POST', `/api/projects/${id}/gfx-open`, { runner: 'desktop' });
  assert.equal(openRes.status, 200);
  const open = await openRes.json();
  assert.equal(open.kind, 'novnc');
  assert.match(open.url, /^http:\/\/127\.0\.0\.1:\d+\/gfx\/[^/]+\/vnc\.html$/);
  const gfxUrl = new URL(open.url);
  assert.notEqual(gfxUrl.port, String(addr.port), 'gfx served from a separate origin/port (token-theft isolation)');
  assert.equal(Number(gfxUrl.port), console_.gfxPort(), 'gfx URL uses the bound gfx port');
  assert.equal(console_.graphicalSessionCount(), 1);

  // HTTP proxy: the iframe's client page loads through serve WITHOUT a token (the
  // capability in the path is the auth), and reaches the in-runner server.
  const page = await fetch(open.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /GFX-CLIENT \/vnc\.html/);
  // A sub-resource under the same capability prefix flows through too (relative
  // asset loads from the HTML5 client).
  const asset = await fetch(open.url.replace(/vnc\.html$/, 'ui/app.js'));
  assert.match(await asset.text(), /GFX-CLIENT \/ui\/app\.js/);

  // WS proxy: the graphical protocol WebSocket is piped byte-transparently (on
  // the gfx origin, derived from the minted URL).
  const ws = new WebSocket(open.url.replace(/^http/, 'ws').replace(/vnc\.html$/, 'websockify'));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const echoed = new Promise((resolve) => ws.on('message', (d) => resolve(Buffer.from(d))));
  ws.send(Buffer.from([0, 1, 2, 254, 255]));
  assert.deepEqual([...(await echoed)], [0, 1, 2, 254, 255], 'binary frames round-trip through the proxy');
  ws.close();

  // A runner with NO graphical block → 400 + standin flag (a FIDELITY-STANDIN is
  // logged), never a silent blank frame.
  const none = await authed('POST', `/api/projects/${id}/gfx-open`, { runner: 'local' });
  assert.equal(none.status, 400);
  assert.equal((await none.json()).standin, true);

  // Unknown runner → 400 (LaneValidationError), not a 500. An unknown capability
  // on the gfx origin 404s (never proxies); the console origin serves no /gfx.
  assert.equal((await authed('POST', `/api/projects/${id}/gfx-open`, { runner: 'ghost' })).status, 400);
  assert.equal((await fetch(`${gfxUrl.origin}/gfx/deadbeefdeadbeef/vnc.html`)).status, 404);
  assert.equal((await fetch(`${base}/gfx/deadbeefdeadbeef/vnc.html`)).status, 404);
});

test('graphical: --allow-gfx off refuses gfx-open (403) and darkens /gfx (404); no runners advertised', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await registerProject(repo);
  const console_ = await createConsoleServer(); // gfx off by default
  const addr = await console_.listen(0, '127.0.0.1');
  t.after(() => console_.close());
  const base = `http://127.0.0.1:${addr.port}`;
  const id = repoId(repo);
  assert.equal(console_.allowGfx, false);

  const projects = await (await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${console_.token}` } })).json();
  assert.equal(projects.allowGfx, false);
  assert.deepEqual(projects.gfxRunners, []);

  const open = await fetch(`${base}/api/projects/${id}/gfx-open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${console_.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runner: 'local' }),
  });
  assert.equal(open.status, 403, 'the dangerous capability is opt-in (§12)');
  assert.equal((await fetch(`${base}/gfx/anything/here`)).status, 404, 'the /gfx surface is dark when disabled');
});
