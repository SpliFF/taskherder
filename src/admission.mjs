// Parallel lanes — admission control (DESIGN §25). The lane is the unit of
// parallelism: steps within a lane stay serial (the cursor); independent lanes
// may run concurrently when that is provably safe. This module owns the two
// halves of that decision:
//
//   1. The RUNNING SET — per-run manifests at `.tasks/run/<lane>.json`, written
//      when a lane is admitted and removed when its step exits, staleness-
//      checked exactly like the scheduler lock (mtime heartbeat + kill(pid, 0)).
//   2. The ADMISSION PREDICATE — a pure function (unit-testable like
//      evaluateWaits) deciding whether a candidate lane may start alongside
//      the live set: isolated-only, `parallel:false` takes the serial slot,
//      `mutex` disjointness, `inplace`/`none` exclusivity, the `max` cap.
//
// Fail-closed rule (§25 rule 1 / §1 / §12): anything unreadable or ambiguous
// about the running set means "serialize this fire, loudly" — never a silent
// concurrent run.
import {
  readFile, writeFile, rename, rm, readdir, stat, utimes,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { resolveConfig } from './config.mjs';
import { resolveRunner } from './runners.mjs';

// Same staleness discipline as the scheduler lock: a manifest is only reaped
// when BOTH its mtime is old (the supervising process heartbeats it) AND its
// pid is dead. Fresh-mtime-but-dead-pid stays counted (fail closed) and
// self-clears once the heartbeat window ages out.
const STALE_MANIFEST_MIN = 15;
const HEARTBEAT_MS = 60_000;

// Files in .tasks/run/ that are NOT run manifests: per-run mcp configs
// (<lane>.mcp.json), the §23 probe cache, and live-socket symlinks (filtered
// by extension). Mirrors listLaneNames' config.json/state.json exclusions.
function isManifestFile(f) {
  return f.endsWith('.json') && !f.endsWith('.mcp.json') && f !== 'probe-cache.json';
}

export function runManifestFile(repo, laneName) {
  return path.join(runDir(repo), `${laneName}.json`);
}

// The repo-level parallelism cap (DESIGN §25): `.tasks/config.json`
// `"parallel": { "max": N }`. Absent ⇒ 1 (fully serial, today's behavior).
// Malformed throws loudly — the caller fails closed to serial (§25 rule 1),
// never silently runs concurrently on a config typo.
export function parallelMax(projectConfig = {}) {
  const p = projectConfig?.parallel;
  if (p == null) return 1;
  if (typeof p !== 'object' || Array.isArray(p)) {
    throw new Error(`taskherd: config \`parallel\` must be an object like {"max": 2}, got ${JSON.stringify(p)} (DESIGN §25)`);
  }
  const max = p.max;
  if (max == null) return 1;
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`taskherd: config parallel.max must be an integer >= 1, got ${JSON.stringify(max)} (DESIGN §25)`);
  }
  return max;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, owned by another user
  }
}

