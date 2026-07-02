// The executor (DESIGN.md §3, §13) — the seam: every `command` step runs under
// a pty, capture goes to logs/, structured events go to events.jsonl, and a
// control socket accepts `input` (keystrokes) / `signal` (INT/TERM) / `detach`.
import { createWriteStream, existsSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { appendFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import pty from 'node-pty';
import {
  eventsFile, logsDir, runSocketPath, runSocketLink,
} from './paths.mjs';

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000; // 45m, matches config.json's default

// Some npm install pipelines extract node-pty's prebuilt `spawn-helper`
// without the executable bit (observed here: prebuild ships 0644), which
// makes every run fail with an opaque `posix_spawnp failed.`. Self-heal it
// once per process instead of surfacing that cryptic error to every user.
function ensureSpawnHelperExecutable() {
  try {
    const require = createRequire(import.meta.url);
    const prebuildsDir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
    if (!existsSync(prebuildsDir)) return;
    for (const platformDir of readdirSync(prebuildsDir)) {
      const helper = path.join(prebuildsDir, platformDir, 'spawn-helper');
      if (!existsSync(helper)) continue;
      if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch (err) {
    console.error(`FIDELITY-STANDIN: could not verify node-pty spawn-helper is executable: ${err.message}`);
  }
}
ensureSpawnHelperExecutable();

function parseTimeout(timeout) {
  if (!timeout) return DEFAULT_TIMEOUT_MS;
  if (typeof timeout === 'number') return timeout;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(timeout.trim());
  if (!m) return DEFAULT_TIMEOUT_MS;
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] || 'ms'];
  return n * unit;
}

async function appendEvent(repo, event) {
  await appendFile(eventsFile(repo), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function shellArgv(step) {
  if (step.argv) return { file: step.argv[0], args: step.argv.slice(1) };
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
  const flag = process.platform === 'win32' ? '/c' : '-c';
  return { file: shell, args: [flag, step.run] };
}

// Runs one `command` step to completion. Resolves { status: 'done'|'failed', exitCode }.
// Never rejects on the child's own failure — only on setup errors (bad argv, io).
export async function runStep(repo, lane, step, index, resolvedConfig) {
  const id = randomUUID();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logsDir(repo), `${lane.name}-${ts}.log`);
  const sockPath = runSocketPath(repo, lane.name);
  const sockLink = runSocketLink(repo, lane.name);
  await rm(sockPath, { force: true });
  await rm(sockLink, { force: true });

  const { file, args } = shellArgv(step);
  const logStream = createWriteStream(logPath);
  const clients = new Set();

  const server = createServer((socket) => {
    clients.add(socket);
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
          if (msg.type === 'input') child.write(msg.data);
          else if (msg.type === 'signal') child.kill(msg.signal || 'SIGINT');
          else if (msg.type === 'resize' && msg.cols && msg.rows) child.resize(msg.cols, msg.rows);
        } catch {
          // Malformed control message — ignore rather than crash the run.
        }
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(sockPath, resolve);
  });
  // `sockPath` is a short /tmp path to stay under AF_UNIX's ~104-byte limit;
  // this symlink keeps the documented `.tasks/run/<lane>.sock` location
  // (DESIGN §4) discoverable for `ls`/tooling. Nothing connects through it.
  await symlink(sockPath, sockLink);

  const child = pty.spawn(file, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: repo,
    env: process.env,
  });

  await appendEvent(repo, { event: 'run.start', lane: lane.name, step: index, id, argv: [file, ...args] });

  child.onData((data) => {
    logStream.write(data);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), event: 'output', lane: lane.name, step: index, id, data: Buffer.from(data, 'utf8').toString('base64') })}\n`;
    for (const socket of clients) socket.write(line);
  });

  const timeoutMs = parseTimeout(resolvedConfig?.timeout);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);

  const { exitCode } = await new Promise((resolve) => {
    child.onExit(({ exitCode: code, signal }) => resolve({ exitCode: code, signal }));
  });
  clearTimeout(timer);

  logStream.end();
  await appendEvent(repo, { event: 'run.exit', lane: lane.name, step: index, id, code: exitCode, timedOut });
  for (const socket of clients) socket.end();
  await new Promise((resolve) => server.close(resolve));
  await rm(sockPath, { force: true });
  await rm(sockLink, { force: true });

  return {
    status: exitCode === 0 && !timedOut ? 'done' : 'failed',
    exitCode: timedOut ? null : exitCode,
    timedOut,
    logPath,
  };
}
