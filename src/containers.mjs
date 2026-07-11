// Container lanes (DESIGN §26): the `lifecycle` and `mcpTransport` task
// attributes, the validation matrix (§26 rule 2), the fixed in-container mount
// points, and the M11b `persistent` lifecycle state machine + container
// identity/signature. Pure/synchronous and dependency-light on purpose — the
// executor does the async parts (the node-in-image probe, writing the merged
// mcp config), and the actual `docker` subprocesses live in containers-docker.mjs;
// tasks.mjs/mcp.mjs consume the enums. Only imports node:crypto (for the
// signature hash) — no import from tasks/git/executor, so this can be imported
// anywhere without a cycle.
import { createHash } from 'node:crypto';

export const LIFECYCLES = ['ephemeral', 'persistent', 'volume'];
export const MCP_TRANSPORTS = ['mount', 'none', 'socket', 'http'];

export const DEFAULT_LIFECYCLE = 'ephemeral';
export const DEFAULT_MCP_TRANSPORT = 'mount';

// Fixed in-container mount points (§26 "the execution & communication seam").
// The clone lands at the runner's workdir (/work by default); the herd's
// `.tasks/` and this package are mounted at these stable paths so everything the
// merged mcp config references resolves INSIDE the container.
export const IN_CONTAINER_REPO = '/taskherd'; //         TASKHERD_REPO inside the container
export const IN_CONTAINER_TASKS = '/taskherd/.tasks'; // host .tasks/ bind-mounted here (rw)
export const IN_CONTAINER_PKG = '/opt/taskherd-pkg'; //  this package, bind-mounted here (ro)

// Value validators — fail loud on an unknown value, exactly like
// parseWhen/parseBootstrap. A null/empty value means "unset → use the default"
// and is returned as null (the caller applies the default). Known-but-gated
// values (persistent/volume/socket/http) are ACCEPTED here — they are gated at
// RESOLVE time (resolveContainerPlan), so `tasks_options` can still report them
// as gated rather than making them unstorable.
export function parseLifecycle(v) {
  if (v == null || v === '') return null;
  if (!LIFECYCLES.includes(v)) {
    throw new Error(`taskherd: unknown lifecycle ${JSON.stringify(v)} (expected ${LIFECYCLES.join(' | ')}) (DESIGN §26)`);
  }
  return v;
}

export function parseMcpTransport(v) {
  if (v == null || v === '') return null;
  if (!MCP_TRANSPORTS.includes(v)) {
    throw new Error(`taskherd: unknown mcpTransport ${JSON.stringify(v)} (expected ${MCP_TRANSPORTS.join(' | ')}) (DESIGN §26)`);
  }
  return v;
}

// Whether the operator has opted into the (M11b) persistent lifecycle for this
// repo. Config-gated exactly like `serve --allow-shell` (§26 rule 1). Reported
// by tasks_options; the M11a resolver still refuses `persistent` because it is
// not yet implemented — the flag only makes the gate story coherent for M11b.
export function persistentAllowed(projectConfig = {}, userConfig = {}) {
  return Boolean(projectConfig?.containers?.allowPersistent ?? userConfig?.containers?.allowPersistent);
}

// A docker runner is "image mode" (ephemeral `docker run --rm` per fire, into
// which taskherd bind-mounts the tree) vs "container mode" (`docker exec` into a
// user-managed running container). Only image mode can add the §26 mounts.
export function isDockerImageRunner(runner) {
  return runner?.kind === 'docker' && !!runner.image && !runner.container;
}

