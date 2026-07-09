// The `exit` probe executor (DESIGN §23 Phase 2). A `when` tree's one IMPURE
// leaf: run a command, compare its exit code. The scheduler executes probes
// SPECULATIVELY — each fire, for a step that is otherwise runnable — so the
// whole file is a §12 safety envelope around one spawn:
//   - mandatory timeout (default 30s) with SIGTERM → SIGKILL group escalation;
//   - fail-closed: spawn error / timeout / signal ⇒ code null ⇒ never satisfied,
//     logged loudly — a broken probe must never silently open a gate;
//   - opt-in per-rule `cache` TTL so a slow/costly probe result is reused across
//     fires instead of re-run each one (the last result is always RECORDED for
//     status/audit; it is only REUSED within the rule's TTL);
//   - the §11 runner axis (a probe can run in a container/remote), wrapped
//     tty-less — there is no pty behind a probe;
//   - a `when.probe` event per real execution (probes are code execution and
//     must leave a trail); cached reuse emits nothing.
// Probes must be cheap, idempotent, read-only checks — a documented contract,
// not something this code can enforce.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDir } from './paths.mjs';
import { resolveRunner, wrapForRunner } from './runners.mjs';
import {
  parseDurationMs, exitCodeMatches, describeWhen, probeKey,
} from './tasks.mjs';
import { appendEvent } from './events.mjs';

const PROBE_TIMEOUT_DEFAULT_MS = 30_000;
const PROBE_KILL_GRACE_MS = 5_000; // between the timeout SIGTERM and the SIGKILL
const PROBE_TAIL_BYTES = 2_048; // output kept for the event/diagnostics
const CACHE_KEEP_MS = 7 * 86_400_000; // prune last-result records older than this

function probeCacheFile(repo) {
  return join(runDir(repo), 'probe-cache.json');
}

// Last-result records keyed by probeKey: { code, timedOut, error, durationMs, at }.
// Ephemeral (safe to delete); only the scheduler writes it, under the repo lock.
export async function readProbeCache(repo) {
  try {
    return JSON.parse(await readFile(probeCacheFile(repo), 'utf8'));
  } catch {
    return {};
  }
}

async function writeProbeCache(repo, cache) {
  const now = Date.now();
  for (const [k, v] of Object.entries(cache)) {
    if (!v?.at || now - Date.parse(v.at) > CACHE_KEEP_MS) delete cache[k];
  }
  await mkdir(runDir(repo), { recursive: true });
  await writeFile(probeCacheFile(repo), `${JSON.stringify(cache, null, 2)}\n`);
}

// Runs one probe to completion. Resolves — NEVER rejects — with
// `{ code, timedOut, error, durationMs, at, tail }`; every failure mode lands as
// code:null (which exitCodeMatches never accepts). `run` strings use /bin/sh
// (a probe is a non-interactive check — predictable POSIX, not the user's
// $SHELL); cwd is the repo root (the step hasn't started, so there may not even
// be a worktree yet).
export async function executeExitProbe(rule, { repo }) {
  const started = Date.now();
  const finish = (partial) => ({
    code: null, timedOut: false, error: null, tail: null,
    durationMs: Date.now() - started, at: new Date().toISOString(), ...partial,
  });
  const timeoutMs = rule.timeout != null ? parseDurationMs(rule.timeout, 'timeout') : PROBE_TIMEOUT_DEFAULT_MS;
  let spec;
  try {
    const runner = await resolveRunner(rule.runner || 'local');
    const inner = rule.argv
      ? { file: rule.argv[0], args: rule.argv.slice(1) }
      : { file: '/bin/sh', args: ['-c', rule.run] };
    spec = wrapForRunner(runner, {
      ...inner, extraEnv: rule.env || {}, cwd: repo, repo, tty: false,
    });
    for (const w of spec.warnings || []) console.error(w);
  } catch (err) {
    return finish({ error: err.message });
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (res) => { if (!settled) { settled = true; resolve(res); } };
    let child;
    try {
      child = spawn(spec.file, spec.args, {
        cwd: spec.cwd || repo,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // own group, so escalation kills the tree
      });
    } catch (err) {
      return settle(finish({ error: err.message }));
    }
    let tail = '';
    const keep = (b) => { tail = (tail + String(b)).slice(-PROBE_TAIL_BYTES); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), PROBE_KILL_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer); clearTimeout(killTimer);
      settle(finish({ error: err.message, timedOut, tail: tail.trim() || null }));
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      settle(finish({
        code: (timedOut || signal) ? null : code,
        timedOut,
        error: signal && !timedOut ? `killed by signal ${signal}` : null,
        tail: tail.trim() || null,
      }));
    });
  });
}

// One probe session per scheduler tick. `probes` is the per-fire memo Map that
// resolveWhenProbes/evaluateGate consume (two lanes sharing a probe spec cost
// one execution per fire); `run` is the impure seam handed to resolveWhenProbes
// — it never throws (fail-closed); `flush()` persists the last-result records.
export async function createProbeSession(repo) {
  const cache = await readProbeCache(repo);
  const probes = new Map();
  let dirty = false;
  const run = async (rule, { lane } = {}) => {
    const label = describeWhen({ exit: rule });
    const key = probeKey(rule); // same canonical identity as the per-fire memo Map
    let res;
    try {
      // Opt-in TTL: reuse the recorded result while fresh. No `cache` ⇒ every
      // fire re-probes (a cron fire is minutes apart; probes are meant cheap).
      if (rule.cache != null) {
        const prev = cache[key];
        const ttl = parseDurationMs(rule.cache, 'cache');
        if (prev?.at && Date.now() - Date.parse(prev.at) < ttl) return prev;
      }
      res = await executeExitProbe(rule, { repo });
    } catch (err) {
      res = {
        code: null, timedOut: false, error: err.message, tail: null,
        durationMs: 0, at: new Date().toISOString(),
      };
    }
    const satisfied = exitCodeMatches(rule, res.code);
    if (res.error || res.timedOut) {
      // A probe that cannot report a code is treated as unsatisfied, never
      // satisfied — say so loudly (DESIGN §1/§12/§23).
      console.error(`taskherd: when.exit probe ${label} ${res.timedOut ? 'timed out' : `failed: ${res.error}`} — unsatisfied (fail-closed)`);
    }
    await appendEvent(repo, {
      event: 'when.probe',
      ...(lane ? { lane } : {}),
      probe: label,
      code: res.code,
      satisfied,
      timedOut: res.timedOut,
      ...(res.error ? { error: res.error } : {}),
      durationMs: res.durationMs,
    });
    cache[key] = res;
    dirty = true;
    return res;
  };
  const flush = async () => {
    if (!dirty) return;
    await writeProbeCache(repo, cache);
    dirty = false;
  };
  return { probes, run, flush };
}
