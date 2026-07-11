#!/usr/bin/env node
// taskherd — CLI entry (DESIGN.md §18). M1: init/run/status/add/block/ack/
// attach/pause/resume, command + manual step types only.
import { existsSync, statSync, lstatSync, readFileSync } from 'node:fs';
import {
  writeFile, rm, mkdir, chmod, symlink, realpath,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

import {
  repoTasksDir, pausedFile, runSocketPath, profileDir, profileFile, laneFile, clonePath,
} from '../src/paths.mjs';
import { readRunningSet } from '../src/admission.mjs';
import { containerGcPlan } from '../src/containers.mjs';
import { listRepoContainers, removeContainer } from '../src/containers-docker.mjs';
import {
  initTasksDir, ackLane, addStep, forkLane, loadAllLanesResilient,
} from '../src/tasks.mjs';
import { tick } from '../src/scheduler.mjs';
import { renderStatus, readHistory } from '../src/history.mjs';
import { loadProviders } from '../src/providers.mjs';
import { loadRunners, graphicalEndpoint } from '../src/runners.mjs';
import { listProfiles, loadProfile, isolationWarnings } from '../src/profiles.mjs';
import {
  isGitRepo, gcWorktrees, laneDiff, syncCloneBranch,
} from '../src/git.mjs';
import { loadProjectConfig, loadUserConfig, resolveConfig } from '../src/config.mjs';
import { parseBootstrap } from '../src/bootstrap.mjs';
import { registerProject } from '../src/registry.mjs';
import { createOutputRenderer } from '../src/render.mjs';
import { listLaneLogs, readLaneLog, readLatestLaneLog } from '../src/logs.mjs';

const REPO_OPTION = { repo: { type: 'string', short: 'C' } };

// For commands that also take a lane, a bare positional is only treated as the
// repo when it's unambiguously a repo path — it contains a path separator or
// already holds a `.tasks/` dir. Otherwise `taskherd add web "npm test"` (with
// a `web/` folder in cwd) would silently consume the lane name; use `-C <repo>`
// to be explicit (bug #7).
function looksLikeRepoArg(arg) {
  if (!arg || !existsSync(arg) || !statSync(arg).isDirectory()) return false;
  return arg.includes('/') || arg.includes(path.sep) || existsSync(path.join(arg, '.tasks'));
}

// Lane-less commands (init/run/status/pause/resume) have no other positional a
// bare argument could be, so any positional IS the repo — and a positional
// that isn't an existing directory is a loud error, never a silent fall-back
// to the cwd (running/initializing the wrong project must not happen quietly).
function resolveRepo(repoOpt, positionals, { laneless = false } = {}) {
  if (repoOpt) return { repo: path.resolve(repoOpt), rest: positionals };
  if (laneless && positionals.length) {
    const arg = positionals[0];
    if (!existsSync(arg) || !statSync(arg).isDirectory()) {
      console.error(`taskherd: no such directory '${arg}'`);
      process.exit(1);
    }
    return { repo: path.resolve(positionals.shift()), rest: positionals };
  }
  if (looksLikeRepoArg(positionals[0])) {
    return { repo: path.resolve(positionals.shift()), rest: positionals };
  }
  return { repo: process.cwd(), rest: positionals };
}

function parseRepoOnly(argv, extraOptions = {}) {
  return parseArgs({ args: argv, allowPositionals: true, options: { ...REPO_OPTION, ...extraOptions } });
}

function requireTasksDir(repo) {
  if (!existsSync(repoTasksDir(repo))) {
    console.error(`taskherd: no .tasks/ in ${repo} — run \`taskherd init\` first`);
    process.exit(1);
  }
}

// ── help + version ────────────────────────────────────────────────────────
// One table drives all three surfaces so they can never drift: the command
// list in `taskherd help`, each command's `help <cmd>` page, and the one-line
// usage a command prints when it is called wrong (usageError below). Order here
// is the order shown in help; keys must match COMMANDS (dispatch, bottom).
const COMMAND_HELP = {
  init: { summary: 'Initialize .tasks/ in a repo (register it, scaffold config)', usage: 'taskherd init [-C repo | <repo>] [--no-global-gitignore]' },
  run: { summary: 'Fire the scheduler once — run ONE step (--lane targets one lane)', usage: 'taskherd run [-C repo | <repo>] [--lane <name>] [--force]' },
  status: { summary: 'Show lanes, last result, open gates, and cost', usage: 'taskherd status [-C repo | <repo>]' },
  add: { summary: 'Queue a step onto a lane (command | ai | manual)', usage: 'taskherd add [-C repo] <lane> [--type command|ai|manual] [--at next|end|<index>] [--id <label>] [--waits-for <lane:id>]... [--after HH:MM] [--before HH:MM] [--days Mon-Fri] [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--tz local|utc] [--when \'<json rule>\'] [--isolation worktree|inplace|none|clone] [--land manual-gate|pr|leave] [--base <branch>] [--no-parallel] [--mutex <tag>]... [--lifecycle ephemeral] [--mcp-transport mount|none] [opts] "<task>"' },
  block: { summary: 'Add a manual gate that blocks a lane until acked', usage: 'taskherd block [-C repo] <lane> --message "<text>" [--at next|end|<index>] [--file <path>]' },
  fork: { summary: 'Split a new sibling lane off an existing one', usage: 'taskherd fork [-C repo] <new-lane> --from <parent> [add opts] ["<task>"]' },
  ack: { summary: 'Answer a gate / clear a parked failure / land a branch', usage: 'taskherd ack [-C repo] <lane>' },
  diff: { summary: "Show a lane's branch diff before landing", usage: 'taskherd diff [-C repo] <lane> [--base <branch>]' },
  logs: { summary: "List or replay a lane's past run logs (AI steps rendered readably)", usage: 'taskherd logs [-C repo] <lane> [--last | --file <name>]' },
  attach: { summary: "Attach to a running step's live terminal (Ctrl-] detaches)", usage: 'taskherd attach [-C repo] <lane>' },
  pause: { summary: 'Halt all lanes (the kill-switch)', usage: 'taskherd pause [-C repo | <repo>]' },
  resume: { summary: 'Clear the pause', usage: 'taskherd resume [-C repo | <repo>]' },
  gc: { summary: 'Remove finished worktrees and prune', usage: 'taskherd gc [-C repo | <repo>]' },
  auth: { summary: 'Manage per-account auth profiles', usage: 'taskherd auth login|list|logout <profile> [--provider <name>]' },
  history: { summary: 'Show recent run history', usage: 'taskherd history [-C repo | <repo>] [--limit <n>]' },
  cost: { summary: 'Show spend per lane', usage: 'taskherd cost [-C repo | <repo>]' },
  serve: { summary: 'Start the web console (HTTP + WebSocket)', usage: 'taskherd serve [-C repo | <repo>] [-p port] [--host <addr>] [--allow-shell] [--allow-gfx]' },
  install: { summary: 'Register the taskherd MCP server + link the /task skill', usage: 'taskherd install' },
  doctor: { summary: 'Check providers, runners, profiles, integrations', usage: 'taskherd doctor [-C repo | <repo>]' },
};

function version() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

// A command called with missing/invalid args: its one-line usage to stderr,
// exit 1 (a usage error, not a help request). Shared string, so `help <cmd>`
// and the "called wrong" message are always identical.
function usageError(name) {
  console.error(`taskherd: usage: ${COMMAND_HELP[name].usage}`);
  process.exit(1);
}

// `taskherd help [command]`, `--help`, `-h`, or a bare invocation. With a known
// command name → that command's page; otherwise the full command list. Prints
// to stdout and the caller exits 0 — help was asked for, it is not an error.
function printHelp(name) {
  if (name && COMMAND_HELP[name]) {
    const { summary, usage } = COMMAND_HELP[name];
    console.log(`taskherd ${name} — ${summary}\n\nUsage: ${usage}`);
    return;
  }
  const width = Math.max(...Object.keys(COMMAND_HELP).map((c) => c.length));
  const commands = Object.entries(COMMAND_HELP)
    .map(([c, h]) => `  ${c.padEnd(width)}  ${h.summary}`)
    .join('\n');
  console.log(`taskherd ${version()} — herd scheduled task lanes across projects, containers, and hosts

Usage: taskherd <command> [options]

Commands:
${commands}

Global options:
  -C, --repo <path>   Operate on this repo (default: the current directory)
  -h, --help          Show help; \`taskherd help <command>\` for one command
  -v, --version       Show the version

Docs: https://github.com/SpliFF/taskherder#readme`);
}

async function cmdInit(argv) {
  const { values, positionals } = parseRepoOnly(argv, {
    'no-global-gitignore': { type: 'boolean', default: false },
  });
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  await initTasksDir(repo, { globalGitignore: !values['no-global-gitignore'] });
  console.log(`taskherd: initialized ${repoTasksDir(repo)}`);
}

// taskherd run [-C repo | <repo>] [--lane <name>] [--force] — fire the
// scheduler once. Bare = the cron entrypoint: fair-pick one runnable lane
// across the repo. --lane <name> = a manual, one-lane run: advance just that
// lane's next step (same lock/gate/budget guards). --force overrides a PAUSE
// (the §12 kill-switch) for this one manual run. `<repo>` keeps the cron form.
async function cmdRun(argv) {
  const { values, positionals } = parseRepoOnly(argv, {
    lane: { type: 'string', short: 'l' },
    force: { type: 'boolean', short: 'f', default: false },
  });
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  const result = await tick(repo, { lane: values.lane || null, force: values.force });
  switch (result.outcome) {
    case 'paused': console.log('taskherd: paused, skipping (`taskherd resume`, or `run --force` for one run)'); break;
    case 'no-tasks-dir': console.log(`taskherd: no .tasks/ in ${repo} — run \`taskherd init\` first`); break;
    case 'locked': console.log('taskherd: another run in progress, skipping'); break;
    case 'not-runnable': console.log(`taskherd: lane '${result.lane}' not runnable — ${result.reason}`); break;
    case 'idle': console.log(`taskherd: nothing runnable (${result.lanes} lane(s)${result.running?.length ? `; running: ${result.running.join(', ')}` : ''})`); break;
    case 'held': {
      // §25 rule 3: a soft wait, not an error — every runnable lane was held
      // back by admission control this fire; the next fire re-checks.
      console.log(`taskherd: nothing admitted (running: ${(result.running || []).join(', ') || 'none'})`);
      for (const h of result.holds || []) console.log(`  ${h.lane}: ${h.reason}`);
      if (result.reason) console.log(`  ${result.reason}`);
      break;
    }
    case 'busy': console.log(`taskherd: runs still live from parallel fires (${(result.running || []).join(', ')}) — serial fire skipped`); break;
    case 'ran': console.log(`taskherd: ran ${result.lane}#${result.step} -> ${result.result}`); break;
    default: console.log(`taskherd: ${result.outcome}`);
  }
}

async function cmdStatus(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  requireTasksDir(repo);
  console.log(await renderStatus(repo));
}

// Maps parsed CLI flags onto the canonical camelCase opts that
// tasks.mjs buildStep/addStep/forkLane take (one step builder for every
// client — DESIGN §3; the MCP tools use the same one).
function stepOptsFromFlags(values, task) {
  return {
    type: values.type,
    task: task || undefined,
    message: values.message,
    file: values.file,
    id: values.id,
    waitsFor: values['waits-for'],
    when: values.when,
    after: values.after,
    before: values.before,
    days: values.days,
    from: values.from,
    until: values.until,
    tz: values.tz,
    provider: values.provider,
    model: values.model,
    profile: values.profile,
    runner: values.runner,
    session: values.session,
    permissionMode: values['permission-mode'],
    maxTurns: values['max-turns'],
    budgetUsd: values['budget-usd'],
    budgetPerDay: values['budget-per-day'],
    budgetPerRun: values['budget-per-run'],
  };
}

function laneOptsFromFlags(values) {
  return {
    isolation: values.isolation,
    land: values.land,
    base: values.base,
    onEmpty: values['on-empty'],
    asDefault: values.default,
    at: values.at,
    // §25 lane-level parallel fields: --no-parallel pins the lane to the
    // serial slot; --mutex declares shared-resource tags (repeat or comma-sep).
    parallel: values['no-parallel'] ? false : undefined,
    mutex: values.mutex && values.mutex.length ? values.mutex : undefined,
    // §26 container-lane attributes.
    lifecycle: values.lifecycle,
    mcpTransport: values['mcp-transport'],
  };
}

const ADD_OPTIONS = {
  type: { type: 'string', default: 'command' },
  message: { type: 'string' },
  file: { type: 'string' },
  id: { type: 'string' },
  'waits-for': { type: 'string', multiple: true },
  when: { type: 'string' },
  after: { type: 'string' },
  before: { type: 'string' },
  days: { type: 'string' },
  from: { type: 'string' },
  until: { type: 'string' },
  tz: { type: 'string' },
  'on-empty': { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  profile: { type: 'string' },
  isolation: { type: 'string' },
  runner: { type: 'string' },
  session: { type: 'string' },
  'permission-mode': { type: 'string' },
  'max-turns': { type: 'string' },
  'budget-usd': { type: 'string' },
  'budget-per-day': { type: 'string' },
  'budget-per-run': { type: 'boolean', default: false },
  land: { type: 'string' },
  base: { type: 'string' },
  default: { type: 'boolean', default: false },
  at: { type: 'string' },
  'no-parallel': { type: 'boolean', default: false },
  mutex: { type: 'string', multiple: true },
  lifecycle: { type: 'string' },
  'mcp-transport': { type: 'string' },
};

async function cmdAdd(argv) {
  const { values, positionals } = parseRepoOnly(argv, ADD_OPTIONS);
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName, ...taskParts] = rest;
  if (!laneName) usageError('add');
  const task = taskParts.join(' ');

  const { step, index } = await addStep(repo, laneName, stepOptsFromFlags(values, task), laneOptsFromFlags(values));
  if (index === 'default') {
    console.log(`taskherd: set lane '${laneName}' default (${step.type}, onEmpty=default)`);
  } else {
    console.log(`taskherd: added step ${index} (${step.type}) to lane '${laneName}'`);
  }
}

// taskherd fork <lane> --from <parent> (DESIGN §18): a NEW lane with `parent`
// set — an independent workstream (own branch/worktree) split off an existing
// lane. Optional trailing task / --type / --default seed its first work.
async function cmdFork(argv) {
  const { values, positionals } = parseRepoOnly(argv, { ...ADD_OPTIONS, from: { type: 'string' } });
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName, ...taskParts] = rest;
  if (!laneName || !values.from) usageError('fork');
  const task = taskParts.join(' ');
  const hasStep = Boolean(task || values.file || values.message);
  const lane = await forkLane(repo, laneName, values.from, {
    stepOpts: hasStep ? stepOptsFromFlags(values, task) : null,
    laneOpts: laneOptsFromFlags(values),
  });
  const seeded = lane.default ? ', recurring default set'
    : (lane.steps.length ? `, ${lane.steps.length} initial step(s)` : ', empty');
  console.log(`taskherd: forked lane '${laneName}' from '${values.from}'${seeded}`);
}

