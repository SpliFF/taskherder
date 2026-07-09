// The scheduler (DESIGN.md §6) — fired once per cron/launchd tick, runs at
// most one step, and returns a summary of what it did (or why it didn't).
import {
  mkdir, rm, readFile, writeFile, stat, utimes,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  repoTasksDir, lockDir, lockPidFile, pausedFile, stateFile, needsAttentionFile,
} from './paths.mjs';
import {
  loadLane, loadAllLanesResilient, saveLane, nextAction, resolveStepConfig,
  defaultFallback, maybeLand, newLane, validateStep,
  evaluateGate, resolveWhenProbes, computeWaiting, detectWaitCycles,
} from './tasks.mjs';
import { createProbeSession } from './probes.mjs';
import { loadProjectConfig, loadUserConfig } from './config.mjs';
import { runStep, formatDuration } from './executor.mjs';
import { appendEvent } from './events.mjs';
import { appendHistory, readHistory } from './history.mjs';
import { checkDailyBudget, checkCumulativeBudget, checkPerRunBudget } from './budget.mjs';

const STALE_LOCK_MIN = 15;
const HEARTBEAT_MS = 60_000; // touch the lock mtime this often while a step runs

async function readState(repo) {
  try {
    return JSON.parse(await readFile(stateFile(repo), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { tick: 0 };
    throw err;
  }
}

async function writeState(repo, state) {
  await writeFile(stateFile(repo), `${JSON.stringify(state, null, 2)}\n`);
}

// Is the process that holds the lock still alive? Signal 0 delivers no signal
// but performs the existence/permission check. ENOENT (no pid file) or ESRCH
// (dead) => not alive; EPERM => alive but owned by another user.
async function lockPidAlive(repo) {
  try {
    const pid = Number((await readFile(lockPidFile(repo), 'utf8')).trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

// Atomic mkdir-based mutex. Returns true if acquired. A lock is only stolen as
// stale when BOTH its mtime is old AND its owner process is dead — a live run
// heartbeats the mtime (see startHeartbeat), so a step that legitimately runs
// longer than STALE_LOCK_MIN never gets its lock declared stale under it. This
// closes the §6-vs-§10 gap where a 45m timeout > 15m stale threshold guaranteed
// double-runs.
async function acquireLock(repo) {
  const dir = lockDir(repo);
  try {
    await mkdir(dir);
    await writeFile(lockPidFile(repo), `${process.pid}\n`);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const age = Date.now() - (await stat(dir)).mtimeMs;
  if (age > STALE_LOCK_MIN * 60_000 && !(await lockPidAlive(repo))) {
    await rm(dir, { recursive: true, force: true });
    try {
      await mkdir(dir);
      await writeFile(lockPidFile(repo), `${process.pid}\n`);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  }
  return false;
}

function startHeartbeat(repo) {
  const dir = lockDir(repo);
  const timer = setInterval(() => {
    const now = new Date();
    utimes(dir, now, now).catch(() => {}); // best-effort; dir may be gone on shutdown
  }, HEARTBEAT_MS);
  if (timer.unref) timer.unref(); // never keep a cron one-shot alive on our account
  return timer;
}

async function releaseLock(repo) {
  await rm(lockDir(repo), { recursive: true, force: true });
}

// One-line summary of a waiting lane's unmet dependencies, annotating the ones
// that point at nothing (typo / not-yet-enqueued) so a human can tell a normal
// pending wait from a broken reference.
function summarizeUnmet(unmet) {
  return unmet.map((u) => {
    if (u.reason === 'missing-lane') return `${u.ref} (no such lane)`;
    if (u.reason === 'missing-step') return `${u.ref} (not enqueued yet)`;
    return u.ref;
  }).join(', ');
}

async function writeNeedsAttention(repo, lanes, unloadable = [], waiting = []) {
  const blocked = lanes.filter((l) => l.status === 'blocked');
  if (blocked.length === 0 && unloadable.length === 0 && waiting.length === 0) {
    if (existsSync(needsAttentionFile(repo))) await rm(needsAttentionFile(repo), { force: true });
    return;
  }
  const lines = ['# Needs attention', ''];
  for (const lane of blocked) {
    const step = lane.steps[lane.cursor];
    // A budget-blocked lane whose gate is on a synthetic default step has no
    // step at cursor — fall back to lane.budgetBlock so the reason still shows.
    const reason = step
      ? (step.type === 'manual' ? step.message : (step.parkedReason || 'failed, parked for review'))
      : (lane.budgetBlock || 'blocked');
    lines.push(`- **${lane.name}** (step ${lane.cursor}): ${reason}`);
  }
  for (const bad of unloadable) {
    lines.push(`- **${bad.name}** (unloadable — fix or remove the lane file): ${bad.error}`);
  }
  // Only listed here when the herd has STALLED on these waits (DESIGN §22): a
  // normally-progressing wait shows in `status`, not as an attention item.
  for (const w of waiting) {
    lines.push(`- **${w.lane}** (step ${w.index}): waiting on ${summarizeUnmet(w.unmet)} — nothing can run; land the prerequisite or remove the dependency`);
  }
  await writeFile(needsAttentionFile(repo), `${lines.join('\n')}\n`);
}

// A stall: lanes sit waiting on unmet `waitsFor` deps while nothing else can run.
// Surface it loudly (DESIGN §1) — per-lane on stderr, a `waitsFor.stalled` event —
// and escalate a true dependency CYCLE to a named DEADLOCK, since that can never
// self-clear. Called only on a stalled fire, so it does not spam a healthy herd.
async function reportWaitStall(repo, waiting) {
  for (const w of waiting) {
    console.error(`taskherd: lane ${w.lane} waiting on ${summarizeUnmet(w.unmet)} — nothing else can run this fire (DESIGN §22)`);
  }
  const cycle = detectWaitCycles(waiting);
  if (cycle.length) {
    console.error(`taskherd: DEADLOCK — waitsFor cycle among [${cycle.join(', ')}]; ack or remove a dependency to break it`);
    await appendEvent(repo, { event: 'waitsFor.deadlock', cycle });
  } else {
    await appendEvent(repo, {
      event: 'waitsFor.stalled',
      waiting: waiting.map((w) => ({ lane: w.lane, unmet: w.unmet.map((u) => u.ref) })),
    });
  }
}

function describeFailure(result) {
  if (result.setupError) return `step could not start: ${result.setupError}`;
  const cause = result.timedOut
    ? `timed out after ${formatDuration(result.timeoutMs)}`
    : (result.signal ? `killed by signal ${result.signal}` : `exit ${result.exitCode}`);
  return `step failed twice (${cause}); see ${result.logPath}`;
}

// Budget gate (DESIGN §10). For the runnable ai steps, block those already over
// budget so fair-pick never even runs them: a daily cap SOFT-skips (returns for
// re-eval next tick, not persisted); a cumulative/per-run cap is a persistent
// lane gate. Returns the still-runnable subset.
async function gateBudgets(repo, runnable, history, nowIso) {
  const stillRunnable = [];
  for (const entry of runnable) {
    const { lane, action } = entry;
    if (action.step.type !== 'ai') { stillRunnable.push(entry); continue; }
    const cfg = await resolveStepConfig(repo, lane, action.step);

    const daily = checkDailyBudget(cfg.budget, history, lane.name, nowIso);
    if (daily) {
      console.error(`taskherd: lane ${lane.name} skipped — ${daily}`);
      continue; // soft: not persisted, runnable again once the day rolls
    }
    const cumulative = checkCumulativeBudget(cfg.budget, history, lane.name);
    if (cumulative) {
      if (entry.synthetic) {
        // The zero-config default has no lane file to persist a gate on; a
        // loud per-tick skip still enforces the cap (history-based).
        console.error(`taskherd: default step skipped — ${cumulative}`);
        continue;
      }
      const fresh = await loadLane(repo, lane.name);
      if (action.kind === 'step' && fresh.steps[action.index]) {
        fresh.steps[action.index].status = 'failed';
        fresh.steps[action.index].parkedReason = cumulative;
      }
      fresh.status = 'blocked';
      fresh.budgetBlock = cumulative;
      await saveLane(repo, fresh);
      await appendEvent(repo, {
        event: 'gate.blocked', lane: lane.name, step: action.index, reason: cumulative,
      });
      continue;
    }
    stillRunnable.push(entry);
  }
  return stillRunnable;
}

// Scans all lanes, transitioning any lane whose next action is a freshly
// reached manual gate from pending -> blocked (DESIGN §6 step 2). Returns the
// set of lanes still eligible to run this tick.
async function scanAndGate(repo, lanes, fallback, now, probeSession) {
  const runnable = [];
  const byName = Object.fromEntries(lanes.map((l) => [l.name, l]));
  for (const lane of lanes) {
    const action = nextAction(lane, fallback);
    if (action.kind === 'idle') continue;
    if (action.kind === 'step' && action.step.status === 'blocked') continue; // already gated
    if (action.kind === 'step' && action.step.status === 'failed') continue; // parked failure
    // Preconditions (DESIGN §22 `waitsFor` + §23 `when`): a step whose deps/rules
    // aren't satisfied is skipped SOFTLY — no gate, no ack, nothing persisted. It
    // re-checks every fire and becomes runnable the instant the world satisfies
    // it (a dep lands, a time window opens). Evaluated before the manual-gate
    // transition, so a gate with unmet preconditions doesn't even surface as an
    // open gate until its prerequisites are met.
    // Any §23 `exit` probes the gate's outcome actually depends on run first —
    // memoized per fire in probeSession.probes, skipped entirely when waitsFor
    // or a free window/dep leg already decides the gate (short-circuit-by-cost).
    await resolveWhenProbes(
      action.step,
      { selfLane: lane.name, lanesByName: byName, now, probes: probeSession.probes },
      (rule) => probeSession.run(rule, { lane: lane.name }),
    );
    if (!evaluateGate(action.step, lane.name, byName, now, probeSession.probes).satisfied) continue;
    if (action.kind === 'step' && action.step.type === 'manual' && action.step.status === 'pending') {
      action.step.status = 'blocked';
      lane.status = 'blocked';
      await saveLane(repo, lane);
      await appendEvent(repo, {
        event: 'gate.blocked', lane: lane.name, step: action.index, reason: action.step.message || 'manual gate',
      });
      continue;
    }
    runnable.push({ lane, action });
  }
  return runnable;
}

function fairPick(candidates) {
  return [...candidates].sort((a, b) => {
    const byLastRun = (a.lane.lastRun || 0) - (b.lane.lastRun || 0);
    if (byLastRun !== 0) return byLastRun;
    return a.lane.name.localeCompare(b.lane.name);
  })[0];
}

// Why a targeted lane (`taskherd run --lane X`) had nothing to run this fire —
// so a manual, one-lane run reports the actual cause (blocked/idle/missing)
// instead of a bare "nothing happened". `lanes`/`unloadable` are the freshest
// post-scan snapshot; `fallback` resolves an idle lane's onEmpty action.
function explainLaneUnrunnable(name, lanes, unloadable, fallback, now, probes = null) {
  const bad = unloadable.find((u) => u.name === name);
  if (bad) return `its lane file is unloadable: ${bad.error}`;
  const lane = lanes.find((l) => l.name === name);
  if (!lane) return 'no such lane';
  if (lane.status === 'blocked') {
    const step = lane.steps[lane.cursor];
    if (lane.budgetBlock) return `blocked on budget (${lane.budgetBlock}) — raise the cap or \`taskherd ack ${name}\``;
    if (step && step.status === 'failed') return `parked on a failure — \`taskherd ack ${name}\` to retry`;
    return `blocked on a gate — \`taskherd ack ${name}\` to continue`;
  }
  const action = nextAction(lane, fallback);
  if (action.kind === 'idle') return 'nothing queued to run';
  const byName = Object.fromEntries(lanes.map((l) => [l.name, l]));
  const { satisfied, unmet } = evaluateGate(action.step, name, byName, now, probes);
  if (!satisfied) {
    if (unmet.every((u) => u.reason === 'window')) {
      return `waiting on ${summarizeUnmet(unmet)} — runs once the window opens (DESIGN §23)`;
    }
    if (unmet.every((u) => u.reason === 'window' || u.reason === 'probe')) {
      return `waiting on ${summarizeUnmet(unmet)} — runs once the probe passes (DESIGN §23)`;
    }
    return `waiting on ${summarizeUnmet(unmet)} — runs once the dependency lands (DESIGN §22/§23)`;
  }
  return 'skipped this fire (most likely a daily budget cap)';
}

// A normal fire (no `lane`) fair-picks one runnable lane across the repo; a
// targeted fire (`{ lane }`, the CLI's `run --lane X`) narrows the pick to that
// one lane's next step. Every guardrail — pause, the per-repo mutex, gate and
// budget checks, retry/park — is identical either way; only the pick differs.
export async function tick(repo, { lane: targetLane = null, force = false } = {}) {
  const paused = existsSync(pausedFile(repo));
  if (paused && !force) {
    return { outcome: 'paused' };
  }
  if (paused && force) {
    // The pause switch is a §12 kill-switch; overriding it is a deliberate
    // manual act (a console RUN / `run --force`) and must be loud + greppable.
    console.error(`taskherd: WARNING --force overriding PAUSE for ${targetLane ? `lane '${targetLane}'` : repo} — running while the herd is paused (DESIGN §12)`);
  }
  if (!existsSync(repoTasksDir(repo))) {
    return { outcome: 'no-tasks-dir' };
  }
  if (!(await acquireLock(repo))) {
    return { outcome: 'locked' };
  }
  const heartbeat = startHeartbeat(repo);

  try {
    const { lanes, unloadable } = await loadAllLanesResilient(repo);
    for (const bad of unloadable) {
      // Loud + greppable; a single bad lane file must not brick every tick (DESIGN §1).
      console.error(`taskherd: lane ${bad.name} unloadable: ${bad.error}`);
    }
    const [projectConfig, userConfig] = await Promise.all([loadProjectConfig(repo), loadUserConfig()]);
    const fallback = defaultFallback(projectConfig, userConfig);
    const now = new Date();
    // §23 `exit` probes run inside this tick only — one session per fire, results
    // memoized across lanes, last results persisted (and TTL-reused) via flush().
    // PAUSED returned above, so a paused repo is never probed.
    const probeSession = await createProbeSession(repo);
    const gated = await scanAndGate(repo, lanes, fallback, now, probeSession);
    await probeSession.flush();
    const nowIso = now.toISOString();
    const history = await readHistory(repo);
    let runnable = await gateBudgets(repo, gated, history, nowIso);
    // gateBudgets may have re-blocked lanes on disk; re-read for an accurate list.
    const attention = await loadAllLanesResilient(repo);

    // DESIGN §6 fallback (deferred from M2): a repo with no lane files at all
    // still runs the configured default once per fire — zero-config scheduled
    // use. Synthetic: nothing is persisted to a lane file.
    if (runnable.length === 0 && lanes.length === 0 && unloadable.length === 0 && fallback.default) {
      try {
        const { onEmpty: _configMarker, ...defStep } = fallback.default;
        const step = validateStep({ ...defStep, status: 'pending' });
        const candidate = {
          lane: newLane('default'),
          action: { kind: 'default', step, index: 0 },
          synthetic: true,
        };
        runnable = await gateBudgets(repo, [candidate], history, nowIso);
      } catch (err) {
        console.error(`taskherd: configured default step is invalid, not running it: ${err.message}`);
      }
    }

    // Cross-lane wait surfacing (DESIGN §22). Now that every runnable source is
    // accounted for (queued steps, budgets, the zero-config default), decide if
    // the herd has STALLED: lanes waiting on unmet deps while nothing can run.
    // A stall is reported loudly + escalated to NEEDS-ATTENTION (a true cycle
    // becomes a named deadlock); a normal, still-progressing wait shows only in
    // `status`. Computed repo-wide, before any targeted-run narrowing below.
    const waiting = computeWaiting(attention.lanes, fallback, now, probeSession.probes);
    // A `window` wait (DESIGN §23) is a SCHEDULED future run, not a stall — an
    // off-hours cron fire that legitimately runs nothing must not read as a
    // deadlock. A `probe` wait is likewise a poll of the outside world that the
    // next fire re-checks (v1 = pure soft; escalation after N failing fires is a
    // recorded open question). Only dep-style waits (which may never self-clear)
    // count toward a stall / NEEDS-ATTENTION; window/probe waits show only in
    // `status`.
    const depWaiting = waiting.filter((w) => w.unmet.some((u) => u.reason !== 'window' && u.reason !== 'probe'));
    const stalled = depWaiting.length > 0 && runnable.length === 0;
    if (stalled) await reportWaitStall(repo, depWaiting);
    await writeNeedsAttention(repo, attention.lanes, attention.unloadable, stalled ? depWaiting : []);

    // Targeted manual run: keep only the named lane's candidate. If it isn't
    // runnable, say why (blocked/idle/missing) rather than a generic 'idle'.
    if (targetLane) {
      const chosen = runnable.filter((entry) => entry.lane.name === targetLane);
      if (chosen.length === 0) {
        return {
          outcome: 'not-runnable',
          lane: targetLane,
          reason: explainLaneUnrunnable(targetLane, attention.lanes, attention.unloadable, fallback, now, probeSession.probes),
        };
      }
      runnable = chosen;
    }

    if (runnable.length === 0) {
      return { outcome: 'idle', lanes: lanes.length, unloadable: unloadable.length };
    }

    const { lane, action, synthetic } = fairPick(runnable);
    const state = await readState(repo);
    state.tick = (state.tick || 0) + 1;

    const step = action.step;
    const resolvedConfig = await resolveStepConfig(repo, lane, step);
    let result;
    try {
      result = await runStep(repo, lane, step, action.index, resolvedConfig);
    } catch (err) {
      // Setup failure (unknown provider, missing profile/prompt, unparseable
      // timeout). Loud + greppable; a misconfigured lane parks itself as a gate
      // rather than crashing the tick (bug #5 philosophy, extended to run time).
      console.error(`taskherd: lane ${lane.name} step ${action.index} could not start: ${err.message}`);
      result = {
        status: 'failed',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        logPath: null,
        cost: null,
        tokens: null,
        sessionId: null,
        setupError: err.message,
      };
    }

    // Re-load the lane from disk before writing back, then patch ONLY what this
    // run changed (by index). The snapshot in `lane` predates a possibly-long
    // run; any concurrent `taskherd add`/`ack`/`block` wrote to disk meanwhile
    // and must not be clobbered by re-saving the stale whole-lane snapshot (bug #2).
    // A synthetic zero-config default has no lane file — nothing to persist.
    if (!synthetic) {
      const fresh = await loadLane(repo, lane.name);
      if (action.kind === 'step') {
        const freshStep = fresh.steps[action.index];
        if (result.status === 'done') {
          if (freshStep) freshStep.status = 'done';
          fresh.cursor = action.index + 1;
        } else if (freshStep) {
          freshStep.attempts = (freshStep.attempts || 0) + 1;
          // A setup error is a config problem — retrying it is pointless, so park
          // on the first failure instead of burning a second tick.
          if (freshStep.attempts < 2 && !result.setupError) {
            freshStep.status = 'pending'; // one retry, on a future fire
          } else {
            freshStep.status = 'failed';
            freshStep.parkedReason = describeFailure(result);
            // The distilled tail of the run's output (a provider 429, a stack
            // trace) — the console surfaces this so a human sees WHY it died,
            // not just the exit code. Absent on a setup error (never spawned).
            if (result.errorTail) freshStep.error = result.errorTail;
            else delete freshStep.error;
            fresh.status = 'blocked';
            await appendEvent(repo, {
              event: 'gate.blocked', kind: 'failure', lane: fresh.name, step: action.index, reason: freshStep.parkedReason,
            });
          }
        }
      }
      // Carry an ai session across fires (DESIGN §8) and surface the last cost.
      if (result.sessionId) fresh.session = { id: result.sessionId };
      if (result.cost != null) fresh.lastCost = result.cost;

      // Per-run budget (DESIGN §10): a run that overspent its per-run cap can't be
      // predicted, so it blocks the lane after the fact — even on a successful run.
      if (result.status === 'done' && result.cost != null) {
        const perRun = checkPerRunBudget(resolvedConfig.budget, result.cost);
        if (perRun) {
          fresh.status = 'blocked';
          fresh.budgetBlock = perRun;
          if (action.kind === 'step' && fresh.steps[action.index]) {
            fresh.steps[action.index].parkedReason = perRun;
          }
          await appendEvent(repo, {
            event: 'gate.blocked', lane: fresh.name, step: action.index, reason: perRun,
          });
        }
      }

      // Land (DESIGN §7): a lane that just completed its queue with commits on
      // its taskherd/<lane> branch lands per policy (gate/pr/leave). Recurring
      // onEmpty-default lanes never complete, so they never land here.
      if (action.kind === 'step' && result.status === 'done'
          && fresh.status !== 'blocked' && fresh.cursor >= fresh.steps.length) {
        await maybeLand(repo, fresh);
      }

      // action.kind === 'default': synthetic step, not persisted — but the lane's
      // lastRun below still must advance so fair-pick keeps rotating.
      fresh.lastRun = state.tick;
      await saveLane(repo, fresh);
    }
    await writeState(repo, state);

    const after = await loadAllLanesResilient(repo);
    await writeNeedsAttention(repo, after.lanes, after.unloadable);

    await appendHistory(repo, {
      lane: lane.name,
      step: action.index,
      kind: action.kind,
      type: step.type,
      result: result.status,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      logPath: result.logPath,
      ...(result.cost != null ? { cost: result.cost } : {}),
      ...(result.tokens && (result.tokens.input != null || result.tokens.output != null)
        ? { tokens: result.tokens } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.commit ? { commit: result.commit } : {}),
    });

    return {
      outcome: 'ran', lane: lane.name, step: action.index, result: result.status, cost: result.cost ?? null,
    };
  } finally {
    clearInterval(heartbeat);
    await releaseLock(repo);
  }
}
