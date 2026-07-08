import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import {
  parseTimeout, formatDuration, runStep, extractErrorTail,
} from '../src/executor.mjs';
import { newLane } from '../src/tasks.mjs';
import { runSocketPath } from '../src/paths.mjs';
import { makeRepo, waitFor } from './helpers.mjs';

const FORTY_FIVE_MIN = 45 * 60 * 1000;

test('parseTimeout: a bare number means SECONDS (string or JSON number)', () => {
  assert.equal(parseTimeout(300), 300_000);
  assert.equal(parseTimeout('300'), 300_000);
});

test('parseTimeout: honours explicit units', () => {
  assert.equal(parseTimeout('45m'), FORTY_FIVE_MIN);
  assert.equal(parseTimeout('90s'), 90_000);
  assert.equal(parseTimeout('500ms'), 500);
  assert.equal(parseTimeout('1h'), 3_600_000);
});

test('parseTimeout: empty/absent falls back to the 45m default', () => {
  assert.equal(parseTimeout(null), FORTY_FIVE_MIN);
  assert.equal(parseTimeout(undefined), FORTY_FIVE_MIN);
  assert.equal(parseTimeout(''), FORTY_FIVE_MIN);
});

test('extractErrorTail: keeps the operative error, drops blanks, caps lines', () => {
  const raw = 'step 1\nstep 2\n\n\nError: You have reached your Fable 5 limit\n';
  const tail = extractErrorTail(raw, { maxLines: 2 });
  assert.equal(tail, 'step 2\nError: You have reached your Fable 5 limit');
});

test('extractErrorTail: strips ANSI colour and honours carriage-return repaints', () => {
  // A spinner rewrites its line with \r; only the final paint should survive,
  // and the SGR colour codes around the message must be stripped.
  const raw = 'working... 10%\rworking... 100%\n[31mFATAL: boom[0m\n';
  assert.equal(extractErrorTail(raw), 'working... 100%\nFATAL: boom');
});

test('extractErrorTail: nothing but whitespace/escapes yields null', () => {
  assert.equal(extractErrorTail('[2J[H\n   \n'), null);
  assert.equal(extractErrorTail(''), null);
  assert.equal(extractErrorTail(null), null);
});

test('extractErrorTail: caps total length with a leading ellipsis', () => {
  const raw = `${'x'.repeat(5000)}\n`;
  const tail = extractErrorTail(raw, { maxChars: 100 });
  assert.equal(tail.length, 100);
  assert.ok(tail.startsWith('…'));
});

test('parseTimeout: unparseable input throws loudly (a misparsed guardrail must not be silent)', () => {
  assert.throws(() => parseTimeout('abc'), /cannot parse timeout/);
  assert.throws(() => parseTimeout('45x'), /cannot parse timeout/);
  assert.throws(() => parseTimeout('12 34'), /cannot parse timeout/);
});

test('formatDuration: human units', () => {
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(1500), '2s');
  assert.equal(formatDuration(120_000), '2m');
  assert.equal(formatDuration(3_600_000), '1.0h');
});

test('runStep: exit 0 -> done, non-zero -> failed, with a duration', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const lane = newLane('main');

  const ok = await runStep(repo, lane, { type: 'command', run: 'exit 0' }, 0, {});
  assert.equal(ok.status, 'done');
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.timedOut, false);
  assert.ok(ok.durationMs >= 0);

  const bad = await runStep(repo, lane, { type: 'command', run: 'exit 3' }, 0, {});
  assert.equal(bad.status, 'failed');
  assert.equal(bad.exitCode, 3);
});

test('runStep: a step that ignores SIGTERM is escalated to SIGKILL on timeout', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const prev = process.env.TASKHERD_KILL_GRACE_MS;
  process.env.TASKHERD_KILL_GRACE_MS = '200';
  t.after(() => {
    if (prev === undefined) delete process.env.TASKHERD_KILL_GRACE_MS;
    else process.env.TASKHERD_KILL_GRACE_MS = prev;
  });

  const lane = newLane('main');
  // The marker proves the trap was installed BEFORE the timeout fired — shell
  // startup can exceed a short timeout, in which case plain SIGTERM kills the
  // child and the test passes without ever exercising the SIGKILL escalation.
  const step = { type: 'command', run: 'trap "" TERM; echo TRAP-READY; while true; do :; done' };
  const result = await runStep(repo, lane, step, 0, { timeout: '2s' });
  assert.equal(result.timedOut, true, 'the run was timed out');
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, null, 'exitCode is null on a timeout kill');
  const log = await readFile(result.logPath, 'utf8');
  assert.match(log, /TRAP-READY/, 'the TERM trap was active before the timeout, so only the SIGKILL escalation can have ended this run');
});

test('control socket: input injected by a client reaches the running step', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const lane = newLane('main');
  const runP = runStep(repo, lane, { type: 'command', run: 'read x; echo "GOT:$x"' }, 0, { timeout: '10s' });

  const sockPath = runSocketPath(repo, 'main');
  await waitFor(() => existsSync(sockPath));
  // Deliberately a WORST-CASE client: it writes input but never reads from the
  // socket, so it never processes the server's FIN. runStep's teardown must
  // still complete (it force-destroys stragglers after a grace) — this is the
  // regression test for the hang where server.close() waited on client FINs.
  await new Promise((resolve, reject) => {
    const sock = connect(sockPath, () => {
      sock.write(`${JSON.stringify({ type: 'input', data: 'hello\n' })}\n`);
      resolve();
    });
    sock.on('error', reject);
  });

  const result = await runP;
  assert.equal(result.status, 'done');
  const log = await readFile(result.logPath, 'utf8');
  assert.match(log, /GOT:hello/, 'the injected keystrokes were read by the step');
});

test('control socket: a late attach replays recent output from the ring buffer', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const lane = newLane('main');
  // Print a marker, then block on input so the step is still alive when we
  // attach *after* the marker was already emitted.
  const runP = runStep(repo, lane, { type: 'command', run: 'echo MARKER-42; read x' }, 0, { timeout: '10s' });

  const sockPath = runSocketPath(repo, 'main');
  await waitFor(() => existsSync(sockPath));
  await new Promise((r) => { setTimeout(r, 200); }); // let MARKER-42 be emitted before we attach

  const seen = await new Promise((resolve) => {
    let acc = '';
    let buf = '';
    const sock = connect(sockPath);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.event === 'output') acc += Buffer.from(m.data, 'base64').toString('utf8');
        } catch {
          // ignore
        }
      }
      if (acc.includes('MARKER-42')) {
        sock.write(`${JSON.stringify({ type: 'input', data: 'x\n' })}\n`); // unblock `read`
        resolve(acc);
      }
    });
  });

  await runP;
  assert.match(seen, /MARKER-42/, 'the late client received output emitted before it connected');
});
