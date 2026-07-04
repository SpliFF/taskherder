// The web console's control plane (DESIGN §15): a plain HTTP + WebSocket
// server that is nothing but a client of the file state + event stream — the
// CLI and cron keep working with it stopped. Serves the SPA, a small JSON API
// for state + mutations (all through the same tasks.mjs builders the CLI and
// MCP use), a WS tail of events.jsonl, and a WS bridge onto a running step's
// control socket (the §13 seam, remotely).
//
// Auth is required on every API/WS request (§15 — it can trigger tasks): a
// bearer token generated once into ~/.taskherd/serve-token (0600), passed as
// `Authorization: Bearer`, or `?token=` for browsers/WS. Static assets are
// served without it (they are code, not state). Binds 127.0.0.1 by default;
// remote/mobile access is a deliberate opt-in (--host) or a tunnel (§15).
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

import {
  taskherdHome, repoTasksDir, pausedFile, eventsFile, runSocketPath,
} from './paths.mjs';
import { loadProjects } from './registry.mjs';
import { statusData } from './history.mjs';
import { laneDiff } from './git.mjs';
import { resolveRunner, shellInvocation } from './runners.mjs';
import { ensureSpawnHelperExecutable } from './executor.mjs';
import {
  ackLane, addStep, forkLane, removeStep, moveStep, editStep, LaneValidationError,
} from './tasks.mjs';

const require = createRequire(import.meta.url);
const WEB_DIR = fileURLToPath(new URL('../web', import.meta.url));

function vendorFile(pkg, rel) {
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), rel);
}

