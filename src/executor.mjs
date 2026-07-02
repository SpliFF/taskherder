// The executor (DESIGN.md §3, §13) — the seam: every `command` step runs under
// a pty, capture goes to logs/, structured events go to events.jsonl, and a
// control socket accepts `input` (keystrokes) / `signal` (INT/TERM) / `resize`
// / `detach`.
import {
  createWriteStream, existsSync, chmodSync, statSync, readdirSync, mkdirSync,
} from 'node:fs';
import { rm, symlink, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import pty from 'node-pty';
import {
  logsDir, runtimeDir, runSocketPath, runSocketLink, repoTasksDir,
} from './paths.mjs';
import { appendEvent } from './events.mjs';
import { resolveProvider, renderInvocation, parseCost } from './providers.mjs';
import { loadProfile, profileEnv, isolationWarnings } from './profiles.mjs';

// Cap on how much trailing output we keep to scan for a provider's cost JSON.
// The result object is small and printed last, so the tail is enough.
const COST_CAPTURE_MAX = 256 * 1024;

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000; // 45m, matches config.json's default
const RING_MAX_BYTES = 64 * 1024; // late-attach replay buffer (DESIGN §13)

// Grace between the timeout SIGTERM and the follow-up SIGKILL. Read per-run so
// tests can shorten it (a child that ignores SIGTERM shouldn't make the suite
// wait the full 10s).
function killGraceMs() {
  return Number(process.env.TASKHERD_KILL_GRACE_MS) || 10_000;
}

// Some npm install pipelines extract node-pty's prebuilt `spawn-helper`
// without the executable bit (observed here: prebuild ships 0644), which
// makes every run fail with an opaque `posix_spawnp failed.`. Self-heal it
// once per process instead of surfacing that cryptic error to every user.
function ensureSpawnHelperExecutable() {
  try {
    const require = createRequire(import.meta.url);
    const prebuildsDir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
    if (!existsSync(prebuildsDir)) return;
    for (const platformDir of readdirSync(prebuildsDir)) {
      const helper = path.join(prebuildsDir, platformDir, 'spawn-helper');
      if (!existsSync(helper)) continue;
      if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch (err) {
    console.error(`FIDELITY-STANDIN: could not verify node-pty spawn-helper is executable: ${err.message}`);
  }
}
ensureSpawnHelperExecutable();

// The control socket accepts keystrokes into a possibly-autonomous agent, so
// its directory must be private to this user. Create it 0700; if it already
// exists, refuse loudly when someone else owns it and tighten its mode if it
// drifted open. Returns the verified dir.
function ensureRuntimeDir() {
  const dir = runtimeDir();
  try {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700); // umask can strip bits from mkdir's requested mode
    return dir;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const st = statSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
  if (st.uid !== uid) {
    throw new Error(
      `taskherd: runtime dir ${dir} is owned by uid ${st.uid}, not ${uid} — `
      + 'refusing to use it (control-socket keystroke-injection risk). '
      + 'Remove it or correct its ownership.',
    );
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700); // we own it; tighten drift
  return dir;
}

// Bare number (JSON number or unit-less string) = SECONDS. Unparseable strings
// throw loudly — a silently-misparsed timeout is a silently-disabled guardrail
// (DESIGN §12). "45m" / "90s" / "500ms" / "300" (=300s) / 300 (=300s).
export function parseTimeout(timeout) {
  if (timeout == null || timeout === '') return DEFAULT_TIMEOUT_MS;
  if (typeof timeout === 'number') return timeout * 1000;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(timeout).trim());
  if (!m) {
    throw new Error(
      `taskherd: cannot parse timeout ${JSON.stringify(timeout)} `
      + '(use e.g. "45m", "90s", "500ms", or a bare number of seconds)',
    );
  }
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] || 's'];
  return n * unit;
}

export function formatDuration(ms) {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}

function shellArgv(step) {
  if (step.argv) return { file: step.argv[0], args: step.argv.slice(1) };
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
  const flag = process.platform === 'win32' ? '/c' : '-c';
  return { file: shell, args: [flag, step.run] };
}

// file-as-prompt (DESIGN §5): a `file` path resolves relative to the repo's
// .tasks/ dir (so `desc/x.md` → .tasks/desc/x.md), unless absolute. `task` is a
// literal prompt string.
async function resolvePrompt(repo, step) {
  if (step.file) {
    const p = path.isAbsolute(step.file) ? step.file : path.join(repoTasksDir(repo), step.file);
    return readFile(p, 'utf8');
  }
  return step.task;
}

