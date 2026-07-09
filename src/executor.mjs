// The executor (DESIGN.md §3, §13) — the seam: every `command` step runs under
// a pty, capture goes to logs/, structured events go to events.jsonl, and a
// control socket accepts `input` (keystrokes) / `signal` (INT/TERM) / `resize`
// / `detach`.
import {
  createWriteStream, existsSync, chmodSync, statSync, readdirSync, mkdirSync,
} from 'node:fs';
import {
  rm, symlink, readFile, writeFile, mkdir,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import pty from 'node-pty';
import {
  logsDir, runtimeDir, runSocketPath, runSocketLink, repoTasksDir, runDir,
} from './paths.mjs';
import { appendEvent } from './events.mjs';
import { resolveProvider, renderInvocation, parseCost } from './providers.mjs';
import { resolveRunner, wrapForRunner } from './runners.mjs';
import { loadProfile, profileEnv, isolationWarnings } from './profiles.mjs';
import {
  isGitRepo, ensureWorktree, ensureInplaceBranch, defaultBase, headCommit,
} from './git.mjs';
import { distillStreamJson } from './render.mjs';

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
export function ensureSpawnHelperExecutable() {
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

// How much trailing pty output to keep for the failure excerpt (DESIGN §1/§6:
// a parked failure must carry the *actual* error, e.g. a provider 429, not just
// "exit N — see log"). Small: the operative error is at the very end.
const TAIL_MAX_BYTES = 8 * 1024;
// CSI sequences (colors/cursor moves), the two-char escapes, and OSC title
// strings — the escape noise a TUI provider (claude/codex) paints around its
// text. Hex escapes keep this source free of literal control bytes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[=>]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // strays after ANSI strip (keep \t)

// Distill a human-readable error excerpt from raw pty output: honor carriage
// returns (a spinner rewrites its line — keep only the final paint), strip ANSI
// escapes and stray control bytes, drop blank lines, then keep the last few
// lines capped to a banner-sized string. Returns null when nothing survives.
export function extractErrorTail(raw, { maxLines = 12, maxChars = 800 } = {}) {
  if (!raw) return null;
  // An AI step's tail is stream-json JSONL, not human text — distill the answer/
  // error text out of it (else the parked failure shows raw `{"type":…}` lines).
  // Returns null for command output, which falls through to the ANSI-strip path.
  const distilled = distillStreamJson(raw);
  if (distilled != null) {
    return distilled.length > maxChars ? `…${distilled.slice(-(maxChars - 1))}` : distilled;
  }
  const lines = raw
    .split('\n')
    .map((l) => l
      .replace(/^.*\r(?!$)/, '') // last carriage-return wins (progress/spinner overwrite)
      .replace(ANSI_RE, '')
      .replace(CTRL_RE, '')
      .replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  let tail = lines.slice(-maxLines).join('\n');
  if (tail.length > maxChars) tail = `…${tail.slice(-(maxChars - 1))}`;
  return tail;
}

function shellArgv(step, runnerKind = 'local') {
  if (step.argv) return { file: step.argv[0], args: step.argv.slice(1) };
  // A `run` string on a docker/ssh runner is interpreted by a shell that exists
  // in the RUNNER env (a Linux container / remote host), so use POSIX /bin/sh —
  // the host's $SHELL (e.g. /bin/zsh) is absent there. Local keeps $SHELL.
  if (runnerKind !== 'local') return { file: '/bin/sh', args: ['-c', step.run] };
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

// Git isolation (DESIGN §7): where the step's working tree lives. An explicit
// isolation value wins; unset means worktree when the repo is git-managed
// ("default for code lanes") and none otherwise. Git isolation configured on a
// non-repo throws — the lane parks loudly rather than silently running
// unisolated (§12: a misconfigured guardrail must not degrade quietly).
async function resolveWorkdir(repo, lane, resolvedConfig) {
  const gitRepo = await isGitRepo(repo);
  const isolation = resolvedConfig.isolation ?? (gitRepo ? 'worktree' : 'none');
  if (isolation === 'none') return { isolation, workdir: repo };
  if (!gitRepo) {
    throw new Error(
      `taskherd: lane ${lane?.name} wants isolation '${isolation}' but ${repo} is not a git repository — set isolation 'none' or git init`,
    );
  }
  const base = resolvedConfig.base || await defaultBase(repo);
  if (isolation === 'worktree') {
    // The bootstrap manifest (§24) rides the same §5 inheritance as the axes —
    // a fresh pool worktree is seeded before the step's pty ever spawns, so a
    // failed `generate` parks the lane as a setup error.
    return { isolation, workdir: await ensureWorktree(repo, lane.name, base, { bootstrap: resolvedConfig.bootstrap }) };
  }
  if (isolation === 'inplace') {
    await ensureInplaceBranch(repo, lane.name, base);
    return { isolation, workdir: repo };
  }
  throw new Error(`taskherd: unknown isolation ${JSON.stringify(isolation)} (worktree | inplace | none)`);
}

// A scheduled ai run must see the taskherd-mcp tasks_* tools (DESIGN §16, §17
// — the /task finalization loop enqueues its own next step/gate), but the
// provider is invoked with --strict-mcp-config, which hides everything not in
// the passed config. So each ai run gets a merged config: the tree's own
// .mcp.json servers (if any) plus a `taskherd` entry pinned to this package's
// bin/mcp.mjs, written to .tasks/run/<lane>.mcp.json. The entry's env carries
// the MAIN repo path + lane name so the tools target the right .tasks/ even
// though the agent's cwd is a worktree (which never contains .tasks/ — it's
// gitignored). A tree .mcp.json that defines its own `taskherd` server wins
// (deliberate pin), loudly.
export async function writeMcpConfig(repo, lane, workdir) {
  const mcpBin = fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url));
  const taskherd = {
    command: process.execPath,
    args: [mcpBin],
    env: {
      TASKHERD_REPO: path.resolve(repo),
      TASKHERD_LANE: lane.name,
      ...(process.env.TASKHERD_HOME ? { TASKHERD_HOME: process.env.TASKHERD_HOME } : {}),
    },
  };
  let treeServers = {};
  const treeCfg = path.join(workdir, '.mcp.json');
  if (existsSync(treeCfg)) {
    try {
      treeServers = JSON.parse(await readFile(treeCfg, 'utf8')).mcpServers || {};
    } catch (err) {
      // Malformed project config is a setup error — park the lane loudly
      // rather than silently running the agent without its project's servers.
      throw new Error(`taskherd: malformed ${treeCfg}: ${err.message}`);
    }
    if (treeServers.taskherd) {
      console.error(`taskherd: NOTE ${treeCfg} defines its own 'taskherd' MCP server — using the repo's, not the built-in`);
    }
  }
  const merged = { mcpServers: { taskherd, ...treeServers } };
  await mkdir(runDir(repo), { recursive: true });
  const file = path.join(runDir(repo), `${lane.name}.mcp.json`);
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}

// Builds the INNER invocation for a step (what runs, before the runner axis wraps
// it — §11). `command` → the shell/argv, no auth env, no cost capture. `ai` → the
// provider-rendered argv, the profile's isolated auth env delta (`extraEnv`), and
// cost capture on (DESIGN §8, §9, §13). Throws on setup errors (unknown provider,
// missing profile/prompt); the scheduler catches those per lane so one
// misconfigured lane can't brick the tick. `workdir` is the isolation-resolved
// tree the step edits (the {repo} template var — .mcp.json is read from there);
// file-as-prompt still resolves against the MAIN repo's .tasks/, which never
// exists inside a worktree (it's gitignored). `mcpEnabled` is false under a
// non-local runner — the host taskherd-mcp can't run there (§11), so we don't
// hand the provider a --mcp-config at a host path that won't exist in the runner.
async function buildInvocation(repo, lane, step, resolvedConfig = {}, workdir = repo, { mcpEnabled = true, runnerKind = 'local' } = {}) {
  if (step.type !== 'ai') {
    const { file, args } = shellArgv(step, runnerKind);
    return {
      file, args, extraEnv: {}, captureCost: false,
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

  const mcpConfig = mcpEnabled ? await writeMcpConfig(repo, lane, workdir) : null;
  const inv = renderInvocation(provider, {
    task, model: resolvedConfig.model, permissionMode, maxTurns, session, repo: workdir, mcpConfig, mcp: mcpEnabled,
  });

  let extraEnv = {};
  const profileName = resolvedConfig.profile || step.profile;
  if (profileName) {
    const profile = await loadProfile(profileName);
    for (const w of isolationWarnings(profile)) {
      console.error(`taskherd: profile '${profileName}' ${w}`);
    }
    extraEnv = profileEnv(profile);
  }

  // Loud whenever an autonomous, un-gated permission model is in force (DESIGN §12).
  if (inv.permissionMode === 'bypassPermissions') {
    console.error(`taskherd: WARNING lane ${lane?.name} runs ${provider.command} with --permission-mode bypassPermissions (autonomous, no approval gate) — DESIGN §12`);
  }

  return {
    file: inv.command, args: inv.args, extraEnv, captureCost: inv.captureCost,
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
  // All three throw on setup errors, before the socket/log exist — the lane
  // parks. resolveRunner precedes buildInvocation because a non-local runner
  // suppresses the (host-only) taskherd-mcp wiring on the ai invocation (§11).
  const { isolation, workdir } = await resolveWorkdir(repo, lane, resolvedConfig || {});
  const runner = await resolveRunner(resolvedConfig?.runner);
  const invocation = await buildInvocation(repo, lane, step, resolvedConfig || {}, workdir, {
    mcpEnabled: runner.kind === 'local',
    runnerKind: runner.kind,
  });

  const id = randomUUID();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir(repo), `${lane.name}-${ts}.log`);
  ensureRuntimeDir();
  const sockPath = runSocketPath(repo, lane.name);
  const sockLink = runSocketLink(repo, lane.name);
  await rm(sockPath, { force: true });
  await rm(sockLink, { force: true });

  // The runner axis (§11) wraps the inner (provider/shell) invocation into the
  // OUTER argv the local pty actually runs: local = the step itself; docker/ssh =
  // a `docker exec|run` / `ssh` wrapper streaming a container/remote process
  // through the same pty seam. Auth env crosses secret-safely (docker `-e KEY`
  // by name; ssh not at all — the remote authenticates as itself). Warnings
  // (mcp-in-runner, unsynced ssh cwd) are loud, per DESIGN §1/§11.
  const { file: innerFile } = invocation; // the provider/shell command, for the cost message
  const spawnSpec = wrapForRunner(runner, {
    file: invocation.file,
    args: invocation.args,
    extraEnv: invocation.extraEnv,
    cwd: workdir,
    worktree: workdir,
    repo: path.resolve(repo),
    laneName: lane.name,
    isAi: step.type === 'ai',
    // Only the local runner forwards the taskherd escape-hatch vars — host paths
    // are meaningless inside a container / on a remote host.
    taskherdEnv: { TASKHERD_REPO: path.resolve(repo), TASKHERD_LANE: lane.name },
  });
  for (const w of spawnSpec.warnings) console.error(w);
  const { file, args } = spawnSpec;
  const logStream = createWriteStream(logPath);
  const clients = new Set();

  // Trailing output kept for cost-JSON parsing (ai steps only, DESIGN §10).
  let costCapture = invocation.captureCost ? '' : null;

  // Trailing output kept for the failure excerpt (all step types) — the tail is
  // where the operative error lands (a provider 429, a stack trace, `exit N`'s
  // preceding message). Surfaced on the parked gate so the console shows WHY a
  // lane died, not just "exit N — see log" (DESIGN §1: no silent failures).
  let tailBuf = '';

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
    // spawnSpec.cwd/env are the LOCAL pty child's — the step itself under
    // `local` (workdir + TASKHERD_REPO/LANE, as before), or the docker/ssh
    // client under a runner (auth values travel via `-e KEY` / not at all).
    cwd: spawnSpec.cwd,
    env: spawnSpec.env,
  });
  for (const msg of preSpawn.splice(0)) applyControl(msg);

  await appendEvent(repo, { event: 'run.start', lane: lane.name, step: index, id, argv: [file, ...args] });

  child.onData((data) => {
    logStream.write(data);
    if (costCapture !== null) {
      costCapture += data;
      if (costCapture.length > COST_CAPTURE_MAX) costCapture = costCapture.slice(-COST_CAPTURE_MAX);
    }
    tailBuf += data;
    if (tailBuf.length > TAIL_MAX_BYTES) tailBuf = tailBuf.slice(-TAIL_MAX_BYTES);
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

  const { exitCode, signal } = await new Promise((resolve) => {
    child.onExit(({ exitCode: code, signal: sig }) => resolve({ exitCode: code, signal: sig }));
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  const durationMs = Date.now() - startedAt;

  logStream.end();
  await appendEvent(repo, {
    event: 'run.exit', lane: lane.name, step: index, id, code: exitCode, ...(signal ? { signal } : {}), timedOut, durationMs,
  });
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

  // A signal-killed child reports {exitCode: 0, signal: N} from node-pty — a
  // bare exit-code check would mark an interrupted step (the console's
  // interrupt button, Ctrl-C over attach) as DONE and advance the cursor.
  const status = exitCode === 0 && !timedOut && !signal ? 'done' : 'failed';

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
      console.error(`FIDELITY-STANDIN: could not parse ${innerFile} cost JSON for lane ${lane.name} step ${index} — cost not logged (DESIGN §10)`);
    }
  }

  // §6 audit: the commit the step's tree ended on — meaningful only when git
  // isolation put the step on a taskherd/<lane> branch.
  const commit = isolation === 'none' ? null : await headCommit(workdir);

  // On failure, distill the operative error from the captured tail so the
  // parked gate can show it (DESIGN §1). Null on a clean run — nothing to say.
  const errorTail = status === 'done' ? null : extractErrorTail(tailBuf);

  return {
    status,
    exitCode: timedOut || signal ? null : exitCode, // 0-from-a-signal is not a real exit code
    signal: signal || null,
    timedOut,
    timeoutMs,
    durationMs,
    logPath,
    cost,
    tokens,
    sessionId,
    commit,
    errorTail,
  };
}
