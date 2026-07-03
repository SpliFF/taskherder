// Lane store (DESIGN.md §5): load/save lane files, the five-axis step model
// (command + manual only this milestone — ai lands in M2), config inheritance.
import {
  mkdir, readFile, writeFile, readdir, appendFile, rename,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  repoTasksDir, laneFile, projectConfigFile, logsDir, descDir, runDir,
  taskherdHome, runSocketLink,
} from './paths.mjs';
import { loadProjectConfig, loadUserConfig, resolveConfig } from './config.mjs';
import { registerProject } from './registry.mjs';
import {
  isGitRepo, laneBranch, branchExists, branchBase, defaultBase, aheadCount,
  landMerge, pushAndOpenPr,
} from './git.mjs';
import { appendEvent } from './events.mjs';

const execFileAsync = promisify(execFile);

const STEP_TYPES = ['command', 'ai', 'manual'];

export class LaneValidationError extends Error {}

export function validateStep(step) {
  if (!step || typeof step !== 'object') {
    throw new LaneValidationError(`taskherd: step must be an object, got ${JSON.stringify(step)}`);
  }
  if (!STEP_TYPES.includes(step.type)) {
    throw new LaneValidationError(
      `taskherd: unsupported step type ${JSON.stringify(step.type)} (supported: ${STEP_TYPES.join(', ')})`,
    );
  }
  if (step.type === 'command' && !step.run && !step.argv) {
    throw new LaneValidationError('taskherd: command step needs `run` (shell string) or `argv` (array)');
  }
  // `provider` is resolved by inheritance (step → lane → config) at run time, so
  // it is NOT required here — only a prompt source is (DESIGN §5, §8).
  if (step.type === 'ai' && !step.task && !step.file) {
    throw new LaneValidationError('taskherd: ai step needs a `task` (prompt string) or `file` (file-as-prompt path)');
  }
  if (step.type === 'manual' && !step.message) {
    throw new LaneValidationError('taskherd: manual step needs `message`');
  }
  return step;
}

// Axis fields default to null = inherit (step → lane → project → user config,
// DESIGN §5). M1 hardcoded 'none'/'manual-gate'/'local' here, which silently
// pinned every lane and defeated project-level defaults — now only an explicit
// value overrides.
export function newLane(name, overrides = {}) {
  return {
    name,
    parent: null,
    onEmpty: null,
    default: null,
    isolation: null,
    land: null,
    profile: null,
    runner: null,
    provider: null,
    cursor: 0,
    lastRun: 0,
    status: 'idle',
    steps: [],
    ...overrides,
  };
}

export async function laneExists(repo, name) {
  return existsSync(laneFile(repo, name));
}

export async function listLaneNames(repo) {
  const dir = repoTasksDir(repo);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith('.json') && f !== 'config.json' && f !== 'state.json')
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export async function loadLane(repo, name) {
  const raw = await readFile(laneFile(repo, name), 'utf8');
  let lane;
  try {
    lane = JSON.parse(raw);
  } catch (err) {
    throw new LaneValidationError(`taskherd: malformed lane JSON at ${laneFile(repo, name)}: ${err.message}`);
  }
  for (const step of lane.steps || []) validateStep(step);
  return lane;
}

export async function loadAllLanes(repo) {
  const names = await listLaneNames(repo);
  const lanes = [];
  for (const name of names) lanes.push(await loadLane(repo, name));
  return lanes;
}

// Like loadAllLanes but a single broken lane file (bad JSON, an unsupported
// step type from a hand-edit or a pre-M2 `ai` step) does NOT take down every
// other lane. Returns the loadable lanes plus a list of the ones that failed so
// callers can surface them loudly (DESIGN §1: no-silent-failure ≠ fail-everything).
export async function loadAllLanesResilient(repo) {
  const names = await listLaneNames(repo);
  const lanes = [];
  const unloadable = [];
  for (const name of names) {
    try {
      lanes.push(await loadLane(repo, name));
    } catch (err) {
      unloadable.push({ name, error: err.message });
    }
  }
  return { lanes, unloadable };
}