async function cmdBlock(argv) {
  const { values, positionals } = parseRepoOnly(argv, {
    message: { type: 'string' },
    file: { type: 'string' },
    at: { type: 'string' },
  });
  // A gate defaults to `next` — it stops the lane HERE, ahead of any pending
  // step at the cursor; append (`--at end`) would let that step fire first.
  const forward = [
    ...positionals, '--type', 'manual', '--message', values.message || '', '--at', values.at || 'next',
  ];
  if (values.file) forward.push('--file', values.file);
  if (values.repo) forward.push('--repo', values.repo);
  await cmdAdd(forward);
}

async function cmdAck(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName] = rest;
  if (!laneName) usageError('ack');
  const { kind, lane, merged } = await ackLane(repo, laneName);
  if (kind === 'land') console.log(`taskherd: landed '${laneName}' — merged ${merged.branch} into ${merged.base} (${merged.commit}); \`taskherd gc\` reclaims the worktree`);
  else if (kind === 'gate') console.log(`taskherd: acked manual gate on '${laneName}', cursor -> ${lane.cursor}`);
  else if (kind === 'failure') console.log(`taskherd: cleared parked failure on '${laneName}', will retry`);
  else if (kind === 'budget') console.log(`taskherd: cleared budget block on '${laneName}' (raise the cap or it will re-block)`);
  else console.log(`taskherd: '${laneName}' has no open gate`);
}