// Fixed allowlist — the server never maps request paths onto the filesystem,
// so there is no traversal surface to defend.
const STATIC_FILES = {
  '/': [path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8'],
  '/app.mjs': [path.join(WEB_DIR, 'app.mjs'), 'text/javascript; charset=utf-8'],
  '/style.css': [path.join(WEB_DIR, 'style.css'), 'text/css; charset=utf-8'],
  '/vendor/xterm.mjs': [vendorFile('@xterm/xterm', 'lib/xterm.mjs'), 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': [vendorFile('@xterm/xterm', 'css/xterm.css'), 'text/css; charset=utf-8'],
  '/vendor/addon-fit.mjs': [vendorFile('@xterm/addon-fit', 'lib/addon-fit.mjs'), 'text/javascript; charset=utf-8'],
};

export function serveTokenFile() {
  return path.join(taskherdHome(), 'serve-token');
}

// One token per user, generated on first serve and reused so a phone bookmark
// keeps working across restarts. Rotate by deleting the file.
export async function ensureServeToken() {
  const file = serveTokenFile();
  try {
    const token = (await readFile(file, 'utf8')).trim();
    if (token) return token;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = randomBytes(24).toString('base64url');
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function tokenMatches(expected, presented) {
  if (typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  return url.searchParams.get('token');
}

function sendJson(res, status, body) {
  const data = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

const BODY_LIMIT = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new LaneValidationError('malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function resolveProject(id) {
  const projects = await loadProjects();
  const entry = projects[id];
  if (!entry) throw new LaneValidationError(`unknown project '${id}'`);
  if (!existsSync(repoTasksDir(entry.path))) {
    throw new LaneValidationError(`project '${id}' has no .tasks/ at ${entry.path} (moved or deleted?)`);
  }
  return entry.path;
}

async function projectSummaries() {
  const projects = await loadProjects();
  const out = [];
  for (const [id, entry] of Object.entries(projects)) {
    const base = { id, name: path.basename(entry.path), path: entry.path };
    if (!existsSync(repoTasksDir(entry.path))) {
      out.push({ ...base, missing: true });
      continue;
    }
    try {
      const status = await statusData(entry.path);
      out.push({
        ...base,
        missing: false,
        paused: existsSync(pausedFile(entry.path)),
        ...status,
      });
    } catch (err) {
      out.push({ ...base, missing: false, error: err.message });
    }
  }
  return out;
}

// One-shot control-socket message (the interrupt button): connect, say it, go.
// A missing/stale socket means nothing is running — a 409 for the API.
function sendControl(repo, lane, msg) {
  return new Promise((resolve, reject) => {
    const sock = connect(runSocketPath(repo, lane));
    sock.on('connect', () => {
      sock.end(`${JSON.stringify(msg)}\n`);
      resolve();
    });
    sock.on('error', () => reject(new Error(`lane '${lane}' has no running step`)));
  });
}

const CONTROL_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP']);

// POST /api/projects/:id/<action> — every mutation goes through the same
// shared tasks.mjs operations as the CLI and MCP (DESIGN §3).
async function handleAction(repo, action, body) {
  switch (action) {
    case 'ack': {
      const { kind } = await ackLane(repo, requireStr(body, 'lane'));
      return { ok: true, kind };
    }
    case 'add': {
      const { index, step } = await addStep(repo, requireStr(body, 'lane'), body.step || {}, body.laneOpts || {});
      return { ok: true, index, step };
    }
    case 'fork': {
      const lane = await forkLane(repo, requireStr(body, 'name'), requireStr(body, 'from'), {
        stepOpts: body.step || null,
        laneOpts: body.laneOpts || {},
      });
      return { ok: true, lane: lane.name };
    }
    case 'remove-step': {
      await removeStep(repo, requireStr(body, 'lane'), body.index);
      return { ok: true };
    }
    case 'move-step': {
      await moveStep(repo, requireStr(body, 'lane'), body.from, body.to);
      return { ok: true };
    }
    case 'edit-step': {
      const { step } = await editStep(repo, requireStr(body, 'lane'), body.index, body.patch || {});
      return { ok: true, step };
    }
    case 'pause':
      await writeFile(pausedFile(repo), `${new Date().toISOString()}\n`);
      return { ok: true, paused: true };
    case 'resume':
      await rm(pausedFile(repo), { force: true });
      return { ok: true, paused: false };
    case 'signal': {
      const signal = body.signal || 'SIGINT';
      if (!CONTROL_SIGNALS.has(signal)) throw new LaneValidationError(`unsupported signal '${signal}'`);
      await sendControl(repo, requireStr(body, 'lane'), { type: 'signal', signal });
      return { ok: true, signal };
    }
    case 'input':
      await sendControl(repo, requireStr(body, 'lane'), { type: 'input', data: String(body.data ?? '') });
      return { ok: true };
    default:
      throw new LaneValidationError(`unknown action '${action}'`);
  }
}

function requireStr(body, key) {
  const v = body?.[key];
  if (typeof v !== 'string' || !v) throw new LaneValidationError(`missing '${key}'`);
  return v;
}

// Tails a project's .tasks/ for a WS client: new events.jsonl lines stream as
// they land (from EOF at connect — the SPA fetches current state over the
// API), and any lane/config/PAUSED change pushes a debounced {event:"changed"}
// so the SPA refetches. fs.watch on the dir is non-recursive on purpose:
// logs/ churn stays out.
function watchProject(repo, send) {
  const tasksDir = repoTasksDir(repo);
  const evFile = eventsFile(repo);
  let offset = 0;
  try {
    offset = fs.statSync(evFile).size;
  } catch {
    offset = 0;
  }
  let draining = false;
  const drainEvents = async () => {
    if (draining) return;
    draining = true;
    try {
      const st = await stat(evFile).catch(() => null);
      if (!st) return;
      if (st.size < offset) offset = 0; // rotated/truncated — start over
      if (st.size === offset) return;
      const fh = await fs.promises.open(evFile, 'r');
      try {
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(st.size - offset), 0, st.size - offset, offset);
        offset += bytesRead;
        for (const line of buffer.toString('utf8').split('\n')) {
          if (line.trim()) send(line);
        }
      } finally {
        await fh.close();
      }
    } finally {
      draining = false;
    }
  };

  let changedTimer = null;
  const watcher = fs.watch(tasksDir, (kind, filename) => {
    if (filename === 'events.jsonl') {
      drainEvents().catch(() => {});
      return;
    }
    // Lane files, PAUSED, NEEDS-ATTENTION, state.json — coalesce into one poke.
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      send(JSON.stringify({ event: 'changed' }));
    }, 150);
  });
  // The WS handshake completes before this watcher exists (the upgrade handler
  // resolves the project async first) — an event appended in that window would
  // otherwise be swallowed by the initial offset. Drain once now, and tell the
  // client the tail is live so it can trust "from here on".
  drainEvents().catch(() => {});
  send(JSON.stringify({ event: 'hello' }));
  return () => {
    watcher.close();
    if (changedTimer) clearTimeout(changedTimer);
  };
}

// WS <-> control-socket bridge (§13 remotely): output events flow to the WS
// client line-by-line (the executor replays its ring buffer on connect, so a
// late viewer gets backlog); input/resize/signal/detach flow back. Only those
// four verbs cross — the WS side never gets to invent new control messages.
const BRIDGE_TYPES = new Set(['input', 'resize', 'signal', 'detach']);

function bridgePty(ws, repo, lane) {
  const sock = connect(runSocketPath(repo, lane));
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    // eslint-disable-next-line no-cond-assign
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() && ws.readyState === ws.OPEN) ws.send(line);
    }
  });
  sock.on('error', () => ws.close(4404, 'not running'));
  sock.on('close', () => ws.close(1000, 'step ended'));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString('utf8'));
      if (!BRIDGE_TYPES.has(msg.type)) return;
      if (msg.type === 'signal' && !CONTROL_SIGNALS.has(msg.signal || 'SIGINT')) return;
      sock.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // malformed client frame — drop it, never crash the bridge
    }
  });
  ws.on('close', () => sock.destroy());
}

