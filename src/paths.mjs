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

// Runner definitions (DESIGN §11): ~/.taskherd/runners.json — docker/ssh runner
// specs keyed by name (local is implicit and needs no entry).
export function runnersFile() {
  return path.join(taskherdHome(), 'runners.json');
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

// Lane notes (DESIGN §24): the durable write path for shared working memory
// from a worktree — copied working-memory files are snapshots and never sync
// back, so per-lane findings append here instead.
export function notesDir(repo) {
  return path.join(repoTasksDir(repo), 'notes');
}

export function notesFile(repo, laneName) {
  return path.join(notesDir(repo), `${laneName}.md`);
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

// Worktrees live under user-level state, NOT inside the repo tree (DESIGN §4:
// a nested checkout inside the gitignored repo confuses git/watchers/IDEs).
// The repo id keeps a human-readable basename plus a hash so two checkouts
// with the same basename never collide.
export function wtBaseDir() {
  return path.join(taskherdHome(), 'wt');
}

export function repoId(repo) {
  const resolved = path.resolve(repo);
  const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return `${path.basename(resolved)}-${hash}`;
}

export function wtRepoDir(repo) {
  return path.join(wtBaseDir(), repoId(repo));
}

export function worktreeDir(repo, laneName) {
  return path.join(wtRepoDir(repo), laneName);
}

// Deterministic per-lane port block (DESIGN §25 rule 2): parallel lanes can't
// share the dev server's hardcoded port, so every step env exports
// TASKHERD_PORT_BASE and well-behaved test servers pick ports by convention:
// each lane owns the 50-port block [base, base+50) with base in
// [20000, 30000) — 200 blocks keyed by a stable hash of the lane name.
// Convention, not enforcement: undeclared port conflicts are what `mutex`
// tags are for.
export function lanePortBase(laneName) {
  const hash = createHash('sha1').update(String(laneName)).digest();
  return 20000 + (hash.readUInt32BE(0) % 200) * 50;
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