// Writes the admitted lane's manifest — under the admission lock, BEFORE the
// step spawns, so a second overlapping fire already sees the slot taken.
// Atomic (tmp + rename) so a concurrent reader never parses a half-written
// manifest as "invalid" and needlessly serializes a healthy herd.
export async function writeRunManifest(repo, manifest) {
  const file = runManifestFile(repo, manifest.lane);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...manifest }, null, 2)}\n`);
  await rename(tmp, file);
  return file;
}

export async function removeRunManifest(repo, laneName) {
  await rm(runManifestFile(repo, laneName), { force: true });
}

// While the admitted step runs (supervised outside the lock), keep the
// manifest's mtime fresh so a legitimately long run is never reaped as stale
// under a concurrent fire — the same guarantee the lock heartbeat gives.
export function startManifestHeartbeat(repo, laneName) {
  const file = runManifestFile(repo, laneName);
  const timer = setInterval(() => {
    const now = new Date();
    utimes(file, now, now).catch(() => {}); // best-effort; file is gone on shutdown
  }, HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  return timer;
}

// Reads the running set from `.tasks/run/*.json`. Returns
//   { running, invalid, reaped }
// where `running` are live manifests, `invalid` are unreadable/misshapen files
// (callers must fail closed to serial on any — §25 rule 1), and `reaped` are
// stale manifests (old mtime + dead pid) that were removed (with reap:true) —
// a crashed supervisor's leftover must not block admission forever, exactly
// like a stale lock. reap:false (status, a read-only surface) only excludes.
export async function readRunningSet(repo, { reap = true } = {}) {
  const dir = runDir(repo);
  const running = [];
  const invalid = [];
  const reaped = [];
  if (!existsSync(dir)) return { running, invalid, reaped };
  for (const f of await readdir(dir)) {
    if (!isManifestFile(f)) continue;
    const file = path.join(dir, f);
    let manifest = null;
    let mtimeMs = 0;
    try {
      const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      mtimeMs = st.mtimeMs;
      manifest = JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // removed between readdir and read — a run just exited
      invalid.push({ file: f, error: err.message });
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || typeof manifest.lane !== 'string' || !Number.isInteger(manifest.pid)) {
      invalid.push({ file: f, error: 'not a run manifest (needs lane + pid) — remove the stray file' });
      continue;
    }
    const stale = Date.now() - mtimeMs > STALE_MANIFEST_MIN * 60_000 && !pidAlive(manifest.pid);
    if (stale) {
      if (reap) await rm(file, { force: true });
      reaped.push(manifest);
      continue;
    }
    running.push(manifest);
  }
  return { running, invalid, reaped };
}

// ── the predicate ───────────────────────────────────────────────────────────

// The master gate is isolation (§7/§25): only a lane whose step runs in its
// own tree — `worktree` isolation, or off-host via a docker:/ssh: runner — is
// a parallel candidate. `inplace`/`none` share the live checkout.
export function isIsolated({ isolation, runnerKind }) {
  return isolation === 'worktree' || runnerKind === 'docker' || runnerKind === 'ssh';
}

// A live run that must have the herd to itself: an unisolated lane, or one
// marked `parallel:false` (it took the serial slot). Nothing is admitted
// alongside it.
export function isExclusive(m) {
  return !isIsolated(m) || m.parallel === false;
}

// Pure admission decision for ONE candidate against the live running set.
// Both sides carry the same facts: { lane, isolation, runnerKind, parallel,
// mutex }. Returns { ok: true } or { ok: false, reason, blockers } where
// `blockers` names the live lanes holding it back (for "serialized: waiting
// on …" surfacing — a soft wait, never NEEDS-ATTENTION, §25 rule 3).
export function admissible(cand, running, max) {
  if (running.length === 0) return { ok: true }; // alone, anything runs — serial semantics
  const names = running.map((m) => m.lane);
  const exclusive = running.filter((m) => isExclusive(m));
  if (exclusive.length) {
    return { ok: false, reason: 'exclusive', blockers: exclusive.map((m) => m.lane) };
  }
  if (!isIsolated(cand)) {
    return { ok: false, reason: 'not-isolated', blockers: names };
  }
  if (cand.parallel === false) {
    return { ok: false, reason: 'serial-lane', blockers: names };
  }
  const candTags = new Set(cand.mutex || []);
  if (candTags.size) {
    const clash = running.filter((m) => (m.mutex || []).some((t) => candTags.has(t)));
    if (clash.length) {
      const tags = [...new Set(clash.flatMap((m) => (m.mutex || []).filter((t) => candTags.has(t))))];
      return {
        ok: false, reason: 'mutex', blockers: clash.map((m) => m.lane), tags,
      };
    }
  }
  if (running.length + 1 > max) {
    return { ok: false, reason: 'capacity', blockers: names, max };
  }
  return { ok: true };
}

// One human line for a held-back lane — shared by the scheduler's targeted-run
// explanation, `status`, and the console, so the wording can't drift.
export function describeHold(verdict) {
  const who = [...new Set(verdict.blockers || [])].join(', ');
  switch (verdict.reason) {
    case 'exclusive': return `serialized: waiting on ${who} (it runs exclusively — unisolated or parallel:false)`;
    case 'not-isolated': return `serialized: waiting on ${who} (this lane is not isolated — inplace/none runs alone)`;
    case 'serial-lane': return `serialized: waiting on ${who} (this lane is parallel:false — it takes the serial slot)`;
    case 'mutex': return `serialized: waiting on ${who} (shared mutex ${verdict.tags.map((t) => `'${t}'`).join(', ')})`;
    case 'capacity': return `serialized: waiting on ${who} (parallel.max ${verdict.max} reached)`;
    default: return `serialized: waiting on ${who}`;
  }
}

// Resolves the admission-relevant facts for a candidate lane's next step,
// mirroring the executor's own resolution (resolveWorkdir's isolation default,
// resolveRunner's kind) so what admission reasons about is what will actually
// run. A runner that fails to resolve is treated as LOCAL (conservative: an
// unisolated candidate only ever runs alone) — the step itself will park with
// the real setup error when it runs.
export async function candidateFacts(repo, lane, step, projectConfig, userConfig, { gitRepo }) {
  const cfg = resolveConfig(step, lane, projectConfig, userConfig);
  const isolation = cfg.isolation ?? (gitRepo ? 'worktree' : 'none');
  let runnerKind = 'local';
  try {
    runnerKind = (await resolveRunner(cfg.runner)).kind;
  } catch {
    // loud at run time (the lane parks); here we only need a safe answer
  }
  return {
    lane: lane.name,
    isolation,
    runnerKind,
    parallel: lane.parallel === false ? false : null,
    mutex: Array.isArray(lane.mutex) ? lane.mutex : [],
  };
}
