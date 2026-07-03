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
  initTasksDir, addStep, forkLane, ackLane,
} from './tasks.mjs';
import { renderStatus } from './history.mjs';

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
  isolation: { type: 'string', enum: ['worktree', 'inplace', 'none'], description: 'Git isolation for the lane.' },
  land: { type: 'string', enum: ['manual-gate', 'pr', 'leave'], description: 'Land policy when the lane completes.' },
  base: { type: 'string', description: 'Base branch the lane branch forks from / lands into.' },
  onEmpty: { type: 'string', enum: ['default', 'idle'], description: 'What an empty lane does each fire.' },
  asDefault: { type: 'boolean', description: 'Set the step as the lane\'s recurring default (runs every fire once the queue is empty) instead of appending it.' },
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
    name: 'tasks_add',
    description: 'Append a step to a lane (creates the lane on first use), or set the lane\'s recurring default with asDefault. Enqueue an explicit step only when the next fire needs a SPECIFIC prompt/model/provider — an onEmpty-default lane already runs its default each fire with no bookkeeping.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'Lane name (created if missing).' },
        ...STEP_PROPS,
        ...LANE_PROPS,
      },
      required: ['lane'],
    },
  },
  {
    name: 'tasks_block',
    description: 'Append a blocking manual gate to a lane: the lane pauses until a human acks; sibling lanes continue. Use for open threads that need a human — a design question, missing creds, a sign-off, an external action. Defaults to the current lane (TASKHERD_LANE) when running as a scheduled step.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'Lane to gate (default: the lane this step runs in, from TASKHERD_LANE).' },
        message: { type: 'string', description: 'What the human must decide/do — shown in status and NEEDS-ATTENTION.md.' },
        file: { type: 'string', description: 'Optional desc/*.md file (relative to .tasks/) with the full prose.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'tasks_fork',
    description: 'Fork a sibling lane off a parent: a NEW independent lane (own branch/worktree) for an independent workstream discovered mid-task. Give it an initial step (task/type/...) or a recurring default (asDefault). `from` defaults to the current lane (TASKHERD_LANE).',
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
    lane, name, from, isolation, land, base, onEmpty, asDefault, ...stepOpts
  } = args;
  return {
    lane, name, from, laneOpts: { isolation, land, base, onEmpty, asDefault }, stepOpts,
  };
}

function hasStepPayload(stepOpts) {
  return Boolean(stepOpts.task || stepOpts.run || stepOpts.message || stepOpts.file);
}

function text(s) {
  return { content: [{ type: 'text', text: s }] };
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
      const { index } = await addStep(repo, lane, { type: 'manual', message: args.message, file: args.file });
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