// taskherd gc — remove finished worktrees + prune (DESIGN §7). "Finished" =
// clean and merged (or the lane file is gone); everything kept says why.
async function cmdGc(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  requireTasksDir(repo);
  if (!(await isGitRepo(repo))) {
    console.log('taskherd: not a git repository — no worktrees to gc');
    return;
  }
  const projectConfig = await loadProjectConfig(repo);
  const report = await gcWorktrees(repo, projectConfig.base || null);
  for (const r of report) {
    console.log(`  ${r.action === 'removed' ? '✓' : '·'} ${r.lane}: ${r.action} — ${r.reason}`);
  }

  // §26 M11b: reap taskherd-managed containers alongside their clones (the same
  // clean-AND-merged-or-deleted gate gcWorktrees applied) + a label-based orphan
  // sweep, but NEVER a container whose lane has a live §25 run manifest.
  const containers = await listRepoContainers(repo);
  if (containers.length) {
    const running = await readRunningSet(repo, { reap: false });
    const runningLanes = new Set(running.running.map((m) => m.lane));
    const laneFiles = new Set(containers.map((c) => c.lane).filter((lane) => lane && existsSync(laneFile(repo, lane))));
    const clones = new Set(containers.map((c) => c.lane).filter((lane) => lane && existsSync(path.join(clonePath(repo, lane), '.git'))));
    const plan = containerGcPlan({
      containers, laneFiles, clones, runningLanes,
    });
    for (const p of plan) {
      if (p.action === 'reap') {
        await removeContainer(p.name);
        console.log(`  ✓ ${p.lane || p.name}: container removed — ${p.reason}`);
      } else {
        console.log(`  · ${p.lane || p.name}: container kept — ${p.reason}`);
      }
    }
  }

  if (report.length === 0 && containers.length === 0) {
    console.log('taskherd: no worktrees');
  }
}