// Atomic write: lane files are the source of truth, so a crash mid-write must
// not leave a truncated/corrupt file. Write a sibling temp then rename (atomic
// on the same filesystem). The temp name avoids `.json` so listLaneNames never
// picks it up as a lane mid-write.
export async function saveLane(repo, lane) {
  for (const step of lane.steps || []) validateStep(step);
  const file = laneFile(repo, lane.name);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(lane, null, 2)}\n`);
  await rename(tmp, file);
  return lane;
}

// Project/user-level `default`/`onEmpty` (DESIGN §6, deferred from M2): a lane
// that doesn't set its own falls back to the project's, then the user's. The
// §5 config example nests `onEmpty` inside the default step object, so both
// spellings count.
export function defaultFallback(projectConfig = {}, userConfig = {}) {
  return {
    onEmpty: projectConfig.onEmpty ?? projectConfig.default?.onEmpty
      ?? userConfig.onEmpty ?? userConfig.default?.onEmpty ?? null,
    default: projectConfig.default ?? userConfig.default ?? null,
  };
}

// Determines what the scheduler should do next with this lane, without
// mutating it. See DESIGN §6 step 5. `fallback` carries the project/user-level
// default + onEmpty (defaultFallback above) for lanes that don't set their own.
export function nextAction(lane, fallback = {}) {
  if (lane.cursor < lane.steps.length) {
    return { kind: 'step', step: lane.steps[lane.cursor], index: lane.cursor };
  }
  const onEmpty = lane.onEmpty ?? fallback.onEmpty ?? 'idle';
  const def = lane.default ?? fallback.default ?? null;
  if (onEmpty === 'default' && def) {
    // Strip the config-side `onEmpty` marker so it doesn't ride into the step.
    const { onEmpty: _configMarker, ...step } = def;
    return { kind: 'default', step: { ...step, status: 'pending' }, index: lane.cursor };
  }
  return { kind: 'idle' };
}

export async function resolveStepConfig(repo, lane, step) {
  const [projectConfig, userConfig] = await Promise.all([loadProjectConfig(repo), loadUserConfig()]);
  return resolveConfig(step, lane, projectConfig, userConfig);
}

// Land check (DESIGN §7): when a lane has finished its queue and its
// taskherd/<lane> branch carries commits beyond base, the land policy decides
// what happens — `manual-gate` (default) appends a blocking gate whose ack
// merges; `pr` pushes the branch + opens a PR; `leave` does nothing. Mutates
// `lane` in memory (caller saves). Lanes that recur via an onEmpty default
// never "complete", so they never land here (§6 steady state); a land-check
// failure logs loudly and degrades to `leave` — the branch keeps the work.
export async function maybeLand(repo, lane) {
  const branch = laneBranch(lane.name);
  try {
    const [projectConfig, userConfig] = await Promise.all([loadProjectConfig(repo), loadUserConfig()]);
    const fallback = defaultFallback(projectConfig, userConfig);
    const onEmpty = lane.onEmpty ?? fallback.onEmpty ?? 'idle';
    if (onEmpty === 'default' && (lane.default ?? fallback.default)) return null;
    if (!(await isGitRepo(repo)) || !(await branchExists(repo, branch))) return null;
    const cfg = resolveConfig(null, lane, projectConfig, userConfig);
    const land = cfg.land || 'manual-gate';
    if (land === 'leave') return null;
    const base = cfg.base || (await branchBase(repo, branch)) || (await defaultBase(repo));
    const ahead = await aheadCount(repo, branch, base);
    if (ahead === 0) return null;

    if (land === 'pr') {
      try {
        const url = await pushAndOpenPr(repo, branch, base, lane.name);
        await appendEvent(repo, {
          event: 'land.pr', lane: lane.name, branch, base, url,
        });
        return { landed: 'pr', url };
      } catch (err) {
        const gate = {
          type: 'manual',
          message: `land: could not push/PR ${branch}: ${err.message} — land it manually, then ack`,
          status: 'blocked',
        };
        lane.steps.push(gate);
        lane.status = 'blocked';
        await appendEvent(repo, {
          event: 'gate.blocked', lane: lane.name, step: lane.steps.length - 1, reason: gate.message,
        });
        return { landed: 'gate', reason: gate.message };
      }
    }

    // manual-gate (default): the gate carries the branch/base so ack knows to merge.
    const gate = {
      type: 'manual',
      message: `land: ${branch} is ${ahead} commit(s) ahead of ${base} — review `
        + `(git diff ${base}...${branch}) and ack to merge`,
      land: { branch, base },
      status: 'blocked',
    };
    lane.steps.push(gate);
    lane.status = 'blocked';
    await appendEvent(repo, {
      event: 'land.gate', lane: lane.name, branch, base, ahead,
    });
    await appendEvent(repo, {
      event: 'gate.blocked', lane: lane.name, step: lane.steps.length - 1, reason: gate.message,
    });
    return { landed: 'gate', reason: gate.message };
  } catch (err) {
    console.error(`taskherd: lane ${lane.name} land check failed (branch ${branch} left in place): ${err.message}`);
    return null;
  }
}

// Clears whatever gate currently sits at the lane's cursor: a land gate merges
// its branch into base first (a failed merge throws and the gate stays), a
// manual gate advances past (cursor++), a parked failure resets for retry in
// place. Shared by the CLI's `ack` and (later) the MCP `tasks_ack` tool.
export async function ackLane(repo, name) {
  const lane = await loadLane(repo, name);
  const step = lane.steps[lane.cursor];
  if (!step || (step.status !== 'blocked' && step.status !== 'failed')) {
    // No step-gate at the cursor: a budget-blocked lane whose gate sits on a
    // synthetic default step (cursor past end) is cleared here (DESIGN §10).
    if (lane.status === 'blocked' && lane.budgetBlock) {
      lane.status = 'idle';
      delete lane.budgetBlock;
      // A budget block on the lane's final run suppressed the land check —
      // clearing it re-runs the check so completed work still lands.
      if (lane.cursor >= lane.steps.length) await maybeLand(repo, lane);
      await saveLane(repo, lane);
      return { kind: 'budget', lane };
    }
    return { kind: 'none', lane };
  }
  delete lane.budgetBlock; // clearing a step-gate also clears any budget marker
  if (step.status === 'blocked') {
    const land = step.land?.branch ? step.land : null;
    let merged = null;
    if (land) {
      merged = await landMerge(repo, land.branch, land.base); // throws on conflict; gate stays
      await appendEvent(repo, {
        event: 'land.merged', lane: name, branch: land.branch, base: land.base, commit: merged,
      });
    }
    step.status = 'done';
    lane.cursor += 1;
    lane.status = 'idle';
    // Acking the final gate can complete the queue — the same land trigger as
    // a run finishing in the scheduler (a lane ending in a sign-off gate must
    // still land). An acked land gate's branch is no longer ahead, so no re-gate.
    if (lane.cursor >= lane.steps.length) await maybeLand(repo, lane);
    await saveLane(repo, lane);
    return land ? { kind: 'land', lane, merged: { ...land, commit: merged } } : { kind: 'gate', lane };
  }
  step.status = 'pending';
  step.attempts = 0;
  delete step.parkedReason;
  lane.status = 'idle';
  await saveLane(repo, lane);
  return { kind: 'failure', lane };
}

// Lane names become file paths (`.tasks/<name>.json`) and branch names
// (`taskherd/<name>`), and MCP clients pass them straight from an agent — a
// separator or a leading dot must fail loudly, never escape .tasks/.
export function validateLaneName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new LaneValidationError(
      `taskherd: invalid lane name ${JSON.stringify(name)} (letters, digits, ., _, - only; must not start with .)`,
    );
  }
  return name;
}

// Canonical step builder shared by every client of the lane files (the CLI's
// `add`, MCP `tasks_add`/`tasks_block`/`tasks_fork` — DESIGN §3: they must not
// drift apart). Opts are camelCase; validates before returning.
export function buildStep(opts = {}) {
  const type = opts.type || 'command';
  if (type === 'manual') {
    return validateStep({
      type: 'manual',
      message: opts.message || opts.task,
      ...(opts.file ? { file: opts.file } : {}),
      status: 'pending',
    });
  }
  if (type === 'ai') {
    const step = { type: 'ai', status: 'pending' };
    if (opts.file) step.file = opts.file;
    else if (opts.task) step.task = opts.task;
    if (opts.provider) step.provider = opts.provider;
    if (opts.model) step.model = opts.model;
    if (opts.profile) step.profile = opts.profile;
    if (opts.runner) step.runner = opts.runner;
    if (opts.session) step.session = typeof opts.session === 'string' ? { mode: opts.session } : opts.session;
    const args = {};
    if (opts.permissionMode) args.permissionMode = opts.permissionMode;
    if (opts.maxTurns != null) args.maxTurns = Number(opts.maxTurns);
    if (Object.keys(args).length) step.args = args;
    let budget = null;
    if (opts.budgetUsd != null) {
      budget = { usd: Number(opts.budgetUsd) };
      if (opts.budgetPerRun) budget.perRun = true;
    }
    if (opts.budgetPerDay != null) budget = { ...(budget || {}), usdPerDay: Number(opts.budgetPerDay) };
    if (budget) step.budget = budget;
    return validateStep(step);
  }
  // A command step honors the `runner` axis too (DESIGN §11: a read-only/remote
  // command is a first-class runner target — e.g. a container build or a remote
  // deploy). Mirrors the ai branch; without it `add --runner docker:… "cmd"`
  // silently dropped the runner and ran on the host.
  const step = { type: 'command', run: opts.run ?? opts.task, status: 'pending' };
  if (opts.runner) step.runner = opts.runner;
  return validateStep(step);
}

// Lane-level axis settings a client may set alongside a step (DESIGN §7:
// isolation/land/base are per-lane, not per-step).
function applyLaneOpts(lane, laneOpts = {}) {
  if (laneOpts.isolation) lane.isolation = laneOpts.isolation;
  if (laneOpts.land) lane.land = laneOpts.land;
  if (laneOpts.base) lane.base = laneOpts.base;
  if (laneOpts.onEmpty) lane.onEmpty = laneOpts.onEmpty;
}

// Appends a step to a lane (creating the lane on first use), or — with
// `asDefault` — sets the lane's recurring default (DESIGN §6). Shared by the
// CLI `add`/`block` and MCP `tasks_add`/`tasks_block`.
export async function addStep(repo, laneName, stepOpts, laneOpts = {}) {
  validateLaneName(laneName);
  const lane = (await laneExists(repo, laneName)) ? await loadLane(repo, laneName) : newLane(laneName);
  const step = buildStep(stepOpts);
  applyLaneOpts(lane, laneOpts);
  if (laneOpts.asDefault) {
    const { status: _transient, ...defaultStep } = step;
    lane.default = defaultStep;
    lane.onEmpty = 'default';
    await saveLane(repo, lane);
    return { lane, step: defaultStep, index: 'default' };
  }
  lane.steps.push(step);
  await saveLane(repo, lane);
  return { lane, step, index: lane.steps.length - 1 };
}

// Queue editing (DESIGN §15 "reorder, add, edit, remove steps"). Only the
// still-pending future of the queue is editable: indices before the cursor are
// history, and while a step is live (its control socket exists) the step at
// the cursor is off-limits too — the executor patches its result back BY INDEX
// after the run (the M1.1 lost-update fix), so shifting or mutating it would
// corrupt that write-back. Blocked/failed steps go through `ack`, not editing.
export function laneIsRunning(repo, laneName) {
  return existsSync(runSocketLink(repo, laneName));
}

function assertEditableIndex(repo, lane, index, verb) {
  const min = lane.cursor + (laneIsRunning(repo, lane.name) ? 1 : 0);
  if (!Number.isInteger(index) || index < 0 || index >= lane.steps.length) {
    throw new LaneValidationError(`taskherd: lane '${lane.name}' has no step ${index}`);
  }
  if (index < min) {
    throw new LaneValidationError(
      `taskherd: cannot ${verb} step ${index} of lane '${lane.name}' — `
      + (index < lane.cursor ? 'it already ran' : 'it is running (or next); interrupt or ack instead'),
    );
  }
  if (lane.steps[index].status !== 'pending') {
    throw new LaneValidationError(
      `taskherd: cannot ${verb} step ${index} of lane '${lane.name}' (status ${lane.steps[index].status}) — clear it with ack`,
    );
  }
}

export async function removeStep(repo, laneName, index) {
  const lane = await loadLane(repo, laneName);
  assertEditableIndex(repo, lane, index, 'remove');
  const [removed] = lane.steps.splice(index, 1);
  await saveLane(repo, lane);
  return { lane, removed };
}

export async function moveStep(repo, laneName, from, to) {
  const lane = await loadLane(repo, laneName);
  assertEditableIndex(repo, lane, from, 'move');
  assertEditableIndex(repo, lane, to, 'move to');
  const [step] = lane.steps.splice(from, 1);
  lane.steps.splice(to, 0, step);
  await saveLane(repo, lane);
  return { lane, step };
}

// Patches fields onto a pending step and re-validates. Run-state fields can
// never ride in through a patch — status/attempts are the scheduler's.
export async function editStep(repo, laneName, index, patch = {}) {
  const lane = await loadLane(repo, laneName);
  assertEditableIndex(repo, lane, index, 'edit');
  const {
    status: _s, attempts: _a, parkedReason: _p, ...fields
  } = patch;
  const step = { ...lane.steps[index], ...fields };
  // A patch may null a field out (e.g. switch task -> file prompt).
  for (const [k, v] of Object.entries(fields)) if (v === null) delete step[k];
  validateStep(step);
  lane.steps[index] = step;
  await saveLane(repo, lane);
  return { lane, step };
}

// Forks a sibling lane off a parent (DESIGN §18 `taskherd fork`, MCP
// `tasks_fork`, §17 "independent workstreams"): a NEW lane with `parent` set,
// running independently from creation. The parent must exist — forking off a
// typo must fail loudly, not scaffold an orphan. An initial step (or default)
// gives the fork something to do on its first fire.
export async function forkLane(repo, name, from, { stepOpts = null, laneOpts = {} } = {}) {
  validateLaneName(name);
  if (await laneExists(repo, name)) {
    throw new LaneValidationError(`taskherd: lane '${name}' already exists — fork needs a new lane name`);
  }
  if (!from) {
    throw new LaneValidationError('taskherd: fork needs a parent lane (--from <lane>)');
  }
  if (!(await laneExists(repo, from))) {
    throw new LaneValidationError(`taskherd: parent lane '${from}' does not exist`);
  }
  const lane = newLane(name, { parent: from });
  applyLaneOpts(lane, laneOpts);
  if (stepOpts) {
    const step = buildStep(stepOpts);
    if (laneOpts.asDefault) {
      const { status: _transient, ...defaultStep } = step;
      lane.default = defaultStep;
      lane.onEmpty = 'default';
    } else {
      lane.steps.push(step);
    }
  }
  await saveLane(repo, lane);
  return lane;
}

async function ensureGlobalGitignore() {
  let excludesFile;
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', 'core.excludesFile']);
    excludesFile = stdout.trim();
  } catch {
    excludesFile = null;
  }
  if (!excludesFile) {
    excludesFile = path.join(os.homedir(), '.config', 'git', 'ignore');
    await execFileAsync('git', ['config', '--global', 'core.excludesFile', excludesFile]);
  }
  const resolved = excludesFile.replace(/^~/, os.homedir());
  await mkdir(path.dirname(resolved), { recursive: true });
  let existing = '';
  try {
    existing = await readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const lines = existing.split('\n');
  if (!lines.some((l) => l.trim() === '.tasks/')) {
    await appendFile(resolved, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}.tasks/\n`);
  }
}

