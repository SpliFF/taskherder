// The `docker` subprocesses behind the M11b `persistent` lifecycle (DESIGN §26):
// inspect / create / start / recreate a per-lane container, escalate a timed-out
// step INSIDE the container, and sweep orphans on gc. The DECISION (which action
// to take) is the pure `nextContainerAction` in containers.mjs; this module is
// the thin async wrapper that actually runs docker. Kept separate from
// containers.mjs (which stays pure/sync and importable anywhere) and from the
// pty-heavy executor, so gc/doctor can reap/inspect without pulling node-pty.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoId } from './paths.mjs';
import {
  nextContainerAction, containerLabels, KEEP_ALIVE, REPO_LABEL, LANE_LABEL,
} from './containers.mjs';

const execFileP = promisify(execFile);

// Inspect a per-lane container by name. Container names are taskherd-composed
// and charset-sanitized (containers.mjs), so they never inject docker flags.
// A missing container is NOT an error — it reads as { exists: false }.
export async function inspectContainer(name) {
  try {
    const { stdout } = await execFileP('docker', [
      'inspect', '--format',
      '{{.State.Running}}\t{{.State.Status}}\t{{index .Config.Labels "taskherd.lane"}}\t{{index .Config.Labels "taskherd.signature"}}',
      name,
    ], { timeout: 30_000 });
    const [running, status = '', lane = '', signature = ''] = stdout.trim().split('\t');
    return {
      exists: true, running: running === 'true', status, lane, signature: signature || null,
    };
  } catch {
    return {
      exists: false, running: false, status: null, lane: null, signature: null,
    };
  }
}

// `docker run -d` the per-lane container: mounts + labels + a keep-alive PID 1
// that idles between fires. Env is NOT baked in here — it crosses per-exec
// (`docker exec -e`) so profile secrets never land in the container's persisted
// config (`docker inspect`). `mounts` are the resolved `-v` VALUE strings.
async function createContainer({
  name, image, mounts, workdir, labels, dockerArgs = [],
}) {
  const args = ['run', '-d', '--name', name];
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  for (const m of mounts) args.push('-v', m);
  if (workdir) args.push('-w', workdir);
  if (dockerArgs.length) args.push(...dockerArgs);
  args.push(image, ...KEEP_ALIVE);
  await execFileP('docker', args, { timeout: 120_000 });
  return name;
}

export async function removeContainer(name) {
  await execFileP('docker', ['rm', '-f', name], { timeout: 60_000 }).catch(() => {});
}

// The §12-critical timeout escalation for a PERSISTENT container: killing the
// local `docker exec` client does NOT kill the in-container process (verified
// live). `docker restart -t 0` sends SIGKILL to everything inside — clearing the
// runaway step — while the container's filesystem (the persistent state) and the
// container itself survive, so the next fire execs into it as normal.
export async function restartContainer(name) {
  await execFileP('docker', ['restart', '-t', '0', name], { timeout: 60_000 });
}

// The same escalation for an EPHEMERAL (`docker run --rm`) container: killing the
// local `docker run` client leaves the container running (the M6 gap, verified
// live). `docker kill` SIGKILLs it; `--rm` then auto-removes it.
export async function killContainer(name) {
  await execFileP('docker', ['kill', name], { timeout: 60_000 }).catch(() => {});
}

// Ensure the per-lane container exists and is running with the wanted signature,
// per the pure state machine. Returns { action, name, reason }; a recreate/create
// is loud. Called by the executor before it `docker exec`s the step in.
export async function ensurePersistentContainer({
  name, image, mounts, workdir, dockerArgs, signature, repoIdStr, lane,
}) {
  const state = await inspectContainer(name);
  const decision = nextContainerAction({
    exists: state.exists,
    running: state.running,
    currentSignature: state.signature,
    wantedSignature: signature,
  });
  const labels = containerLabels(repoIdStr, lane, signature);
  if (decision.action === 'create') {
    await createContainer({
      name, image, mounts, workdir, labels, dockerArgs,
    });
  } else if (decision.action === 'recreate') {
    console.error(`taskherd: ${decision.reason} — container ${name}`);
    await removeContainer(name);
    await createContainer({
      name, image, mounts, workdir, labels, dockerArgs,
    });
  } else if (decision.action === 'start') {
    await execFileP('docker', ['start', name], { timeout: 60_000 });
  }
  // 'exec' → the container is already up with the right signature; nothing to do.
  return { action: decision.action, name, reason: decision.reason };
}

// All taskherd-labeled containers for this repo (running or stopped), each with
// its lane + signature + status, for gc's orphan sweep and doctor's status line.
// Empty when docker is unavailable — a box with no docker simply has no
// containers to reap (never a crash).
export async function listRepoContainers(repo) {
  const rid = repoId(repo);
  let names = [];
  try {
    const { stdout } = await execFileP('docker', [
      'ps', '-a', '--filter', `label=${REPO_LABEL}=${rid}`, '--format', '{{.Names}}',
    ], { timeout: 30_000 });
    names = stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    out.push({ name, ...(await inspectContainer(name)) });
  }
  return out;
}

export { LANE_LABEL };
