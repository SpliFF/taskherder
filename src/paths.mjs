// Path resolution for per-project (.tasks/) and per-user (~/.taskherd/) state.
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

export function repoTasksDir(repo) {
  return path.join(path.resolve(repo), '.tasks');
}

export function taskherdHome() {
  if (process.env.TASKHERD_HOME) return path.resolve(process.env.TASKHERD_HOME);
  return path.join(os.homedir(), '.taskherd');
}

export function laneFile(repo, name) {
  return path.join(repoTasksDir(repo), `${name}.json`);
}

export function projectConfigFile(repo) {
  return path.join(repoTasksDir(repo), 'config.json');
}

export function userConfigFile() {
  return path.join(taskherdHome(), 'config.json');
}

// Provider templates (DESIGN §8) merged over the built-in defaults.
export function providersFile() {
  return path.join(taskherdHome(), 'providers.json');
}

// Per-account auth contexts (DESIGN §9): ~/.taskherd/profiles/<name>/profile.json.
export function profilesDir() {
  return path.join(taskherdHome(), 'profiles');
}

export function profileDir(name) {
  return path.join(profilesDir(), name);
}

export function profileFile(name) {
  return path.join(profileDir(name), 'profile.json');
}

export function logsDir(repo) {
  return path.join(repoTasksDir(repo), 'logs');
}

export function descDir(repo) {
  return path.join(repoTasksDir(repo), 'desc');
}

export function runDir(repo) {
  return path.join(repoTasksDir(repo), 'run');
}

function currentUid() {
  if (typeof process.getuid === 'function') return process.getuid();
  try {
    return os.userInfo().uid;
  } catch {
    return 'nouid';
  }
}

// Per-user runtime dir holding live control sockets. It is created 0700 and
// ownership-verified before use (see ensureRuntimeDir in executor.mjs): the
// socket accepts `input`, i.e. keystrokes into a possibly-autonomous agent, so
// it must never sit in world-writable /tmp with default perms.
export function runtimeDir() {
  const base = existsSync('/tmp') ? '/tmp' : os.tmpdir();
  return path.join(base, `taskherd-${currentUid()}`);
}

// The documented control-socket location (DESIGN §4/§13) is `.tasks/run/<id>.sock`,
// but AF_UNIX paths are capped at ~104 bytes on macOS/BSD (108 on Linux) and a
// project nested a few directories deep blows past that easily. The real socket
// lives at a short, hashed path inside the per-user runtime dir; `runDir()` gets
// a symlink pointing at it so it stays discoverable at the documented location.
export function runSocketPath(repo, laneName) {
  const hash = createHash('sha1').update(`${path.resolve(repo)}\0${laneName}`).digest('hex').slice(0, 16);
  return path.join(runtimeDir(), `${hash}.sock`);
}

export function runSocketLink(repo, laneName) {
  return path.join(runDir(repo), `${laneName}.sock`);
}

export function lockDir(repo) {
  return path.join(repoTasksDir(repo), '.lock');
}

export function lockPidFile(repo) {
  return path.join(lockDir(repo), 'pid');
}

export function pausedFile(repo) {
  return path.join(repoTasksDir(repo), 'PAUSED');
}

export function eventsFile(repo) {
  return path.join(repoTasksDir(repo), 'events.jsonl');
}

export function historyFile(repo) {
  return path.join(repoTasksDir(repo), 'history.jsonl');
}

export function needsAttentionFile(repo) {
  return path.join(repoTasksDir(repo), 'NEEDS-ATTENTION.md');
}

export function stateFile(repo) {
  return path.join(repoTasksDir(repo), 'state.json');
}
