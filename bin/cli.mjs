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

function takeRepoArg(positionals) {
  if (positionals.length && existsSync(positionals[0]) && statSync(positionals[0]).isDirectory()) {
    return { repo: path.resolve(positionals.shift()), rest: positionals };
  }
  return { repo: process.cwd(), rest: positionals };
}

function requireTasksDir(repo) {
  if (!existsSync(repoTasksDir(repo))) {
    console.error(`taskherd: no .tasks/ in ${repo} — run \`taskherd init\` first`);
    process.exit(1);
  }
}

async function cmdInit(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { 'no-global-gitignore': { type: 'boolean', default: false } },
  });
  const { repo } = takeRepoArg(positionals);
  await initTasksDir(repo, { globalGitignore: !values['no-global-gitignore'] });
  console.log(`taskherd: initialized ${repoTasksDir(repo)}`);
}

async function cmdRun(argv) {
  const { repo } = takeRepoArg(argv);
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
  const { repo } = takeRepoArg(argv);
  requireTasksDir(repo);
  console.log(await renderStatus(repo));
}

async function cmdAdd(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      type: { type: 'string', default: 'command' },
      message: { type: 'string' },
      file: { type: 'string' },
      'on-empty': { type: 'string' },
    },
  });
  const { repo, rest } = takeRepoArg(positionals);
  requireTasksDir(repo);
  const [laneName, ...taskParts] = rest;
  if (!laneName) {
    console.error('taskherd: usage: taskherd add [repo] <lane> [--type command|manual] "<task>"');
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
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { message: { type: 'string' }, file: { type: 'string' } },
  });
  await cmdAdd([...positionals, '--type', 'manual', '--message', values.message || '', ...(values.file ? ['--file', values.file] : [])]);
}

async function cmdAck(argv) {
  const { repo, rest } = takeRepoArg(argv);
  requireTasksDir(repo);
  const [laneName] = rest;
  if (!laneName) {
    console.error('taskherd: usage: taskherd ack [repo] <lane>');
    process.exit(1);
  }
  const { kind, lane } = await ackLane(repo, laneName);
  if (kind === 'gate') console.log(`taskherd: acked manual gate on '${laneName}', cursor -> ${lane.cursor}`);
  else if (kind === 'failure') console.log(`taskherd: cleared parked failure on '${laneName}', will retry`);
  else console.log(`taskherd: '${laneName}' has no open gate`);
}

async function cmdAttach(argv) {
  const { repo, rest } = takeRepoArg(argv);
  requireTasksDir(repo);
  const [laneName] = rest;
  if (!laneName) {
    console.error('taskherd: usage: taskherd attach [repo] <lane>');
    process.exit(1);
  }
  const sockPath = runSocketPath(repo, laneName);
  if (!existsSync(sockPath)) {
    console.log(`taskherd: '${laneName}' has no running step`);
    return;
  }
  await new Promise((resolve) => {
    const socket = connect(sockPath, resolve);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.event === 'output') process.stdout.write(Buffer.from(msg.data, 'base64'));
      }
    });
    socket.on('close', () => resolve());
    socket.on('error', () => resolve());
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      socket.write(`${JSON.stringify({ type: 'input', data: data.toString('utf8') })}\n`);
    });
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

async function cmdPause(argv) {
  const { repo } = takeRepoArg(argv);
  requireTasksDir(repo);
  await writeFile(pausedFile(repo), `${new Date().toISOString()}\n`);
  console.log('taskherd: paused — no lanes will run until `taskherd resume`');
}

async function cmdResume(argv) {
  const { repo } = takeRepoArg(argv);
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