// taskherd diff <lane> — the lane's branch diff (DESIGN §15 Layer 2, CLI-side;
// the console renders the same laneDiff data). Reviewing what an autonomous
// agent committed to taskherd/<lane> before `taskherd ack` lands it. (§18 lists
// no diff verb — recorded in PLAN as a CLI addition, like `install`.)
async function cmdDiff(argv) {
  const { values, positionals } = parseRepoOnly(argv, { base: { type: 'string' } });
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName] = rest;
  if (!laneName) usageError('diff');
  if (!(await isGitRepo(repo))) {
    console.log('taskherd: not a git repository — no lane branches to diff');
    return;
  }
  // A clone lane's commits live in its own object store — pull the branch into
  // the main repo before diffing (tolerant no-op for worktree/inplace lanes).
  await syncCloneBranch(repo, laneName);
  const d = await laneDiff(repo, laneName, { base: values.base || null });
  if (!d.exists) {
    console.log(`taskherd: lane '${laneName}' has no branch ${d.branch} yet (never ran under git isolation)`);
    return;
  }
  console.log(`taskherd: ${d.branch} vs ${d.base} — ${d.ahead} commit(s) ahead, ${d.files.length} file(s) changed${d.dirty ? '; worktree has uncommitted changes' : ''}`);
  for (const f of d.files) {
    console.log(`  ${f.binary ? 'bin' : `+${f.added} -${f.deleted}`}\t${f.path}`);
  }
  if (d.patch) {
    console.log('');
    process.stdout.write(d.patch.endsWith('\n') ? d.patch : `${d.patch}\n`);
  }
  if (d.truncated) console.log(`taskherd: diff truncated at ${d.bytes} bytes — inspect the full diff in the worktree`);
}

