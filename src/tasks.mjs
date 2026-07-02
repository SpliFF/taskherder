// Lane store (DESIGN.md §5): load/save lane files, the five-axis step model
// (command + manual only this milestone — ai lands in M2), config inheritance.
import { mkdir, readFile, writeFile, readdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  repoTasksDir, laneFile, projectConfigFile, logsDir, descDir, runDir,
  taskherdHome,
} from './paths.mjs';
import { loadProjectConfig, loadUserConfig, resolveConfig } from './config.mjs';

const execFileAsync = promisify(execFile);

const STEP_TYPES = ['command', 'manual'];

export class LaneValidationError extends Error {}

export function validateStep(step) {
  if (!step || typeof step !== 'object') {
    throw new LaneValidationError(`taskherd: step must be an object, got ${JSON.stringify(step)}`);
  }
  if (!STEP_TYPES.includes(step.type)) {
    throw new LaneValidationError(
      `taskherd: unsupported step type ${JSON.stringify(step.type)} (this milestone supports: ${STEP_TYPES.join(', ')})`,
    );
  }
  if (step.type === 'command' && !step.run && !step.argv) {
    throw new LaneValidationError('taskherd: command step needs `run` (shell string) or `argv` (array)');
  }
  if (step.type === 'manual' && !step.message) {
    throw new LaneValidationError('taskherd: manual step needs `message`');
  }
  return step;
}

export function newLane(name, overrides = {}) {
  return {
    name,
    parent: null,
    onEmpty: 'idle',
    default: null,
    isolation: 'none',
    land: 'manual-gate',
    profile: null,
    runner: 'local',
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

export async function saveLane(repo, lane) {
  for (const step of lane.steps || []) validateStep(step);
  await writeFile(laneFile(repo, lane.name), `${JSON.stringify(lane, null, 2)}\n`);
  return lane;
}

// Determines what the scheduler should do next with this lane, without
// mutating it. See DESIGN §6 step 5.
export function nextAction(lane) {
  if (lane.cursor < lane.steps.length) {
    return { kind: 'step', step: lane.steps[lane.cursor], index: lane.cursor };
  }
  if (lane.onEmpty === 'default' && lane.default) {
    return { kind: 'default', step: { ...lane.default, status: 'pending' }, index: lane.cursor };
  }
  return { kind: 'idle' };
}

export async function resolveStepConfig(repo, lane, step) {
  const [projectConfig, userConfig] = await Promise.all([loadProjectConfig(repo), loadUserConfig()]);
  return resolveConfig(step, lane, projectConfig, userConfig);
}

// Clears whatever gate currently sits at the lane's cursor: a manual gate
// advances past (cursor++), a parked failure resets for retry in place.
// Shared by the CLI's `ack` and (later) the MCP `tasks_ack` tool.
export async function ackLane(repo, name) {
  const lane = await loadLane(repo, name);
  const step = lane.steps[lane.cursor];
  if (!step || (step.status !== 'blocked' && step.status !== 'failed')) {
    return { kind: 'none', lane };
  }
  if (step.status === 'blocked') {
    step.status = 'done';
    lane.cursor += 1;
    lane.status = 'idle';
    await saveLane(repo, lane);
    return { kind: 'gate', lane };
  }
  step.status = 'pending';
  step.attempts = 0;
  delete step.parkedReason;
  lane.status = 'idle';
  await saveLane(repo, lane);
  return { kind: 'failure', lane };
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
      isolation: 'none',
      land: 'manual-gate',
      budget: null,
      timeout: '45m',
      maxTurns: null,
    };
    await writeFile(cfgFile, `${JSON.stringify(defaultConfig, null, 2)}\n`);
  }

  if (globalGitignore) await ensureGlobalGitignore();

  return dir;
}