// Session mode for an ai step (DESIGN §8). `resume` threads an id from the step
// or, for a lane carrying a session across fires, from lane.session.id. Without
// an id there is nothing to resume, so it degrades to fresh — loudly.
function resolveSession(step, lane) {
  const s = step.session || {};
  const mode = s.mode || 'fresh';
  if (mode === 'resume') {
    const id = s.id || lane?.session?.id || null;
    if (!id) {
      console.error(`taskherd: WARNING lane ${lane?.name} requested session resume but no session id is known yet — starting fresh`);
      return { mode: 'fresh' };
    }
    return { mode: 'resume', id };
  }
  return { mode };
}

// Builds the concrete spawn spec for a step. `command` → the shell/argv, the
// ambient env, no cost capture. `ai` → the provider-rendered argv, the profile's
// isolated env, and cost capture on (DESIGN §8, §9, §13). Throws on setup errors
// (unknown provider, missing profile/prompt); the scheduler catches those per
// lane so one misconfigured lane can't brick the tick.
async function buildInvocation(repo, lane, step, resolvedConfig = {}) {
  if (step.type !== 'ai') {
    const { file, args } = shellArgv(step);
    return {
      file, args, env: process.env, captureCost: false,
    };
  }

  const providerName = resolvedConfig.provider || step.provider;
  if (!providerName) {
    throw new Error(`taskherd: ai step in lane ${lane?.name} has no provider — set it on the step, lane, or config.json (DESIGN §8)`);
  }
  const provider = await resolveProvider(providerName);
  const task = await resolvePrompt(repo, step);
  const maxTurns = step.args?.maxTurns ?? resolvedConfig.maxTurns ?? null;
  const permissionMode = step.args?.permissionMode ?? null;
  const session = resolveSession(step, lane);

  const inv = renderInvocation(provider, {
    task, model: resolvedConfig.model, permissionMode, maxTurns, session, repo,
  });

  let env = process.env;
  const profileName = resolvedConfig.profile || step.profile;
  if (profileName) {
    const profile = await loadProfile(profileName);
    for (const w of isolationWarnings(profile)) {
      console.error(`taskherd: profile '${profileName}' ${w}`);
    }
    env = { ...process.env, ...profileEnv(profile) };
  }

  // Loud whenever an autonomous, un-gated permission model is in force (DESIGN §12).
  if (inv.permissionMode === 'bypassPermissions') {
    console.error(`taskherd: WARNING lane ${lane?.name} runs ${provider.command} with --permission-mode bypassPermissions (autonomous, no approval gate) — DESIGN §12`);
  }

  return {
    file: inv.command, args: inv.args, env, captureCost: inv.captureCost,
  };
}

// node-pty puts the child in its own session (pgid == pid), so signalling the
// process *group* reaches children the shell spawned (a timed-out `npm test`'s
// workers), which a bare child.kill() would orphan holding the pty open.
function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already exited
    }
  }
}