// ── web-SSH: a serve-OWNED interactive pty into a runner (DESIGN §15 Layer 2) ──
// This is a strict escalation over bridgePty (which only relays a step the user
// already scheduled): here the serve process spawns a brand-new shell with no
// lane behind it — an interactive RCE surface running as the serve user. So it
// is default-OFF (§12 safety-first: the dangerous capability opts in), gated by
// `--allow-shell`, and every session is: token-gated (like all WS), capacity-
// capped, loudly audit-logged (open/exit/kill to stderr), and KILLED when the
// client disconnects so no orphan shell lingers.
const MAX_SHELL_SESSIONS = 8;

// Hang up the shell's whole process group like a real terminal (node-pty children
// are session leaders, pgid == pid, so -pid reaches jobs the shell spawned), then
// hard-kill the group if it ignores the hangup — no lingering interactive process.
function hangupTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

// Opens one shell session on `ws`. `sessions` is the server-wide live set (for
// the capacity cap + teardown on server close). The frame protocol is identical
// to the pty bridge — `{event:'output', data:base64}` out; `{type:'input'|
// 'resize'|'signal'}` in — so the SPA's xterm panel drives it unchanged.
async function shellSession(ws, repo, runnerValue, sessions, max) {
  if (sessions.size >= max) {
    ws.close(4429, 'too many shell sessions');
    return;
  }
  let runner;
  let inv;
  try {
    runner = await resolveRunner(runnerValue);
    inv = shellInvocation(runner, { cwd: repo });
  } catch (err) {
    ws.close(4400, (err.message || 'bad runner').slice(0, 100));
    return;
  }
  for (const w of inv.warnings || []) console.error(w);

  ensureSpawnHelperExecutable(); // self-heal a bad node-pty prebuild (see executor.mjs)
  let child;
  try {
    child = pty.spawn(inv.file, inv.args, {
      name: 'xterm-color', cols: 80, rows: 30, cwd: inv.cwd, env: inv.env,
    });
  } catch (err) {
    console.error(`taskherd: serve web-shell spawn failed (${inv.label}): ${err.message}`);
    ws.close(4500, 'shell spawn failed');
    return;
  }

  const session = { child, ws };
  sessions.add(session);
  console.error(`taskherd: serve web-shell OPEN runner=${inv.label} argv=[${[inv.file, ...inv.args].join(' ')}] pid=${child.pid} (${sessions.size} live)`);

  let killTimer = null;
  const end = (reason) => {
    if (!sessions.has(session)) return;
    sessions.delete(session);
    // Client gone → hang up, then hard-kill the group if it lingers.
    hangupTree(child, 'SIGHUP');
    killTimer = setTimeout(() => hangupTree(child, 'SIGKILL'), 3000);
    console.error(`taskherd: serve web-shell CLOSE runner=${inv.label} pid=${child.pid} (${reason}; ${sessions.size} live)`);
  };

  child.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: 'output', data: Buffer.from(data, 'utf8').toString('base64') }));
    }
  });
  child.onExit(({ exitCode, signal }) => {
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    const wasLive = sessions.delete(session);
    if (wasLive) {
      console.error(`taskherd: serve web-shell EXIT runner=${inv.label} pid=${child.pid} code=${exitCode}${signal ? ` signal=${signal}` : ''} (${sessions.size} live)`);
    }
    if (ws.readyState === ws.OPEN) ws.close(1000, 'shell exited');
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'input') child.write(String(msg.data ?? ''));
      else if (msg.type === 'resize' && msg.cols && msg.rows) child.resize(msg.cols, msg.rows);
      else if (msg.type === 'signal' && CONTROL_SIGNALS.has(msg.signal || 'SIGINT')) child.kill(msg.signal || 'SIGINT');
      // 'detach'/anything else → let the client just close the socket
    } catch {
      // malformed client frame — drop it, never crash the session
    }
  });
  ws.on('close', () => end('client disconnected'));
}

