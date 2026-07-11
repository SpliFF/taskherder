// taskherd-mcp (DESIGN §16): exposes the mutation/inspection surface to any
// Claude session (and the /task skill, §17) as tasks_* tools. Deliberately NO
// tasks_run — scheduling is cron/serve's job; an agent must not spawn itself.
// The server targets the repo at its launch cwd; every tool is just another
// client of the same lane files the CLI mutates (DESIGN §3).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { repoTasksDir } from './paths.mjs';
import {
  initTasksDir, addStep, forkLane, ackLane, noteLane,
} from './tasks.mjs';
import { renderStatus } from './history.mjs';
import { loadProjectConfig, loadUserConfig, resolveConfig } from './config.mjs';
import { loadRunners } from './runners.mjs';
import { isGitRepo } from './git.mjs';
import {
  LIFECYCLES, MCP_TRANSPORTS, DEFAULT_LIFECYCLE, DEFAULT_MCP_TRANSPORT, persistentAllowed,
} from './containers.mjs';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const execFileAsync = promisify(execFile);

async function gitOut(cwd, ...args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function findTasksDirUpward(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(repoTasksDir(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolves which repo's .tasks/ the tools operate on, from state fixed at
// launch (§16 "targets the repo at its launch cwd"):
//   1. TASKHERD_REPO env — set by the executor on every scheduled step (and in
//      the generated mcp config), so an agent running inside a worktree still
//      targets the MAIN repo.
//   2. Walk up from cwd to the nearest dir holding .tasks/.
//   3. cwd is a linked git worktree → the main checkout, when it has .tasks/
//      (a worktree never contains .tasks/ itself — it's gitignored).
// Returns null when nothing matches (tasks_init can still bootstrap).
export async function resolveTargetRepo({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.TASKHERD_REPO) {
    const repo = path.resolve(env.TASKHERD_REPO);
    if (!existsSync(repo)) {
      throw new Error(`taskherd: TASKHERD_REPO=${env.TASKHERD_REPO} is not a directory`);
    }
    return repo;
  }
  const upward = findTasksDirUpward(cwd);
  if (upward) return upward;
  const commonDir = await gitOut(cwd, 'rev-parse', '--git-common-dir');
  if (commonDir) {
    const resolved = path.resolve(cwd, commonDir);
    if (path.basename(resolved) === '.git') {
      const main = path.dirname(resolved);
      if (existsSync(repoTasksDir(main))) return main;
    }
  }
  return null;
}

// Where tasks_init scaffolds when no .tasks/ exists yet: the git toplevel of
// the launch cwd, else the cwd itself.
async function resolveInitTarget(cwd) {
  return (await gitOut(cwd, 'rev-parse', '--show-toplevel')) || path.resolve(cwd);
}

const STEP_PROPS = {
  type: { type: 'string', enum: ['command', 'ai', 'manual'], description: 'Step type. Be explicit: `command` runs `task` as a SHELL COMMAND; `ai` runs it as an agent prompt; `manual` is a gate. Defaults to command.' },
  task: { type: 'string', description: 'The prompt (ai) or shell command (command).' },
  run: { type: 'string', description: 'Shell command (command steps; alias of task).' },
  message: { type: 'string', description: 'Gate message (manual steps).' },
  file: { type: 'string', description: 'file-as-prompt: a path (relative to .tasks/, e.g. desc/x.md) whose contents are the prompt / gate prose.' },
  id: { type: 'string', description: 'Stable label for this step so OTHER steps can wait on it (a waitsFor target), e.g. "U2". Letters/digits/._- only.' },
  waitsFor: { type: 'array', items: { type: 'string' }, description: 'Cross-lane dependencies (DESIGN §22): this step will not run until every reference is satisfied, and the wait AUTO-CLEARS (no ack). Forms: "lane:id" (a specific step in another lane — the common case), ":id" (a step in THIS lane), or "lane" (that lane\'s whole queue drained). A ref is satisfied when its target step is `done`. Use this for a real prerequisite instead of hand-holding a manual gate.' },
  when: { type: 'object', description: 'A precondition RULE TREE (DESIGN §23): the step only runs on a fire where the rule holds — otherwise it soft-skips and re-checks next fire (AUTO-CLEARS, no ack), exactly like waitsFor. A rule is one object with exactly one key. Leaves: {"window":{...}} a time/date predicate — any of after/before ("HH:MM", local time; overnight wraps), days ("Mon-Fri" or ["Sat","Sun"]), from/until ("YYYY-MM-DD" absolute bounds), tz ("local"|"utc"); {"dep":"lane:id"} identical to a waitsFor ref. Combinators: {"all":[...]} (AND), {"any":[...]} (OR), {"not":<rule>}. Example — business hours only: {"all":[{"window":{"after":"09:00","before":"17:00","days":"Mon-Fri"}}]}; {"exit":{"run":"./scripts/ready.sh"}} runs a PROBE command each fire the step is otherwise runnable and lets it start once the exit code matches ("equals" int, default 0 | "in":[codes] | "not":code; "argv" array instead of "run" to skip the shell; "timeout" default 30s, "cache" TTL reuses the last result across fires, "runner", "env"). A probe is code the SCHEDULER executes speculatively and repeatedly — keep it cheap, idempotent, read-only; error/timeout ⇒ unsatisfied (fail-closed). ONLY window/dep/exit/all/any/not are implemented; file/http/env are refused with a loud error. A malformed rule fails loudly at add time — never a silent skip.' },
  provider: { type: 'string', description: 'AI provider (e.g. claude).' },
  model: { type: 'string', description: 'Model override (e.g. sonnet, opus).' },
  profile: { type: 'string', description: 'Auth profile name (per-account isolation).' },
  runner: { type: 'string', description: 'Runner (local | docker:<ctr> | ssh:<host>).' },
  session: { type: 'string', enum: ['fresh', 'resume', 'continue'], description: 'AI session mode.' },
  permissionMode: { type: 'string', description: 'Provider permission mode override.' },
  maxTurns: { type: 'number', description: 'Cap on agent turns for one run.' },
  budgetUsd: { type: 'number', description: 'Cumulative lane budget cap in USD.' },
  budgetPerDay: { type: 'number', description: 'Per-UTC-day budget cap in USD.' },
  budgetPerRun: { type: 'boolean', description: 'Make budgetUsd a per-run cap instead of cumulative.' },
};

const LANE_PROPS = {
  isolation: { type: 'string', enum: ['worktree', 'inplace', 'none', 'clone'], description: 'Git isolation for the lane. `clone` (DESIGN §26) is a self-contained checkout that bind-mounts cleanly into a container — use it for a CONTAINER code lane (isolation:clone + runner:docker:<image>), where a plain worktree cannot do git. Call tasks_options for what this box permits.' },
  land: { type: 'string', enum: ['manual-gate', 'pr', 'leave'], description: 'Land policy when the lane completes.' },
  base: { type: 'string', description: 'Base branch the lane branch forks from / lands into.' },
  onEmpty: { type: 'string', enum: ['default', 'idle'], description: 'What an empty lane does each fire.' },
  asDefault: { type: 'boolean', description: 'Set the step as the lane\'s recurring default (runs every fire once the queue is empty) instead of appending it.' },
  parallel: { type: 'boolean', description: 'Parallel lanes (DESIGN §25): false pins this lane to the SERIAL slot — it only runs when nothing else is running and blocks admission while it runs. Only meaningful when the repo config sets parallel.max > 1.' },
  mutex: { type: 'array', items: { type: 'string' }, description: 'Shared-resource tags (DESIGN §25): two lanes sharing a tag never run concurrently (e.g. ["live-server", "db"]). Declare a tag for every resource isolation cannot prove disjoint — a port, one external DB, a rate-limited account. Only enforced when parallel.max > 1.' },
  lifecycle: { type: 'string', enum: LIFECYCLES, description: 'Container lifetime (DESIGN §26), meaningful only with a docker image runner. `ephemeral` (DEFAULT, safe) = a fresh `docker run --rm` per fire. `persistent` (a taskherd-managed per-lane container — faster steady state for install-heavy lanes) is OPERATOR-GATED and lands in M11b; selecting it now parks the lane loudly. `volume` is deferred. Prefer `persistent` where it is safe once available; call tasks_options for what this repo permits.' },
  mcpTransport: { type: 'string', enum: MCP_TRANSPORTS, description: 'How an in-container agent\'s tasks_* tools reach the herd (DESIGN §26), meaningful only for an ai step under a non-local runner. `mount` (DEFAULT, local docker only) = the herd\'s .tasks/ is bind-mounted and an in-container taskherd-mcp writes it. `none` = no tools (node-less image). `socket`/`http` are deferred network bridges. RISKY values may be operator-gated here — call tasks_options.' },
};

// Insert position (DESIGN §15). `next` interposes the step ahead of one already
// waiting at the cursor — the right tool for gating/retiring the pending step,
// which a plain append (`end`) can't do (the pending step would fire first).
const POSITION_PROP = {
  at: { type: 'string', description: 'Where to place the step: `next` (fires on the very NEXT fire, ahead of any step already waiting at the cursor), `end` (append — the default), or a step index. Pass as a string.' },
};

// The §16 tool surface. Descriptions are written for the agent driving them
// (the /task finalization loop, §17).
const TOOLS = [
  {
    name: 'tasks_init',
    description: 'Scaffold .tasks/ for this repo (idempotent). Run once before any other tasks_* tool in a repo that has never been initialized.',
    inputSchema: {
      type: 'object',
      properties: {
        globalGitignore: { type: 'boolean', description: 'Also ensure .tasks/ is in the user\'s global gitignore (default true).' },
      },
    },
  },
  {
    name: 'tasks_status',
    description: 'Show all lanes: cursor, state, open gates, last result, cost totals. Read this before mutating the lane tree.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tasks_options',
    description: 'The environment-specific ALLOCATION CATALOG for this repo (DESIGN §26): the runner definitions this box has, the resolved axis defaults, parallel.max, and which risky values (persistent lifecycle, network mcpTransport) are operator-gated HERE. Call this BEFORE tasks_fork/tasks_add when you must choose isolation/runner/lifecycle for a sub-task — the static tool schema cannot know what this machine offers, so allocate from the real permitted knobs, not guesses. For a container CODE lane, use isolation:clone + one of the configured docker image runners.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tasks_add',
    description: 'Add a step to a lane (creates the lane on first use), or set the lane\'s recurring default with asDefault. Appends by default; pass `at:"next"` to interpose it ahead of a step already waiting at the cursor. Enqueue an explicit step only when the next fire needs a SPECIFIC prompt/model/provider — an onEmpty-default lane already runs its default each fire with no bookkeeping. To make one lane wait on another\'s progress, give the prerequisite an `id` and list it in this step\'s `waitsFor` (e.g. waitsFor:["grammar-unification:U2"]) — a real dependency that auto-clears, instead of hand-holding a manual gate (DESIGN §22). To gate a step on a time/date window (e.g. business hours only) or a boolean rule tree, pass `when` (DESIGN §23) — it soft-skips off-schedule fires and self-clears, no ack.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'Lane name (created if missing).' },
        ...STEP_PROPS,
        ...LANE_PROPS,
        ...POSITION_PROP,
      },
      required: ['lane'],
    },
  },
  {
    name: 'tasks_block',
    description: 'Insert a blocking manual gate into a lane: the lane pauses until a human acks; sibling lanes continue. Use for open threads that need a human — a design question, missing creds, a sign-off, an external action. Placed at `next` by default, so it fires ahead of any step already waiting at the cursor (pass `at:"end"` to gate only after the rest of the queue drains). Defaults to the current lane (TASKHERD_LANE) when running as a scheduled step.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'Lane to gate (default: the lane this step runs in, from TASKHERD_LANE).' },
        message: { type: 'string', description: 'What the human must decide/do — shown in status and NEEDS-ATTENTION.md.' },
        file: { type: 'string', description: 'Optional desc/*.md file (relative to .tasks/) with the full prose.' },
        at: { type: 'string', description: 'Where to place the gate: `next` (default — fires ahead of the pending cursor step), `end` (after the rest of the queue), or a step index. Pass as a string.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'tasks_fork',
    description: 'Fork a sibling lane off a parent: a NEW independent lane (own branch/worktree) for an independent workstream discovered mid-task. Give it an initial step (task/type/...) or a recurring default (asDefault). `from` defaults to the current lane (TASKHERD_LANE). Fork-time contract when the repo runs parallel lanes (DESIGN §25): fork only INDEPENDENT, DISJOINT file scopes into isolated lanes; declare any shared resource (a port, one DB, a rate-limited account) as a `mutex` tag on both lanes; work whose file scope OVERLAPS the parent stays in the parent lane — serial by construction, no analysis needed. To ALLOCATE isolation/runner/lifecycle for the sub-task, call tasks_options first (DESIGN §26): it reports this box\'s real runners + which risky values are gated. A container code lane = isolation:clone + a docker image runner (a plain worktree cannot do git in a container).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'New lane name.' },
        from: { type: 'string', description: 'Parent lane (default: the lane this step runs in, from TASKHERD_LANE).' },
        ...STEP_PROPS,
        ...LANE_PROPS,
      },
      required: ['name'],
    },
  },
  {
    name: 'tasks_note',
    description: 'Append durable field notes to this lane\'s notes file (.tasks/notes/<lane>.md in the MAIN repo — append-only, timestamped). Use this for findings that must outlive the run when your cwd is a worktree: copied working-memory files (a PLAN.md snapshot seeded by the bootstrap manifest, DESIGN §24) are read-only snapshots — edits there are NEVER synced back and will be lost. A human (or a designated serial lane) integrates notes into the shared plan. Defaults to the current lane (TASKHERD_LANE).',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'Lane the note belongs to (default: the lane this step runs in, from TASKHERD_LANE).' },
        text: { type: 'string', description: 'The note (markdown). Appended under a timestamp header.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'tasks_ack',
    description: 'Clear the gate at a lane\'s cursor: approve a land gate (merges the lane branch), pass a manual gate, or reset a parked failure for retry. Only use when the human decision the gate represents has actually been made.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'Lane whose gate to clear.' },
      },
      required: ['lane'],
    },
  },
];