// `taskherd logs <lane>` — the post-run/historical half of `attach`: once a step
// exits its control socket is gone, but the pty log FILE remains. No flag lists
// the lane's logs (newest first); `--last`/`--file` replays one through the same
// stream-json renderer attach uses, so an ai run reads back as a transcript.
async function cmdLogs(argv) {
  const { values, positionals } = parseRepoOnly(argv, { file: { type: 'string' }, last: { type: 'boolean' } });
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName] = rest;
  if (!laneName) usageError('logs');

  // Replay one log (chosen file, or the newest with --last) through the renderer.
  if (values.file || values.last) {
    const log = values.file
      ? await readLaneLog(repo, laneName, values.file)
      : await readLatestLaneLog(repo, laneName);
    if (!log.exists) {
      console.log(`taskherd: no log to show for '${laneName}'${values.file ? ` (file '${values.file}')` : ''}`);
      return;
    }
    console.log(`taskherd: ${log.file}${log.truncated ? ` (truncated at ${log.bytes} bytes)` : ''}`);
    const renderer = createOutputRenderer(process.stdout);
    renderer.feed(log.text);
    renderer.flush();
    if (!log.text.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  // Default: list the lane's logs, newest first.
  const logs = await listLaneLogs(repo, laneName);
  if (logs.length === 0) {
    console.log(`taskherd: lane '${laneName}' has no logs yet`);
    return;
  }
  console.log(`taskherd: ${logs.length} log(s) for '${laneName}' (newest first) — replay with --last or --file <name>`);
  for (const l of logs) {
    console.log(`  ${new Date(l.mtime).toISOString()}  ${String(l.bytes).padStart(8)}B  ${l.file}`);
  }
}

async function cmdAttach(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName] = rest;
  if (!laneName) usageError('attach');
  const sockPath = runSocketPath(repo, laneName);
  if (!existsSync(sockPath)) {
    console.log(`taskherd: '${laneName}' has no running step`);
    return;
  }
  const DETACH = 0x1d; // Ctrl-]
  console.log(`taskherd: attached to '${laneName}' — press Ctrl-] to detach`);
  await new Promise((resolve) => {
    let connected = false;
    const socket = connect(sockPath);

    const sendResize = () => {
      if (process.stdout.columns && process.stdout.rows) {
        socket.write(`${JSON.stringify({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows })}\n`);
      }
    };
    const onWinch = () => sendResize();
    // Render AI steps' stream-json into a readable live transcript, exactly like
    // the web console (shared src/render.mjs). Command/plain steps sniff to raw
    // and pass through unchanged. A streaming UTF-8 decoder keeps a multibyte
    // char split across output frames intact.
    const renderer = createOutputRenderer(process.stdout);
    const decoder = new TextDecoder();
    const cleanup = () => {
      renderer.flush(); // paint any final event that arrived without a trailing newline
      process.removeListener('SIGWINCH', onWinch);
      process.stdin.removeAllListeners('data');
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    socket.on('connect', () => {
      connected = true;
      sendResize(); // forward the real terminal size on attach
      process.on('SIGWINCH', onWinch);
    });

    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'output') renderer.feed(decoder.decode(Buffer.from(msg.data, 'base64'), { stream: true }));
        } catch {
          // ignore a malformed event line rather than kill the attach
        }
      }
    });
    socket.on('close', () => { cleanup(); resolve(); });
    socket.on('error', () => {
      cleanup();
      if (!connected) {
        console.log(`taskherd: could not attach to '${laneName}' — its socket is stale (the step likely died); check .tasks/logs/`);
      }
      resolve();
    });

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      if (data.length === 1 && data[0] === DETACH) {
        socket.write(`${JSON.stringify({ type: 'detach' })}\n`);
        socket.end();
        cleanup();
        resolve();
        return;
      }
      socket.write(`${JSON.stringify({ type: 'input', data: data.toString('utf8') })}\n`);
    });
  });
}

async function cmdPause(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  requireTasksDir(repo);
  await writeFile(pausedFile(repo), `${new Date().toISOString()}\n`);
  console.log('taskherd: paused — no lanes will run until `taskherd resume`');
}

async function cmdResume(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  requireTasksDir(repo);
  await rm(pausedFile(repo), { force: true });
  console.log('taskherd: resumed');
}

