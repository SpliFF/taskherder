// Config inheritance: step -> lane -> project config.json -> user config.json
// (DESIGN.md §5). Later levels only fill in keys the earlier ones didn't set.
import { readFile } from 'node:fs/promises';
import { userConfigFile, projectConfigFile } from './paths.mjs';

const INHERITED_KEYS = [
  'provider', 'profile', 'runner', 'isolation', 'land',
  'model', 'budget', 'timeout', 'maxTurns',
];

async function readJsonOrEmpty(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`taskherd: malformed config JSON at ${file}: ${err.message}`);
  }
}

export async function loadProjectConfig(repo) {
  return readJsonOrEmpty(projectConfigFile(repo));
}

export async function loadUserConfig() {
  return readJsonOrEmpty(userConfigFile());
}

// step > lane > project > user, per key. `budget` merges shallowly so e.g. a
// step-level `budget.usd` doesn't discard a project-level `budget.perRun`.
export function resolveConfig(step, lane, projectConfig, userConfig) {
  const resolved = {};
  for (const key of INHERITED_KEYS) {
    const layers = [step?.[key], lane?.[key], projectConfig?.[key], userConfig?.[key]];
    const found = layers.find((v) => v !== undefined && v !== null);
    if (found === undefined) continue;
    if (typeof found === 'object' && !Array.isArray(found)) {
      resolved[key] = Object.assign(
        {},
        userConfig?.[key],
        projectConfig?.[key],
        lane?.[key],
        step?.[key],
      );
    } else {
      resolved[key] = found;
    }
  }
  return resolved;
}
