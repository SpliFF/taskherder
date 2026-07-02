// The scheduler (DESIGN.md §6) — fired once per cron/launchd tick, runs at
// most one step, and returns a summary of what it did (or why it didn't).
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  repoTasksDir, lockDir, pausedFile, stateFile, needsAttentionFile,
} from './paths.mjs';
import {
  loadAllLanes, saveLane, nextAction, resolveStepConfig,
} from './tasks.mjs';
import { runStep } from './executor.mjs';
import { appendHistory } from './history.mjs';

const STALE_LOCK_MIN = 15;

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

// Atomic mkdir-based mutex. Returns true if acquired.
async function acquireLock(repo) {
  const dir = lockDir(repo);
  try {
    await mkdir(dir);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const age = Date.now() - (await stat(dir)).mtimeMs;
  if (age > STALE_LOCK_MIN * 60_000) {
    await rm(dir, { recursive: true, force: true });
    try {
      await mkdir(dir);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  }
  return false;
}

async function releaseLock(repo) {
  await rm(lockDir(repo), { recursive: true, force: true });
}

async function writeNeedsAttention(repo, lanes) {
  const blocked = lanes.filter((l) => l.status === 'blocked');
  if (blocked.length === 0) {
    if (existsSync(needsAttentionFile(repo))) await rm(needsAttentionFile(repo), { force: true });
    return;
  }
  const lines = ['# Needs attention', ''];
  for (const lane of blocked) {
    const step = lane.steps[lane.cursor];
    const reason = step ? (step.type === 'manual' ? step.message : (step.parkedReason || 'failed, parked for review')) : 'blocked';
    lines.push(`- **${lane.name}** (step ${lane.cursor}): ${reason}`);
  }
  await writeFile(needsAttentionFile(repo), `${lines.join('\n')}\n`);
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

  try {
    const lanes = await loadAllLanes(repo);
    const runnable = await scanAndGate(repo, lanes);
    await writeNeedsAttention(repo, lanes); // reflects any lane scanAndGate just gated

    if (runnable.length === 0) {
      return { outcome: 'idle', lanes: lanes.length };
    }

    const { lane, action } = fairPick(runnable);
    const state = await readState(repo);
    state.tick = (state.tick || 0) + 1;

    const step = action.step;
    const resolvedConfig = await resolveStepConfig(repo, lane, step);
    const result = await runStep(repo, lane, step, action.index, resolvedConfig);

    if (action.kind === 'step') {
      if (result.status === 'done') {
        step.status = 'done';
        lane.cursor += 1;
      } else {
        step.attempts = (step.attempts || 0) + 1;
        if (step.attempts < 2) {
          step.status = 'pending'; // one retry, on a future fire
        } else {
          step.status = 'failed';
          step.parkedReason = `command failed twice (exit ${result.exitCode}); see ${result.logPath}`;
          lane.status = 'blocked';
        }
      }
    }
    // action.kind === 'default': synthetic step, not persisted regardless of outcome.

    lane.lastRun = state.tick;
    await saveLane(repo, lane);
    await writeState(repo, state);
    await writeNeedsAttention(repo, lanes); // `lane` is the same object referenced in `lanes`

    await appendHistory(repo, {
      lane: lane.name,
      step: action.index,
      kind: action.kind,
      result: result.status,
      exitCode: result.exitCode,
      logPath: result.logPath,
    });

    return { outcome: 'ran', lane: lane.name, step: action.index, result: result.status };
  } finally {
    await releaseLock(repo);
  }
}