// taskherd serve — the optional web-console control plane (DESIGN §15).
// Binds loopback by default; exposing it on a LAN (--host) is a deliberate
// opt-in — remote/mobile access is expected to go through a tunnel/Tailscale,
// and every state-touching request needs the printed token either way.
async function cmdServe(argv) {
  const { values, positionals } = parseRepoOnly(argv, {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'allow-shell': { type: 'boolean', default: false },
    'allow-gfx': { type: 'boolean', default: false },
  });
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  if (existsSync(repoTasksDir(repo))) await registerProject(repo);

  const { createConsoleServer } = await import('../src/serve.mjs');
  const allowShell = values['allow-shell'];
  const allowGfx = values['allow-gfx'];
  const console_ = await createConsoleServer({ allowShell, allowGfx });
  const host = values.host || '127.0.0.1';
  const port = values.port ? Number(values.port) : 4373; // H-E-R-D on a phone keypad
  const addr = await console_.listen(port, host);

  const urls = [];
  if (host === '0.0.0.0' || host === '::') {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces || []) {
        if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${addr.port}`);
      }
    }
    urls.unshift(`http://127.0.0.1:${addr.port}`);
  } else {
    urls.push(`http://${host}:${addr.port}`);
  }
  console.log('taskherd: console up — open (token included, keep it private):');
  for (const u of urls) console.log(`  ${u}/?token=${console_.token}`);
  if (host === '127.0.0.1') {
    console.log('  (loopback only — use --host 0.0.0.0 or a tunnel for phone access)');
  }
  if (allowShell) {
    console.log('taskherd: WARNING web-SSH ENABLED (--allow-shell) — the console can open interactive');
    console.log('          shells (local / docker / ssh) as this user; anyone with the token gets a shell.');
    if (host !== '127.0.0.1') {
      console.log('          You are NOT on loopback — make sure the token stays private (DESIGN §12/§15).');
    }
  }
  if (allowGfx) {
    console.log('taskherd: WARNING graphical streaming ENABLED (--allow-gfx) — the console can proxy an');
    console.log('          in-runner Xpra/noVNC GUI (interactive desktop control) for runners.json runners');
    console.log('          that declare a "graphical" endpoint; anyone with the token gets that GUI.');
    const gfxPort = console_.gfxPort?.();
    if (gfxPort) {
      console.log(`          The GUI proxy is served on a SEPARATE origin (port ${gfxPort}) so a proxied`);
      console.log('          runner GUI cannot read the console token — that port must be reachable by the');
      console.log('          browser too (a single-port tunnel will not forward it).');
    }
    if (host !== '127.0.0.1') {
      console.log('          You are NOT on loopback — make sure the token stays private (DESIGN §12/§15).');
    }
  }

  await new Promise((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
  await console_.close();
  console.log('taskherd: console stopped');
}

function commandOnPath(cmd) {
  // `command -v` is a POSIX shell builtin (not an external binary), so it needs a
  // shell — but pass the name as a positional ($1), NOT interpolated into the
  // command line, so a provider name like `x; rm -rf ~` from providers.json can't
  // execute (no `shell:true`).
  const r = process.platform === 'win32'
    ? spawnSync('where', [cmd], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', cmd], { encoding: 'utf8' });
  return r.status === 0;
}

// taskherd auth login|list|logout <profile> — manage per-account profiles (DESIGN §9).
async function cmdAuth(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { provider: { type: 'string' } },
  });
  const [sub, name] = positionals;

  if (sub === 'list') {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log('taskherd: no profiles yet — `taskherd auth login <name>` to create one');
      return;
    }
    for (const p of profiles) {
      let provider = '?';
      let warnings = [];
      try {
        const prof = await loadProfile(p);
        provider = prof.provider || '(unset)';
        warnings = isolationWarnings(prof);
      } catch (err) {
        warnings = [err.message];
      }
      console.log(`${p}  provider=${provider}`);
      for (const w of warnings) console.log(`  ⚠ ${w}`);
    }
    return;
  }

  if (!name) usageError('auth');

  if (sub === 'login') {
    const provider = values.provider || 'claude';
    const dir = profileDir(name);
    await mkdir(dir, { recursive: true });
    const file = profileFile(name);
    if (!existsSync(file)) {
      const configDir = path.join(dir, provider);
      await mkdir(configDir, { recursive: true });
      const profile = { provider, env: { CLAUDE_CONFIG_DIR: configDir } };
      await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`);
      await chmod(file, 0o600);
      console.log(`taskherd: scaffolded profile '${name}' at ${file}`);
    }
    const prof = await loadProfile(name);
    for (const w of isolationWarnings(prof)) console.log(`  ⚠ ${w}`);
    const envAssign = Object.entries(prof.env || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`taskherd: log this account in with its isolated config, then scheduled runs reuse it:`);
    console.log(`  ${envAssign} ${provider} /login`);
    return;
  }

  if (sub === 'logout') {
    const provider = values.provider || 'claude';
    const configDir = path.join(profileDir(name), provider);
    if (existsSync(configDir)) {
      await rm(configDir, { recursive: true, force: true });
      console.log(`taskherd: cleared '${name}' credentials (${configDir}); profile.json kept`);
    } else {
      console.log(`taskherd: '${name}' has no ${provider} credentials to clear`);
    }
    return;
  }

  console.error(`taskherd: unknown auth subcommand '${sub}' (login|list|logout)`);
  process.exit(1);
}

async function cmdHistory(argv) {
  const { values, positionals } = parseRepoOnly(argv, { limit: { type: 'string' } });
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  requireTasksDir(repo);
  const history = await readHistory(repo);
  const limit = values.limit ? Number(values.limit) : 20;
  const recent = history.slice(-limit);
  if (recent.length === 0) {
    console.log('taskherd: no history yet');
    return;
  }
  for (const rec of recent) {
    const cost = typeof rec.cost === 'number' ? `  $${rec.cost.toFixed(4)}` : '';
    const dur = rec.durationMs != null ? `  ${Math.round(rec.durationMs)}ms` : '';
    const commit = rec.commit ? `  @${rec.commit}` : '';
    console.log(`${rec.ts}  ${rec.lane}#${rec.step} (${rec.type || rec.kind})  ${rec.result}${dur}${commit}${cost}`);
  }
}

async function cmdCost(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  requireTasksDir(repo);
  const history = await readHistory(repo);
  const byLane = {};
  let total = 0;
  for (const rec of history) {
    if (typeof rec.cost !== 'number') continue;
    byLane[rec.lane] = (byLane[rec.lane] || 0) + rec.cost;
    total += rec.cost;
  }
  if (total === 0) {
    console.log('taskherd: no cost recorded yet (ai runs with a cost-JSON provider log spend)');
    return;
  }
  for (const [lane, spent] of Object.entries(byLane).sort()) {
    console.log(`${lane}  $${spent.toFixed(4)}`);
  }
  console.log(`total  $${total.toFixed(4)}`);
}

function mcpBinPath() {
  return fileURLToPath(new URL('./mcp.mjs', import.meta.url));
}

function skillSrcDir() {
  return fileURLToPath(new URL('../skill/task', import.meta.url));
}

// The /task skill is linked into the user's Claude skills dir (user-global,
// like the MCP registration — DESIGN §19 "bundled skill").
function skillLinkPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'skills', 'task');
}

async function skillLinkState() {
  const link = skillLinkPath();
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) {
    try {
      if (await realpath(link) === await realpath(skillSrcDir())) return 'ok';
    } catch {
      return 'broken';
    }
  }
  return 'other'; // a real dir or a foreign symlink — never clobber it
}

function mcpRegistrationState() {
  if (!commandOnPath('claude')) return 'no-claude';
  const r = spawnSync('claude', ['mcp', 'get', 'taskherd'], { encoding: 'utf8' });
  return r.status === 0 ? 'ok' : 'missing';
}

