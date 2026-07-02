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
} from './tasks.mjs';
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

async function writeNeedsAttention(repo, lanes, unloadable = []) {
  const blocked = lanes.filter((l) => l.status === 'blocked');
  if (blocked.length === 0 && unloadable.length === 0) {
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
  await writeFile(needsAttentionFile(repo), `${lines.join('\n')}\n`);
}

function describeFailure(result) {
  if (result.setupError) return `step could not start: ${result.setupError}`;
  const cause = result.timedOut
    ? `timed out after ${formatDuration(result.timeoutMs)}`
    : `exit ${result.exitCode}`;
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
async function scanAndGate(repo, lanes) {
  const runnable = [];
  for (const lane of lanes) {
    const action = nextAction(lane);
    if (action.kind === 'idle') continue;
    if (action.kind === 'step' && action.step.status === 'blocked') continue; // already gated
    if (action.kind === 'step' && action.step.status === 'failed') continue; // parked failure
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

export async function tick(repo) {
  if (existsSync(pausedFile(repo))) {
    return { outcome: 'paused' };
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
    const gated = await scanAndGate(repo, lanes);
    const nowIso = new Date().toISOString();
    const history = await readHistory(repo);
    const runnable = await gateBudgets(repo, gated, history, nowIso);
    // gateBudgets may have re-blocked lanes on disk; re-read for an accurate list.
    const attention = await loadAllLanesResilient(repo);
    await writeNeedsAttention(repo, attention.lanes, attention.unloadable);

    if (runnable.length === 0) {
      return { outcome: 'idle', lanes: lanes.length, unloadable: unloadable.length };
    }

    const { lane, action } = fairPick(runnable);
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
          fresh.status = 'blocked';
          await appendEvent(repo, {
            event: 'gate.blocked', lane: fresh.name, step: action.index, reason: freshStep.parkedReason,
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
    // action.kind === 'default': synthetic step, not persisted — but the lane's
    // lastRun below still must advance so fair-pick keeps rotating.
    fresh.lastRun = state.tick;
    await saveLane(repo, fresh);
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
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      logPath: result.logPath,
      ...(result.cost != null ? { cost: result.cost } : {}),
      ...(result.tokens && (result.tokens.input != null || result.tokens.output != null)
        ? { tokens: result.tokens } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    });

    return {
      outcome: 'ran', lane: lane.name, step: action.index, result: result.status, cost: result.cost ?? null,
    };
  } finally {
    clearInterval(heartbeat);
    await releaseLock(repo);
  }
}