function splitArgs(args = {}) {
  const {
    lane, name, from, isolation, land, base, onEmpty, asDefault, at, parallel, mutex,
    lifecycle, mcpTransport, ...stepOpts
  } = args;
  return {
    lane, name, from, laneOpts: {
      isolation, land, base, onEmpty, asDefault, at, parallel, mutex, lifecycle, mcpTransport,
    },
    stepOpts,
  };
}

function hasStepPayload(stepOpts) {
  return Boolean(stepOpts.task || stepOpts.run || stepOpts.message || stepOpts.file);
}

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

// The §26 allocation catalog: environment-specific knobs the /task skill needs
// to allocate a sub-task's isolation/runner/lifecycle. Dynamic on purpose — the
// static schema can't know THIS box's runners or which risky values the operator
// gated here.
async function optionsCatalog(repo) {
  const [projectConfig, userConfig, runnersDef, gitRepo] = await Promise.all([
    loadProjectConfig(repo), loadUserConfig(), loadRunners(), isGitRepo(repo),
  ]);
  const cfg = resolveConfig(null, null, projectConfig, userConfig);
  const allowPersistent = persistentAllowed(projectConfig, userConfig);
  const runners = Object.entries(runnersDef).map(([name, def]) => ({
    name, kind: def.kind, ...(def.image ? { image: def.image } : {}), ...(def.container ? { container: def.container } : {}), ...(def.host ? { host: def.host } : {}),
  }));
  return {
    repo,
    isolation: {
      default: cfg.isolation ?? (gitRepo ? 'worktree' : 'none'),
      values: ['worktree', 'inplace', 'none', 'clone'],
      note: 'clone = a self-contained checkout for a CONTAINER code lane (isolation:clone + a docker image runner); a plain worktree cannot do git inside a container.',
    },
    runner: {
      default: cfg.runner ?? 'local',
      configured: runners,
      inline: ['local', 'docker:<image-or-container>', 'ssh:<host>'],
      note: runners.length ? undefined : 'no ~/.taskherd/runners.json — use an inline docker:<image> / ssh:<host> form.',
    },
    lifecycle: {
      default: DEFAULT_LIFECYCLE,
      values: LIFECYCLES,
      gated: {
        persistent: { allowed: allowPersistent, note: 'operator-gated (config containers.allowPersistent) AND not yet implemented — lands in M11b; selecting it now parks the lane.' },
        volume: { allowed: false, note: 'deferred value (DESIGN §26).' },
      },
      note: 'Prefer persistent where safe (stable, single-account, install-heavy lane) once M11b ships; ephemeral is the safe default until then.',
    },
    mcpTransport: {
      default: DEFAULT_MCP_TRANSPORT,
      values: MCP_TRANSPORTS,
      gated: {
        socket: { allowed: false, note: 'deferred network bridge.' },
        http: { allowed: false, note: 'deferred network bridge.' },
      },
      note: 'mount is local-docker only (needs node in the image); it degrades to none + a loud stand-in on a node-less image or a remote runner.',
    },
    parallel: { max: Number(projectConfig?.parallel?.max ?? userConfig?.parallel?.max ?? 1) || 1 },
  };
}