export async function createConsoleServer({ token, allowShell = false, maxShellSessions = MAX_SHELL_SESSIONS } = {}) {
  const authToken = token || await ensureServeToken();
  const shellSessions = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const staticEntry = req.method === 'GET' && STATIC_FILES[url.pathname];
      if (staticEntry) {
        const [file, type] = staticEntry;
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(data);
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (!tokenMatches(authToken, presentedToken(req, url))) {
        sendJson(res, 401, { error: 'unauthorized — open the URL printed by `taskherd serve`' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(res, 200, { projects: await projectSummaries(), allowShell });
        return;
      }

      // Read-only: the lane's branch diff for review before landing (§15 L2).
      const diffMatch = /^\/api\/projects\/([^/]+)\/diff$/.exec(url.pathname);
      if (diffMatch && req.method === 'GET') {
        const repo = await resolveProject(diffMatch[1]);
        const lane = url.searchParams.get('lane');
        if (!lane) throw new LaneValidationError("missing 'lane'");
        sendJson(res, 200, await laneDiff(repo, lane, { base: url.searchParams.get('base') || null }));
        return;
      }

      const m = /^\/api\/projects\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        const repo = await resolveProject(m[1]);
        const body = await readBody(req);
        sendJson(res, 200, await handleAction(repo, m[2], body));
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof LaneValidationError) {
        sendJson(res, 400, { error: err.message });
      } else if (/no running step/.test(err.message || '')) {
        sendJson(res, 409, { error: err.message });
      } else {
        console.error(`taskherd: serve error on ${req.method} ${url.pathname}: ${err.stack || err.message}`);
        sendJson(res, 500, { error: err.message });
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!tokenMatches(authToken, presentedToken(req, url))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        const repo = await resolveProject(url.searchParams.get('project') || '');
        if (url.pathname === '/ws/events') {
          const stopWatch = watchProject(repo, (line) => {
            if (ws.readyState === ws.OPEN) ws.send(line);
          });
          ws.on('close', stopWatch);
        } else if (url.pathname === '/ws/pty') {
          const lane = url.searchParams.get('lane');
          if (!lane) { ws.close(4400, 'missing lane'); return; }
          bridgePty(ws, repo, lane);
        } else if (url.pathname === '/ws/shell') {
          // Web-SSH (§15 L2) — off unless the operator opted in with --allow-shell.
          if (!allowShell) { ws.close(4403, 'web-SSH disabled — start `taskherd serve --allow-shell`'); return; }
          shellSession(ws, repo, url.searchParams.get('runner') || 'local', shellSessions, maxShellSessions);
        } else {
          ws.close(4404, 'unknown endpoint');
        }
      } catch (err) {
        ws.close(4404, err.message.slice(0, 100));
      }
    });
  });

  return {
    server,
    token: authToken,
    allowShell,
    shellSessionCount: () => shellSessions.size,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    async close() {
      // Reap every serve-owned shell (a disconnecting client kills its own, but
      // a shutdown must leave no orphan interactive process behind).
      for (const s of shellSessions) hangupTree(s.child, 'SIGKILL');
      shellSessions.clear();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
