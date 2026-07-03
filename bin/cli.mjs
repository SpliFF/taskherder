#!/usr/bin/env node
// taskherd — CLI entry (DESIGN.md §18). M1: init/run/status/add/block/ack/
// attach/pause/resume, command + manual step types only.
import { existsSync, statSync, lstatSync } from 'node:fs';
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
  repoTasksDir, pausedFile, runSocketPath, profileDir, profileFile,
} from '../src/paths.mjs';
import {
  initTasksDir, ackLane, addStep, forkLane,
} from '../src/tasks.mjs';
import { tick } from '../src/scheduler.mjs';
import { renderStatus, readHistory } from '../src/history.mjs';
import { loadProviders } from '../src/providers.mjs';
import { listProfiles, loadProfile, isolationWarnings } from '../src/profiles.mjs';
import { isGitRepo, gcWorktrees } from '../src/git.mjs';
import { loadProjectConfig } from '../src/config.mjs';

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

async function cmdInit(argv) {
  const { values, positionals } = parseRepoOnly(argv, {
    'no-global-gitignore': { type: 'boolean', default: false },
  });
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  await initTasksDir(repo, { globalGitignore: !values['no-global-gitignore'] });
  console.log(`taskherd: initialized ${repoTasksDir(repo)}`);
}

async function cmdRun(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo } = resolveRepo(values.repo, positionals, { laneless: true });
  const result = await tick(repo);
  switch (result.outcome) {
    case 'paused': console.log('taskherd: paused, skipping'); break;
    case 'no-tasks-dir': console.log(`taskherd: no .tasks/ in ${repo} — run \`taskherd init\` first`); break;
    case 'locked': console.log('taskherd: another run in progress, skipping'); break;
    case 'idle': console.log(`taskherd: nothing runnable (${result.lanes} lane(s))`); break;
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
  };
}

const ADD_OPTIONS = {
  type: { type: 'string', default: 'command' },
  message: { type: 'string' },
  file: { type: 'string' },
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
};

async function cmdAdd(argv) {
  const { values, positionals } = parseRepoOnly(argv, ADD_OPTIONS);
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName, ...taskParts] = rest;
  if (!laneName) {
    console.error('taskherd: usage: taskherd add [-C repo] <lane> [--type command|ai|manual] '
      + '[--isolation worktree|inplace|none] [--land manual-gate|pr|leave] [--base <branch>] [opts] "<task>"');
    process.exit(1);
  }
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
  if (!laneName || !values.from) {
    console.error('taskherd: usage: taskherd fork [-C repo] <new-lane> --from <parent> [add opts] ["<task>"]');
    process.exit(1);
  }
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
  });
  const forward = [...positionals, '--type', 'manual', '--message', values.message || ''];
  if (values.file) forward.push('--file', values.file);
  if (values.repo) forward.push('--repo', values.repo);
  await cmdAdd(forward);
}

async function cmdAck(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName] = rest;
  if (!laneName) {
    console.error('taskherd: usage: taskherd ack [-C repo] <lane>');
    process.exit(1);
  }
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
  if (report.length === 0) {
    console.log('taskherd: no worktrees');
    return;
  }
  for (const r of report) {
    console.log(`  ${r.action === 'removed' ? '✓' : '·'} ${r.lane}: ${r.action} — ${r.reason}`);
  }
}

async function cmdAttach(argv) {
  const { values, positionals } = parseRepoOnly(argv);
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName] = rest;
  if (!laneName) {
    console.error('taskherd: usage: taskherd attach [-C repo] <lane>');
    process.exit(1);
  }
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
    const cleanup = () => {
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
          if (msg.event === 'output') process.stdout.write(Buffer.from(msg.data, 'base64'));
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

function commandOnPath(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [cmd] : ['-v', cmd], { encoding: 'utf8', shell: process.platform !== 'win32' });
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

  if (!name) {
    console.error('taskherd: usage: taskherd auth login|list|logout <profile>');
    process.exit(1);
  }

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
async function cmdDoctor() {
  let problems = 0;
  console.log('taskherd doctor');

  console.log('providers:');
  const providers = await loadProviders();
  for (const [name, def] of Object.entries(providers)) {
    const ok = commandOnPath(def.command);
    if (!ok) problems += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${name} -> ${def.command}${ok ? '' : ' (not on PATH)'}`);
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
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    require.resolve('node-pty');
    console.log('  ✓ node-pty resolvable (executor self-heals a non-executable spawn-helper)');
  } catch {
    problems += 1;
    console.log('  ✗ node-pty not installed — run `npm install`');
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
  attach: cmdAttach,
  pause: cmdPause,
  resume: cmdResume,
  gc: cmdGc,
  auth: cmdAuth,
  history: cmdHistory,
  cost: cmdCost,
  install: cmdInstall,
  doctor: cmdDoctor,
};

const [, , cmd, ...rest] = process.argv;
const handler = COMMANDS[cmd];
if (!handler) {
  console.error(`taskherd: unknown command '${cmd}'\nAvailable: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}
try {
  await handler(rest);
} catch (err) {
  console.error(`taskherd: ${err.message}`);
  process.exit(1);
}