export function createTaskherdServer({ cwd = process.cwd(), env = process.env } = {}) {
  const server = new Server(
    { name: 'taskherd', version },
    { capabilities: { tools: {} } },
  );

  async function requireRepo() {
    const repo = await resolveTargetRepo({ cwd, env });
    if (!repo) {
      throw new Error(
        `taskherd: no .tasks/ found from ${cwd} — run tasks_init first (or launch with TASKHERD_REPO=<repo>)`,
      );
    }
    return repo;
  }

  const handlers = {
    async tasks_init(args) {
      const repo = (await resolveTargetRepo({ cwd, env })) || (await resolveInitTarget(cwd));
      const dir = await initTasksDir(repo, { globalGitignore: args.globalGitignore !== false });
      return text(`initialized ${dir}`);
    },
    async tasks_status() {
      const repo = await requireRepo();
      return text(await renderStatus(repo));
    },
    async tasks_options() {
      const repo = await requireRepo();
      return text(JSON.stringify(await optionsCatalog(repo), null, 2));
    },
    async tasks_add(args) {
      const repo = await requireRepo();
      const { lane, laneOpts, stepOpts } = splitArgs(args);
      const { step, index } = await addStep(repo, lane, stepOpts, laneOpts);
      return text(index === 'default'
        ? `set lane '${lane}' default (${step.type}, onEmpty=default)`
        : `added step ${index} (${step.type}) to lane '${lane}'`);
    },
    async tasks_block(args) {
      const repo = await requireRepo();
      const lane = args.lane || env.TASKHERD_LANE;
      if (!lane) {
        throw new Error('taskherd: tasks_block needs a lane (none given and TASKHERD_LANE is not set)');
      }
      // Default to `next`: a block is meant to STOP the lane here, ahead of any
      // step already waiting at the cursor — appending would let that step fire
      // first. `at:"end"` opts back into after-the-queue gating.
      const { index } = await addStep(
        repo, lane,
        { type: 'manual', message: args.message, file: args.file },
        { at: args.at || 'next' },
      );
      return text(`gated lane '${lane}' at step ${index} — it pauses there until a human acks; siblings continue`);
    },
    async tasks_fork(args) {
      const repo = await requireRepo();
      const { name, laneOpts, stepOpts } = splitArgs(args);
      const from = args.from || env.TASKHERD_LANE;
      if (!from) {
        throw new Error('taskherd: tasks_fork needs `from` (none given and TASKHERD_LANE is not set)');
      }
      const lane = await forkLane(repo, name, from, {
        stepOpts: hasStepPayload(stepOpts) ? stepOpts : null,
        laneOpts,
      });
      const seeded = lane.default ? 'with a recurring default'
        : (lane.steps.length ? `with ${lane.steps.length} initial step(s)` : 'empty');
      return text(`forked lane '${name}' from '${from}' (${seeded})`);
    },
    async tasks_note(args) {
      const repo = await requireRepo();
      const lane = args.lane || env.TASKHERD_LANE;
      if (!lane) {
        throw new Error('taskherd: tasks_note needs a lane (none given and TASKHERD_LANE is not set)');
      }
      const file = await noteLane(repo, lane, args.text);
      return text(`noted → ${path.relative(repo, file)} (append-only; a human/serial lane integrates it into the shared plan)`);
    },
    async tasks_ack(args) {
      const repo = await requireRepo();
      const { kind, lane, merged } = await ackLane(repo, args.lane);
      if (kind === 'land') return text(`landed '${args.lane}' — merged ${merged.branch} into ${merged.base} (${merged.commit})`);
      if (kind === 'gate') return text(`acked manual gate on '${args.lane}', cursor -> ${lane.cursor}`);
      if (kind === 'failure') return text(`cleared parked failure on '${args.lane}', will retry`);
      if (kind === 'budget') return text(`cleared budget block on '${args.lane}' (raise the cap or it will re-block)`);
      return text(`'${args.lane}' has no open gate`);
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const handler = handlers[name];
    if (!handler) {
      return { ...text(`taskherd: unknown tool '${name}'`), isError: true };
    }
    try {
      return await handler(args || {});
    } catch (err) {
      // Loud, structured failure back to the agent (DESIGN §1) — a thrown
      // error would surface as an opaque protocol fault instead.
      return { ...text(err.message), isError: true };
    }
  });

  return server;
}