// taskherd install — user-global integrations (DESIGN §16, §19): register
// taskherd-mcp in the claude CLI's user scope and link the bundled /task
// skill. Idempotent; refuses loudly rather than clobbering anything foreign.
// (§18 has no verb for this — recorded in PLAN as a CLI addition.)
async function cmdInstall() {
  let problems = 0;

  const mcpState = mcpRegistrationState();
  if (mcpState === 'ok') {
    console.log("✓ MCP server 'taskherd' already registered (claude mcp get taskherd)");
  } else if (mcpState === 'no-claude') {
    problems += 1;
    console.log('✗ claude CLI not on PATH — register taskherd-mcp in your agent\'s user-global MCP config yourself:');
    console.log(`    command: ${commandOnPath('taskherd-mcp') ? 'taskherd-mcp' : `${process.execPath} ${mcpBinPath()}`}`);
  } else {
    // A global npm install puts taskherd-mcp on PATH (survives package moves);
    // a dev checkout registers the absolute script path instead.
    const cmdArgs = commandOnPath('taskherd-mcp') ? ['taskherd-mcp'] : [process.execPath, mcpBinPath()];
    const r = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'taskherd', '--', ...cmdArgs], { encoding: 'utf8' });
    if (r.status === 0) {
      console.log(`✓ registered MCP server 'taskherd' user-globally (${cmdArgs.join(' ')})`);
    } else {
      problems += 1;
      console.log(`✗ claude mcp add failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
    }
  }

  const skillState = await skillLinkState();
  if (skillState === 'ok') {
    console.log(`✓ /task skill already linked (${skillLinkPath()})`);
  } else if (skillState === 'other' || skillState === 'broken') {
    problems += 1;
    console.log(`✗ ${skillLinkPath()} exists but is not a link to this package's skill/task — move it aside, then re-run \`taskherd install\``);
  } else {
    await mkdir(path.dirname(skillLinkPath()), { recursive: true });
    await symlink(skillSrcDir(), skillLinkPath());
    console.log(`✓ linked /task skill: ${skillLinkPath()} -> ${skillSrcDir()}`);
  }

  if (problems > 0) process.exit(1);
}