// Runs one step (`command` or `ai`) to completion. Resolves
// { status: 'done'|'failed', exitCode, timedOut, timeoutMs, durationMs, logPath,
//   cost, tokens, sessionId }. Never rejects on the child's own failure — only
// on setup errors (bad argv, unparseable timeout, unknown provider, io).
export async function runStep(repo, lane, step, index, resolvedConfig) {
  const timeoutMs = parseTimeout(resolvedConfig?.timeout); // throws before any I/O
  const invocation = await buildInvocation(repo, lane, step, resolvedConfig || {}); // throws before any I/O

  const id = randomUUID();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir(repo), `${lane.name}-${ts}.log`);
  ensureRuntimeDir();
  const sockPath = runSocketPath(repo, lane.name);
  const sockLink = runSocketLink(repo, lane.name);
  await rm(sockPath, { force: true });
  await rm(sockLink, { force: true });

  const { file, args, env: spawnEnv } = invocation;
  const logStream = createWriteStream(logPath);
  const clients = new Set();

  // Trailing output kept for cost-JSON parsing (ai steps only, DESIGN §10).
  let costCapture = invocation.captureCost ? '' : null;

  // Ring buffer of recent output lines for late attach (DESIGN §13).
  const ring = [];
  let ringBytes = 0;
  const pushRing = (line) => {
    ring.push(line);
    ringBytes += Buffer.byteLength(line);
    while (ringBytes > RING_MAX_BYTES && ring.length > 1) {
      ringBytes -= Buffer.byteLength(ring.shift());
    }
  };

  // The server listens before the pty exists (clients can race in the moment
  // the socket path appears), so control messages from that window are queued
  // and applied at spawn — dropping them silently would violate DESIGN §1.
  let child = null;
  const preSpawn = [];
  const applyControl = (msg) => {
    if (msg.type === 'input') child.write(msg.data);
    else if (msg.type === 'signal') child.kill(msg.signal || 'SIGINT');
    else if (msg.type === 'resize' && msg.cols && msg.rows) child.resize(msg.cols, msg.rows);
  };

  const server = createServer((socket) => {
    for (const line of ring) socket.write(line); // replay backlog to a late client
    clients.add(socket);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'detach') socket.end();
          else if (child) applyControl(msg);
          else preSpawn.push(msg);
        } catch {
          // Malformed control message — ignore rather than crash the run.
        }
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(sockPath, resolve);
  });
  chmodSync(sockPath, 0o600); // owner-only; belt-and-suspenders over the 0700 dir
  // `sockPath` is a short runtime-dir path to stay under AF_UNIX's ~104-byte
  // limit; this symlink keeps the documented `.tasks/run/<lane>.sock` location
  // (DESIGN §4) discoverable for `ls`/tooling. Nothing connects through it.
  await symlink(sockPath, sockLink);

  const startedAt = Date.now();
  child = pty.spawn(file, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: repo,
    env: spawnEnv,
  });
  for (const msg of preSpawn.splice(0)) applyControl(msg);

  await appendEvent(repo, { event: 'run.start', lane: lane.name, step: index, id, argv: [file, ...args] });

  child.onData((data) => {
    logStream.write(data);
    if (costCapture !== null) {
      costCapture += data;
      if (costCapture.length > COST_CAPTURE_MAX) costCapture = costCapture.slice(-COST_CAPTURE_MAX);
    }
    const line = `${JSON.stringify({ ts: new Date().toISOString(), event: 'output', lane: lane.name, step: index, id, data: Buffer.from(data, 'utf8').toString('base64') })}\n`;
    pushRing(line);
    for (const socket of clients) socket.write(line);
  });

  let timedOut = false;
  let killTimer = null;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child, 'SIGTERM');
    killTimer = setTimeout(() => killTree(child, 'SIGKILL'), killGraceMs());
  }, timeoutMs);

  const { exitCode } = await new Promise((resolve) => {
    child.onExit(({ exitCode: code, signal }) => resolve({ exitCode: code, signal }));
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  const durationMs = Date.now() - startedAt;

  logStream.end();
  await appendEvent(repo, { event: 'run.exit', lane: lane.name, step: index, id, code: exitCode, timedOut, durationMs });
  // Teardown must NOT depend on clients cooperating: server.close() waits for
  // every connection to fully close, and a client that never reads (a wedged
  // console tab, a SIGSTOPped attach) never processes our FIN — runStep would
  // hang forever and, with the lock heartbeat above it, halt the whole herd.
  // end() flushes what we wrote; stragglers are destroyed after a short grace.
  for (const socket of clients) socket.end();
  const grace = setTimeout(() => {
    for (const socket of [...clients]) socket.destroy();
  }, 1000);
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(grace);
  await rm(sockPath, { force: true });
  await rm(sockLink, { force: true });

  const status = exitCode === 0 && !timedOut ? 'done' : 'failed';

  // Cost logging (DESIGN §10). A provider we asked for cost JSON that produced
  // none on a clean exit is a loud, greppable stand-in — never a silent $0.
  let cost = null;
  let tokens = null;
  let sessionId = null;
  if (costCapture !== null) {
    const parsed = parseCost(costCapture);
    if (parsed) {
      cost = parsed.usd;
      tokens = { input: parsed.inputTokens, output: parsed.outputTokens };
      sessionId = parsed.sessionId;
    } else if (status === 'done') {
      console.error(`FIDELITY-STANDIN: could not parse ${file} cost JSON for lane ${lane.name} step ${index} — cost not logged (DESIGN §10)`);
    }
  }

  return {
    status,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    timeoutMs,
    durationMs,
    logPath,
    cost,
    tokens,
    sessionId,
  };
}
