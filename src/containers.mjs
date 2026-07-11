// Container lanes (DESIGN §26): the `lifecycle` and `mcpTransport` task
// attributes, the validation matrix (§26 rule 2), and the fixed in-container
// mount points. Pure/synchronous and dependency-light on purpose — the executor
// does the async parts (the node-in-image probe, writing the merged mcp config),
// and tasks.mjs/mcp.mjs consume the enums. No import from tasks/git/executor,
// so this can be imported anywhere without a cycle.

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
  isolation, runner, lifecycle, mcpTransport, isAi = false,
} = {}) {
  const warnings = [];
  const lc = parseLifecycle(lifecycle);
  const transport = parseMcpTransport(mcpTransport);
  const effLifecycle = lc || DEFAULT_LIFECYCLE;
  const effTransport = transport || DEFAULT_MCP_TRANSPORT;
  const runnerKind = runner?.kind || 'local';
  const dockerImage = isDockerImageRunner(runner);
  const anyDocker = runnerKind === 'docker';

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
  // docker image runner; without one they are inert (warn, don't park). With
  // one, they are refused in M11a: `persistent` is operator-gated + unimplemented
  // (lands in M11b); `volume` is a deferred value.
  if (effLifecycle === 'persistent') {
    if (dockerImage) {
      throw new Error(
        'taskherd: lifecycle \'persistent\' is operator-gated and not yet implemented — it lands '
        + 'in M11b (a taskherd-managed per-lane container). Use \'ephemeral\' (the safe default) '
        + '(DESIGN §26 rule 1).',
      );
    }
    warnings.push(`taskherd: lifecycle 'persistent' has no effect without a docker image runner — ignored (DESIGN §26 rule 2).`);
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
    lifecycle: effLifecycle, mcpTransport: effTransport, mcpMode, dockerImage, warnings,
  };
}