// The §26 validation matrix + attribute resolution, pure and synchronous.
// Throws a setup error (which parks the lane, M2 path) on an incoherent or
// operator-gated combination; returns { lifecycle, mcpTransport, mcpMode,
// warnings } for the runnable + soft-degrade cases. `mcpMode`:
//   'host'            — local runner, host taskherd-mcp as today
//   'container-mount' — ai step, local docker IMAGE runner, mount transport,
//                       node present (the executor confirms node before trusting
//                       this; it may downgrade to 'none')
//   'none'            — no in-runner tools (loud FIDELITY-STANDIN already logged
//                       for the ai case)
export function resolveContainerPlan({
  isolation, runner, lifecycle, mcpTransport, isAi = false, allowPersistent = false,
} = {}) {
  const warnings = [];
  const lc = parseLifecycle(lifecycle);
  const transport = parseMcpTransport(mcpTransport);
  const effLifecycle = lc || DEFAULT_LIFECYCLE;
  const effTransport = transport || DEFAULT_MCP_TRANSPORT;
  const runnerKind = runner?.kind || 'local';
  const dockerImage = isDockerImageRunner(runner);
  const anyDocker = runnerKind === 'docker';
  let persistent = false;

  // Rule 2 — the reject that converts today's silent break into an actionable
  // park: a linked worktree's `.git` is a host-absolute pointer, so it cannot do
  // git inside the container. Steer to `clone`.
  if (isolation === 'worktree' && dockerImage) {
    throw new Error(
      'taskherd: isolation \'worktree\' + a docker image runner is incoherent — a linked '
      + 'worktree\'s .git is a host-absolute pointer that does not exist inside the container, '
      + 'so every in-container git operation fails. Use isolation \'clone\' for container lanes '
      + '(DESIGN §26 rule 2).',
    );
  }

  // Rule 1 — lifecycle gating. `persistent`/`volume` only DO anything with a
  // docker image runner; without one they are inert (warn, don't park). With a
  // docker image runner, `persistent` (M11b: a taskherd-managed per-lane
  // container) is OPERATOR-GATED: it proceeds only when the repo/user config
  // opted in via `containers.allowPersistent` — otherwise the lane parks loudly
  // (the §15 `serve --allow-shell` posture). `volume` is a deferred value.
  if (effLifecycle === 'persistent') {
    if (dockerImage) {
      if (!allowPersistent) {
        throw new Error(
          'taskherd: lifecycle \'persistent\' is operator-gated — set "containers": '
          + '{ "allowPersistent": true } in .tasks/config.json (or ~/.taskherd/config.json) to '
          + 'enable a taskherd-managed per-lane container. Until then use \'ephemeral\' (the safe '
          + 'default) (DESIGN §26 rule 1).',
        );
      }
      persistent = true;
    } else {
      warnings.push(`taskherd: lifecycle 'persistent' has no effect without a docker image runner — ignored (DESIGN §26 rule 2).`);
    }
  }
  if (effLifecycle === 'volume') {
    if (dockerImage) {
      throw new Error('taskherd: lifecycle \'volume\' is a deferred value (DESIGN §26 Deferred) — use \'ephemeral\'.');
    }
    warnings.push(`taskherd: lifecycle 'volume' has no effect without a docker image runner — ignored (DESIGN §26 rule 2).`);
  }

  // mcpTransport gating — the network bridges are deferred axis values.
  if (effTransport === 'socket' || effTransport === 'http') {
    throw new Error(
      `taskherd: mcpTransport ${JSON.stringify(effTransport)} is a deferred value (a network bridge) `
      + '— use \'mount\' (local docker image) or \'none\' (DESIGN §26 Deferred).',
    );
  }

  // mcpMode — how an ai step reaches tasks_*. Only ai steps wire mcp; a command
  // step never does (mode 'none', no mounts, no config), even in a container.
  let mcpMode = 'none';
  if (runnerKind === 'local') {
    mcpMode = 'host';
  } else if (isAi) {
    if (effTransport === 'mount') {
      if (dockerImage) {
        mcpMode = 'container-mount'; // pending the executor's node-in-image probe
      } else {
        // docker exec into a user-managed container, or ssh — cannot add mounts.
        warnings.push(
          `FIDELITY-STANDIN: mcpTransport 'mount' needs a local docker IMAGE runner to bind-mount `
          + `.tasks/ — runner '${runner?.name || runnerKind}' cannot, so the tasks_* finalization `
          + 'tools are unavailable inside it; the agent runs but cannot enqueue its own next step '
          + '(DESIGN §26 rule 2).',
        );
        mcpMode = 'none';
      }
    }
    // effTransport === 'none' → mcpMode stays 'none' (the honest node-less state);
    // wrapForRunner still emits the standing §11 stand-in for an ai/non-local run.
  }

  return {
    lifecycle: effLifecycle, mcpTransport: effTransport, mcpMode, dockerImage, persistent, warnings,
  };
}

// ── M11b: the `persistent` lifecycle (DESIGN §26) ───────────────────────────
// taskherd owns ONE long-lived container per lane: created on the first fire,
// `docker exec`'d on subsequent fires, `docker start`ed if it was stopped, and
// loudly RECREATED when its signature drifts (image/mounts/workdir changed) so a
// stale container is never silently reused. The docker calls live in
// containers-docker.mjs; the DECISION is this pure function (peer of
// admission.mjs's `admissible`), unit-testable without a docker daemon.

