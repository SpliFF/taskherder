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
import { appendHistory } from './history.mjs';

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
    const reason = step ? (step.type === 'manual' ? step.message : (step.parkedReason || 'failed, parked for review')) : 'blocked';
    lines.push(`- **${lane.name}** (step ${lane.cursor}): ${reason}`);
  }
  for (const bad of unloadable) {
    lines.push(`- **${bad.name}** (unloadable — fix or remove the lane file): ${bad.error}`);
  }
  await writeFile(needsAttentionFile(repo), `${lines.join('\n')}\n`);
}

function describeFailure(result) {
  const cause = result.timedOut
    ? `timed out after ${formatDuration(result.timeoutMs)}`
    : `exit ${result.exitCode}`;
  return `command failed twice (${cause}); see ${result.logPath}`;
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
    const runnable = await scanAndGate(repo, lanes);
    await writeNeedsAttention(repo, lanes, unloadable); // reflects gated + unloadable lanes

    if (runnable.length === 0) {
      return { outcome: 'idle', lanes: lanes.length, unloadable: unloadable.length };
    }

    const { lane, action } = fairPick(runnable);
    const state = await readState(repo);
    state.tick = (state.tick || 0) + 1;

    const step = action.step;
    const resolvedConfig = await resolveStepConfig(repo, lane, step);
    const result = await runStep(repo, lane, step, action.index, resolvedConfig);

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
        if (freshStep.attempts < 2) {
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
      result: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      logPath: result.logPath,
    });

    return { outcome: 'ran', lane: lane.name, step: action.index, result: result.status };
  } finally {
    clearInterval(heartbeat);
    await releaseLock(repo);
  }
}