export async function initTasksDir(repo, { globalGitignore = true } = {}) {
  const dir = repoTasksDir(repo);
  await mkdir(dir, { recursive: true });
  await mkdir(logsDir(repo), { recursive: true });
  await mkdir(descDir(repo), { recursive: true });
  await mkdir(runDir(repo), { recursive: true });
  await mkdir(taskherdHome(), { recursive: true });

  const cfgFile = projectConfigFile(repo);
  if (!existsSync(cfgFile)) {
    const defaultConfig = {
      default: null,
      profile: null,
      runner: 'local',
      // Safety-first (DESIGN §7, §12): a git repo gets worktree isolation by
      // default — autonomous edits land on taskherd/<lane>, never the user's
      // checkout. Where there's no repo to isolate, 'none'.
      isolation: (await isGitRepo(repo)) ? 'worktree' : 'none',
      land: 'manual-gate',
      budget: null,
      timeout: '45m',
      maxTurns: null,
    };
    await writeFile(cfgFile, `${JSON.stringify(defaultConfig, null, 2)}\n`);
  }

  if (globalGitignore) await ensureGlobalGitignore();

  // The web console aggregates registered projects (DESIGN §4 projects.json);
  // init is the natural registration point — `taskherd serve` also registers
  // its own repo so pre-M5 projects appear on first serve.
  await registerProject(repo);

  return dir;
}