// The keep-alive PID 1 for a per-lane container: it must stay up between fires
// (with nothing to do) so `docker exec` has something to exec into.
export const KEEP_ALIVE = ['tail', '-f', '/dev/null'];

// Decide what to do with a per-lane container given its observed state and the
// wanted signature. Returns { action: create|start|exec|recreate, reason }.
//   missing                 → create   (docker run -d + keep-alive)
//   signature drift          → recreate (rm -f + create; loud)
//   stopped (sig matches)    → start    (docker start, then exec)
//   running (sig matches)    → exec     (reuse — the fast steady state)
export function nextContainerAction({
  exists, running, currentSignature, wantedSignature,
} = {}) {
  if (!exists) return { action: 'create', reason: 'no per-lane container yet' };
  if (currentSignature !== wantedSignature) {
    return {
      action: 'recreate',
      reason: `container signature drift (image/mounts/workdir changed: ${currentSignature || '∅'} → ${wantedSignature}) — recreating`,
    };
  }
  if (running) return { action: 'exec', reason: 'reusing the running per-lane container' };
  return { action: 'start', reason: 'per-lane container was stopped — starting it' };
}

// Deterministic per-lane container name: `taskherd-<repoId>-<lane>`, sanitized
// to docker's name charset ([a-zA-Z0-9][a-zA-Z0-9_.-]*). The `taskherd-` prefix
// guarantees a valid leading char even if repoId/lane sanitize to empty.
export function containerName(repoIdStr, laneName) {
  const raw = `taskherd-${repoIdStr}-${laneName}`;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

// A unique name for an EPHEMERAL (`docker run --rm`) container so a timed-out
// fire can `docker kill` it (killing the local client alone orphans it — verified
// live, DESIGN §12). The run token keeps parallel/successive fires disjoint.
export function ephemeralContainerName(repoIdStr, laneName, token) {
  const raw = `taskherd-eph-${repoIdStr}-${laneName}-${token}`;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
}

// The signature label = a hash of everything that, if changed, means the running
// container is stale (its mounts are create-time only, so a changed mount set
// can't be applied to a live container — it must be recreated). Sorted mounts so
// ordering never causes a spurious drift.
export function containerSignature({ image, mounts = [], workdir = '' } = {}) {
  const canon = JSON.stringify({ image, mounts: [...mounts].sort(), workdir });
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

// Docker labels for a taskherd-managed container: repo + lane make orphan
// discovery (`docker ps --filter label=`) possible; signature drives recreate.
export const REPO_LABEL = 'taskherd.repo';
export const LANE_LABEL = 'taskherd.lane';
export const SIGNATURE_LABEL = 'taskherd.signature';
export const EPHEMERAL_PREFIX = 'taskherd-eph-';
export function containerLabels(repoIdStr, laneName, signature) {
  return {
    [REPO_LABEL]: repoIdStr,
    [LANE_LABEL]: laneName,
    [SIGNATURE_LABEL]: signature,
  };
}

// The gc decision for taskherd-labeled containers, pure + unit-testable (the CLI
// gathers the docker/fs facts and applies the actions). Rules (DESIGN §26 M11b):
//   1. NEVER touch a container whose lane has a live §25 run manifest — a fire is
//      using it (the running-footprint interlock).
//   2. An EPHEMERAL leftover (name `taskherd-eph-…`) should not exist (`--rm`
//      reaps on exit); a survivor is a crash artifact → reap.
//   3. A PERSISTENT container follows the clone: reap when its lane is gone OR its
//      clone was reaped (merged/absent) — the same clean-AND-merged-or-deleted
//      gate gcWorktrees applies to the clone; keep it while the lane is active.
export function containerGcPlan({
  containers = [], laneFiles = new Set(), clones = new Set(), runningLanes = new Set(),
} = {}) {
  return containers.map((c) => {
    const { name } = c;
    const lane = c.lane || '';
    if (runningLanes.has(lane)) {
      return { name, lane, action: 'keep', reason: 'live run manifest (§25 footprint interlock)' };
    }
    if (name.startsWith(EPHEMERAL_PREFIX)) {
      return { name, lane, action: 'reap', reason: 'ephemeral container leftover (crash artifact)' };
    }
    if (!laneFiles.has(lane)) {
      return { name, lane, action: 'reap', reason: 'lane gone (orphan)' };
    }
    if (!clones.has(lane)) {
      return { name, lane, action: 'reap', reason: 'clone reaped/absent' };
    }
    return { name, lane, action: 'keep', reason: 'active lane, clone present' };
  });
}
