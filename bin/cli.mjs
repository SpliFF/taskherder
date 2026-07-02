#!/usr/bin/env node
// taskherd — CLI entry (DESIGN.md §18). M1: init/run/status/add/block/ack/
// attach/pause/resume, command + manual step types only.
import { existsSync, statSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'node:net';
import { parseArgs } from 'node:util';

import { repoTasksDir, pausedFile, runSocketPath } from '../src/paths.mjs';
import {
  initTasksDir, laneExists, loadLane, saveLane, newLane, validateStep, ackLane,
} from '../src/tasks.mjs';
import { tick } from '../src/scheduler.mjs';
import { renderStatus } from '../src/history.mjs';

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

async function cmdAdd(argv) {
  const { values, positionals } = parseRepoOnly(argv, {
    type: { type: 'string', default: 'command' },
    message: { type: 'string' },
    file: { type: 'string' },
    'on-empty': { type: 'string' },
  });
  const { repo, rest } = resolveRepo(values.repo, positionals);
  requireTasksDir(repo);
  const [laneName, ...taskParts] = rest;
  if (!laneName) {
    console.error('taskherd: usage: taskherd add [-C repo] <lane> [--type command|manual] "<task>"');
    process.exit(1);
  }
  const task = taskParts.join(' ');

  const lane = (await laneExists(repo, laneName)) ? await loadLane(repo, laneName) : newLane(laneName);
  const step = values.type === 'manual'
    ? { type: 'manual', message: values.message || task, ...(values.file ? { file: values.file } : {}), status: 'pending' }
    : { type: 'command', run: task, status: 'pending' };
  validateStep(step);
  lane.steps.push(step);
  if (values['on-empty']) lane.onEmpty = values['on-empty'];
  await saveLane(repo, lane);
  console.log(`taskherd: added step ${lane.steps.length - 1} (${step.type}) to lane '${laneName}'`);
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
  const { kind, lane } = await ackLane(repo, laneName);
  if (kind === 'gate') console.log(`taskherd: acked manual gate on '${laneName}', cursor -> ${lane.cursor}`);
  else if (kind === 'failure') console.log(`taskherd: cleared parked failure on '${laneName}', will retry`);
  else console.log(`taskherd: '${laneName}' has no open gate`);
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

const COMMANDS = {
  init: cmdInit,
  run: cmdRun,
  status: cmdStatus,
  add: cmdAdd,
  block: cmdBlock,
  ack: cmdAck,
  attach: cmdAttach,
  pause: cmdPause,
  resume: cmdResume,
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