// taskherd doctor — check providers, profiles, MCP, node-pty (DESIGN §18).
async function cmdDoctor(argv = []) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  let problems = 0;
  console.log('taskherd doctor');

  console.log('providers:');
  const providers = await loadProviders();
  for (const [name, def] of Object.entries(providers)) {
    const ok = commandOnPath(def.command);
    if (!ok) problems += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${name} -> ${def.command}${ok ? '' : ' (not on PATH)'}`);
  }

  console.log('runners:');
  {
    // local is always available; docker/ssh need their client on PATH. A named
    // runner in runners.json is checked against the CLI its kind requires.
    console.log('  ✓ local (host)');
    let runners = {};
    try {
      runners = await loadRunners();
    } catch (err) {
      problems += 1;
      console.log(`  ✗ runners.json: ${err.message}`);
    }
    const names = Object.keys(runners);
    if (names.length === 0) {
      console.log('  · no named runners (~/.taskherd/runners.json) — inline docker:<ctr> / ssh:<host> still work');
    }
    for (const [name, def] of names.map((n) => [n, runners[n]])) {
      const cli = def.kind === 'ssh' ? 'ssh' : 'docker';
      const ok = def.kind === 'docker' || def.kind === 'ssh' ? commandOnPath(cli) : false;
      if (!ok) problems += 1;
      const target = def.container || def.image || def.host || '?';
      console.log(`  ${ok ? '✓' : '✗'} ${name} (${def.kind || 'no kind'} → ${target})${ok ? '' : ` — ${def.kind ? `${cli} not on PATH` : 'needs "kind": docker|ssh'}`}`);
      if (def.graphical) {
        // §15 L2 graphical endpoint — validate the block shape (reachability needs a
        // live server, verified only when the console proxies it under --allow-gfx).
        try {
          const g = graphicalEndpoint(def);
          console.log(`      ↳ graphical: ${g.kind} → ${g.httpBase} (stream via \`taskherd serve --allow-gfx\`)`);
        } catch (err) {
          problems += 1;
          console.log(`      ↳ ✗ graphical misconfigured: ${err.message}`);
        }
      }
    }
    // Flag the inline-runner CLIs so `docker:`/`ssh:` axis values fail loud, not late.
    for (const cli of ['docker', 'ssh']) {
      const ok = commandOnPath(cli);
      console.log(`  ${ok ? '✓' : '·'} ${cli} ${ok ? 'on PATH' : `not on PATH — ${cli}:<…> runners will park a lane`}`);
    }
  }

  console.log('profiles:');
  const profiles = listProfiles();
  if (profiles.length === 0) console.log('  (none)');
  for (const p of profiles) {
    try {
      const prof = await loadProfile(p);
      const warnings = isolationWarnings(prof);
      console.log(`  ${warnings.length ? '⚠' : '✓'} ${p} (provider=${prof.provider || 'unset'})`);
      for (const w of warnings) console.log(`     ${w}`);
    } catch (err) {
      problems += 1;
      console.log(`  ✗ ${p}: ${err.message}`);
    }
  }

  console.log('integrations:');
  {
    const mcpState = mcpRegistrationState();
    if (mcpState === 'no-claude') {
      console.log('  · claude CLI not on PATH — cannot check the MCP registration');
    } else if (mcpState === 'ok') {
      console.log("  ✓ MCP server 'taskherd' registered");
    } else {
      problems += 1;
      console.log("  ✗ taskherd-mcp not registered — run `taskherd install` (agents can't enqueue their own next step/gate without it)");
    }
    const skillState = await skillLinkState();
    if (skillState === 'ok') {
      console.log('  ✓ /task skill linked');
    } else {
      problems += 1;
      console.log(`  ✗ /task skill not linked (${skillState}) — run \`taskherd install\``);
    }
  }

  console.log('runtime:');
  {
    const ok = commandOnPath('git');
    if (!ok) problems += 1;
    console.log(`  ${ok ? '✓' : '✗'} git${ok ? '' : ' not on PATH — worktree/inplace isolation and land need it'}`);
  }
  {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    try {
      require.resolve('node-pty');
      console.log('  ✓ node-pty resolvable (executor self-heals a non-executable spawn-helper)');
    } catch {
      problems += 1;
      console.log('  ✗ node-pty not installed — run `npm install`');
    }
    try {
      require.resolve('ws');
      require.resolve('@xterm/xterm/package.json');
      console.log('  ✓ web console deps resolvable (ws, @xterm/xterm)');
    } catch {
      problems += 1;
      console.log('  ✗ web console deps missing (ws / @xterm/xterm) — run `npm install`; `taskherd serve` will not start');
    }
  }

  // Project-level checks (only when a .tasks/ repo is in scope — doctor stays
  // useful as a pure user-level check outside one).
  if (existsSync(repoTasksDir(repo))) {
    console.log(`project (${repo}):`);
    const projectConfig = await loadProjectConfig(repo);
    const userConfig = await loadUserConfig();
    const gitRepo = await isGitRepo(repo);
    const { lanes } = await loadAllLanesResilient(repo);
    // §24: a lane that runs in a pool worktree without a seed manifest gets a
    // tree with tracked files only — tests fail on missing .env/deps in ways
    // the checkout can't explain. Advisory (·), not a problem: many repos
    // genuinely need no seeding.
    const worktreeLanes = lanes.filter((lane) => {
      const cfg = resolveConfig(null, lane, projectConfig, userConfig);
      const isolation = cfg.isolation ?? (gitRepo ? 'worktree' : 'none');
      return isolation === 'worktree';
    });
    const unseeded = worktreeLanes.filter((lane) => {
      const cfg = resolveConfig(null, lane, projectConfig, userConfig);
      return cfg.bootstrap == null;
    });
    if (worktreeLanes.length === 0) {
      console.log('  · no worktree lanes — bootstrap manifest not needed');
    } else if (unseeded.length > 0) {
      console.log(`  · ${unseeded.length} worktree lane(s) with no bootstrap manifest (${unseeded.map((l) => l.name).join(', ')}) — fresh worktrees get tracked files ONLY; if lanes need gitignored state (.env, installed deps, PLAN*.md), add "bootstrap": {"link"/"copy"/"generate"} to .tasks/config.json (DESIGN §24)`);
    }
    // A malformed manifest parks every worktree lane at seed time — surface it
    // here instead of at 3am.
    for (const [scope, cfg] of [['project', projectConfig], ['user', userConfig], ...lanes.map((l) => [`lane ${l.name}`, l])]) {
      if (cfg.bootstrap == null) continue;
      try {
        parseBootstrap(cfg.bootstrap);
        console.log(`  ✓ bootstrap manifest (${scope}) is well-formed`);
      } catch (err) {
        problems += 1;
        console.log(`  ✗ bootstrap manifest (${scope}): ${err.message}`);
      }
    }

    // §26 M11b: taskherd-managed per-lane containers (persistent lifecycle) and
    // any ephemeral leftovers. Empty when docker is absent (no lines). An
    // orphan (lane gone) or a stopped container is a `·` advisory, not a problem.
    for (const c of await listRepoContainers(repo)) {
      const laneGone = !c.lane || !existsSync(laneFile(repo, c.lane));
      if (laneGone) {
        console.log(`  · orphaned container ${c.name} (${c.status}) — lane gone; \`taskherd gc\` reaps it`);
      } else {
        console.log(`  ✓ container ${c.name} (${c.status}) for lane '${c.lane}'`);
      }
    }
  }

  console.log(problems === 0 ? 'all checks passed' : `${problems} problem(s) found`);
  if (problems > 0) process.exit(1);
}

const COMMANDS = {
  init: cmdInit,
  run: cmdRun,
  status: cmdStatus,
  add: cmdAdd,
  block: cmdBlock,
  fork: cmdFork,
  ack: cmdAck,
  diff: cmdDiff,
  logs: cmdLogs,
  attach: cmdAttach,
  pause: cmdPause,
  resume: cmdResume,
  gc: cmdGc,
  auth: cmdAuth,
  history: cmdHistory,
  cost: cmdCost,
  serve: cmdServe,
  install: cmdInstall,
  doctor: cmdDoctor,
};

const [, , cmd, ...rest] = process.argv;

// Version + help are global, resolved before command dispatch (CLI convention:
// -v/--version, -h/--help, a bare invocation, and a `help [command]` verb).
if (cmd === '--version' || cmd === '-v') {
  console.log(`taskherd ${version()}`);
  process.exit(0);
}
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp(rest[0]);
  process.exit(0);
}

const handler = COMMANDS[cmd];
if (!handler) {
  console.error(`taskherd: unknown command '${cmd}' — run \`taskherd help\` for the command list`);
  process.exit(1);
}
// `taskherd <command> --help` / `-h` → that command's page, without running it.
if (rest.includes('--help') || rest.includes('-h')) {
  printHelp(cmd);
  process.exit(0);
}
try {
  await handler(rest);
} catch (err) {
  console.error(`taskherd: ${err.message}`);
  process.exit(1);
}
