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
import { Readable } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import pty from 'node-pty';

import {
  taskherdHome, repoTasksDir, pausedFile, eventsFile, runSocketPath, runSocketLink,
} from './paths.mjs';
import { loadProjects } from './registry.mjs';
import { statusData } from './history.mjs';
import { laneDiff, syncCloneBranch } from './git.mjs';
import { listLaneLogs, readLaneLog, readLatestLaneLog } from './logs.mjs';
import {
  resolveRunner, shellInvocation, graphicalEndpoint, loadRunners,
} from './runners.mjs';
import { ensureSpawnHelperExecutable } from './executor.mjs';
import { tick } from './scheduler.mjs';
import {
  ackLane, addStep, forkLane, removeStep, moveStep, editStep, validateLaneName, LaneValidationError,
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
  // Shared with the CLI (bin/cli.mjs imports it from disk) — the stream-json
  // transcript renderer, served so the SPA `import`s the same one (no drift).
  '/render.mjs': [fileURLToPath(new URL('./render.mjs', import.meta.url)), 'text/javascript; charset=utf-8'],
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

// Baseline hardening on the console's own (main-origin) responses: refuse
// framing (clickjacking an authed operator into ACK/pause/interrupt clicks),
// stop MIME-sniffing, and leak no referrer (the token can ride a URL). These are
// NOT applied to the /gfx reverse-proxy responses — that content is deliberately
// framed by the console and served from a separate origin (see the gfx server).
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};

function sendJson(res, status, body) {
  const data = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
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

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Fire the scheduler for ONE lane from the console (the RUN button). DESIGN §3
// sanctions the executor running "in the serve process", but a step can take
// many minutes, so we must NOT hold the HTTP response open for it. Kick off the
// tick and race it against the lane's control socket appearing: once the step
// spawns we answer "running" and let it finish in the background (surfaced live
// through events + attach, exactly like a cron fire); if the tick settles first
// — not-runnable / paused / locked / an instant command — we return that
// outcome so the operator gets the real reason. The lane mutex still prevents a
// double-run, so a RUN on an already-running lane just returns 'locked'.
async function startLaneRun(repo, lane, force) {
  validateLaneName(lane);
  let settled = false;
  const runPromise = tick(repo, { lane, force });
  // Detach it so an unexpected throw can't crash serve; tick already parks
  // setup errors, so this only catches the truly unforeseen (DESIGN §1).
  runPromise.catch((err) => console.error(`taskherd: serve run of lane '${lane}' failed: ${err.message}`));

  const outcome = await Promise.race([
    runPromise.then((result) => { settled = true; return { result }; }),
    (async () => {
      const start = Date.now();
      while (!settled) {
        if (existsSync(runSocketLink(repo, lane))) return { started: true };
        if (Date.now() - start > 15_000) return { started: false };
        await delay(25);
      }
      return null; // the tick settled first; its branch wins the race
    })(),
  ]);
  return outcome?.result ? { ok: true, ...outcome.result } : { ok: true, outcome: 'running' };
}

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
    case 'run':
      // Manual one-lane fire (§18 run, from the console). `force` overrides a
      // PAUSE for this run only — the caller opted in (a confirm in the SPA).
      return startLaneRun(repo, requireStr(body, 'lane'), Boolean(body.force));
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

// ── graphical streaming: a reverse proxy to a runner's in-runner GUI server ──
// (DESIGN §15 Layer 2 — Xpra per-app HTML5 / noVNC·KasmVNC desktop). Unlike the
// pty bridge and web-shell (which own a pty), this proxies an HTTP+WS endpoint
// the OPERATOR declared inside a runner (runners.json `graphical`, resolved by
// runners.mjs). Two independent gates keep it safe (§12): it only reaches URLs
// the operator explicitly configured (never an arbitrary target), and the whole
// capability is default-OFF behind `serve --allow-gfx`. A browser reaches it via
// an unguessable capability path minted by an authed gfx-open — the session id in
// the path IS the auth (same posture as the WS `?token=`), so the embedding
// iframe's sub-resources + protocol WS need no bearer header.
const MAX_GFX_SESSIONS = 8;
const GFX_SESSION_TTL_MS = 30 * 60 * 1000; // a capability path lives 30 min

// --allow-gfx off, or a runner with no `graphical` block → these mark the two
// distinct non-200s the request handler maps to 403 / 400+standin.
class GfxDisabled extends Error {}
class GfxStandin extends Error {}

// A ws close code is only re-sendable if it is a valid application code; 1005/1006
// (and out-of-range values) would throw on close(), so collapse them to 1000.
function normalizeGfxCloseCode(code) {
  return (code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006) ? code : 1000;
}

// Byte-transparent bidirectional WS proxy: the browser's graphical-protocol
// WebSocket (Xpra/noVNC binary framing) piped to the in-runner server and back,
// binary-ness preserved. The subprotocol the client offered is forwarded upstream
// (both Xpra and noVNC negotiate 'binary'). Either side closing tears down the
// other, so a dropped viewer never leaks an upstream socket.
function bridgeGfxWs(clientWs, upstreamUrl, subprotoHeader) {
  const protocols = subprotoHeader
    ? subprotoHeader.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  let upstream;
  try {
    upstream = new WebSocket(upstreamUrl, protocols);
  } catch {
    if (clientWs.readyState === clientWs.OPEN) clientWs.close(1011, 'gfx upstream error');
    return;
  }
  const pending = [];
  upstream.on('open', () => {
    for (const [data, binary] of pending) upstream.send(data, { binary });
    pending.length = 0;
  });
  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === clientWs.OPEN) clientWs.send(data, { binary: isBinary });
  });
  upstream.on('close', (code, reason) => {
    if (clientWs.readyState === clientWs.OPEN) clientWs.close(normalizeGfxCloseCode(code), reason);
  });
  upstream.on('error', () => {
    if (clientWs.readyState === clientWs.OPEN) clientWs.close(1011, 'gfx upstream error');
  });
  clientWs.on('message', (data, isBinary) => {
    if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === upstream.CONNECTING) pending.push([data, isBinary]);
  });
  const closeUpstream = () => { try { upstream.close(); } catch { /* already gone */ } };
  clientWs.on('close', closeUpstream);
  clientWs.on('error', closeUpstream);
}

// Listen once, resolving to the bound address or rejecting on error (e.g.
// EADDRINUSE), with listeners cleaned up so the server can be re-listened on a
// fallback port.
function bindOnce(srv, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { srv.removeListener('listening', onListening); reject(err); };
    const onListening = () => { srv.removeListener('error', onError); resolve(srv.address()); };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, host);
  });
}

export async function createConsoleServer({
  token, allowShell = false, maxShellSessions = MAX_SHELL_SESSIONS,
  allowGfx = false, maxGfxSessions = MAX_GFX_SESSIONS,
} = {}) {
  const authToken = token || await ensureServeToken();
  const shellSessions = new Set();
  // Live graphical capabilities: session id → { endpoint, expires }. The id is an
  // unguessable path capability minted by gfx-open; it expires (lazy sweep on use)
  // and the set is capacity-capped, so a leaked/forgotten iframe can't stream forever.
  const gfxSessions = new Map();
  // The graphical proxy binds a SEPARATE origin (a distinct port on the same
  // host) from the console. Origin = scheme+host+port, so a proxied in-runner GUI
  // (which could serve hostile JS — noVNC/Xpra have a CVE history) runs on an
  // origin that has NO access to the console origin's localStorage, where the
  // bearer token lives — closing the runner→host token-theft path. Set when
  // listen() binds the gfx server below.
  let gfxBoundPort = null;

  function getGfxSession(id) {
    const s = gfxSessions.get(id);
    if (!s) return null;
    if (Date.now() > s.expires) { gfxSessions.delete(id); return null; }
    return s;
  }

  // Build the absolute iframe URL for a minted capability, on the gfx origin:
  // same hostname the browser used to reach the console (from the Host header),
  // but the gfx port. Different port ⇒ different origin ⇒ token isolation.
  function gfxUrlFor(hostHeader, id, clientPath) {
    let origin;
    try {
      origin = new URL(`http://${hostHeader || '127.0.0.1'}`);
    } catch {
      origin = new URL('http://127.0.0.1');
    }
    origin.port = String(gfxBoundPort);
    return `${origin.origin}/gfx/${id}/${clientPath}`;
  }

  // Names of runners that declare a graphical endpoint — drives the console's GUI
  // button (which runners can be streamed). Empty when --allow-gfx is off.
  async function gfxRunnerNames() {
    if (!allowGfx) return [];
    try {
      const runners = await loadRunners();
      return Object.entries(runners).filter(([, def]) => def && def.graphical).map(([name]) => name);
    } catch {
      return []; // a malformed runners.json is surfaced by `doctor`, not here
    }
  }

  // POST /api/projects/:id/gfx-open {runner} — mint a capability path for a
  // runner's declared graphical endpoint. --allow-gfx off → 403; a runner with no
  // graphical block → a loud FIDELITY-STANDIN + 400 (never a silent blank frame).
  async function openGfxSession(body, hostHeader) {
    if (!allowGfx) throw new GfxDisabled('graphical streaming disabled — start `taskherd serve --allow-gfx`');
    const runnerValue = requireStr(body, 'runner');
    let endpoint;
    try {
      endpoint = graphicalEndpoint(await resolveRunner(runnerValue));
    } catch (err) {
      throw new LaneValidationError(err.message); // unknown runner / malformed graphical → 400
    }
    if (!endpoint) {
      console.error(
        `FIDELITY-STANDIN: runner '${runnerValue}' declares no graphical endpoint — add a `
        + '"graphical": { "kind": "xpra"|"novnc"|"kasmvnc", "url": "http://…" } block to '
        + '~/.taskherd/runners.json (the GUI server runs INSIDE the runner, DESIGN §11/§15). '
        + 'No graphical stream available.',
      );
      throw new GfxStandin(`runner '${runnerValue}' has no graphical endpoint configured — see runners.json "graphical" (DESIGN §15); no GUI stream (a FIDELITY-STANDIN was logged).`);
    }
    if (gfxSessions.size >= maxGfxSessions) throw new LaneValidationError(`too many graphical sessions (max ${maxGfxSessions})`);
    const id = randomBytes(18).toString('base64url');
    gfxSessions.set(id, { endpoint, expires: Date.now() + GFX_SESSION_TTL_MS });
    console.error(`taskherd: serve gfx OPEN runner=${endpoint.name} kind=${endpoint.kind} target=${endpoint.httpBase} session=${id.slice(0, 8)}… (${gfxSessions.size} live)`);
    return {
      ok: true,
      session: id,
      kind: endpoint.kind,
      name: endpoint.name,
      url: gfxUrlFor(hostHeader, id, endpoint.clientPath), // absolute, on the separate gfx origin
    };
  }

  // Resolve /gfx/<id>/<remainder> to the upstream URL, origin-checked so the
  // capability can never be aimed at another host. Returns null on a bad/expired
  // session, throws LaneValidationError on a path that escapes the graphical origin.
  function resolveGfxTarget(pathname, search) {
    const m = /^\/gfx\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if (!m) return null;
    const session = getGfxSession(m[1]);
    if (!session) return null;
    const target = new URL((m[2] || '') + (search || ''), session.endpoint.httpBase);
    if (target.origin !== session.endpoint.origin) {
      throw new LaneValidationError('graphical path escapes the configured origin');
    }
    return { session, target };
  }

  // GET/HEAD /gfx/<id>/... — reverse-proxy the HTML5 client's static assets. The
  // token gate does NOT apply (the iframe can't send a bearer header); the session
  // capability in the path is the auth.
  async function proxyGfxHttp(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method not allowed' }); return; }
    const resolved = resolveGfxTarget(url.pathname, url.search); // may throw LaneValidationError (→ 400)
    if (!resolved) { sendJson(res, 404, { error: 'graphical session expired or unknown' }); return; }
    const fwd = {};
    for (const h of ['range', 'accept', 'accept-language', 'if-none-match', 'if-modified-since']) {
      if (req.headers[h]) fwd[h] = req.headers[h];
    }
    let upstream;
    try {
      upstream = await fetch(resolved.target, { method: req.method, headers: fwd, redirect: 'manual' });
    } catch (err) {
      console.error(`taskherd: serve gfx proxy → ${resolved.target.href} failed: ${err.message}`);
      sendJson(res, 502, { error: `graphical server unreachable at ${resolved.session.endpoint.httpBase} — is the ${resolved.session.endpoint.kind} server running in the runner? (${err.message})` });
      return;
    }
    const headers = {};
    for (const [k, v] of upstream.headers) {
      // content-encoding/length are wrong post-decode; hop-by-hop headers don't cross a proxy.
      if (['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) { res.end(); return; }
    Readable.fromWeb(upstream.body).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const staticEntry = req.method === 'GET' && STATIC_FILES[url.pathname];
      if (staticEntry) {
        const [file, type] = staticEntry;
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...SECURITY_HEADERS });
        res.end(data);
        return;
      }

      // The graphical reverse proxy (§15 L2) is NOT served here — it lives on a
      // separate origin (the gfx server, a distinct port) so a proxied runner GUI
      // can't reach this origin's token. A stray /gfx request on the console
      // origin falls through to the 404 below.
      if (!url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (!tokenMatches(authToken, presentedToken(req, url))) {
        sendJson(res, 401, { error: 'unauthorized — open the URL printed by `taskherd serve`' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(res, 200, {
          projects: await projectSummaries(), allowShell, allowGfx, gfxRunners: await gfxRunnerNames(),
        });
        return;
      }

      // Mint a graphical capability path for a runner's declared GUI endpoint (§15 L2).
      const gfxMatch = /^\/api\/projects\/([^/]+)\/gfx-open$/.exec(url.pathname);
      if (gfxMatch && req.method === 'POST') {
        await resolveProject(gfxMatch[1]); // validate the project exists (404/400 path)
        sendJson(res, 200, await openGfxSession(await readBody(req), req.headers.host));
        return;
      }

      // Read-only: the lane's branch diff for review before landing (§15 L2).
      const diffMatch = /^\/api\/projects\/([^/]+)\/diff$/.exec(url.pathname);
      if (diffMatch && req.method === 'GET') {
        const repo = await resolveProject(diffMatch[1]);
        const lane = url.searchParams.get('lane');
        if (!lane) throw new LaneValidationError("missing 'lane'");
        validateLaneName(lane); // no traversal into arbitrary .json / worktree paths
        await syncCloneBranch(repo, lane); // §26: pull a clone lane's commits into main first (no-op otherwise)
        sendJson(res, 200, await laneDiff(repo, lane, { base: url.searchParams.get('base') || null }));
        return;
      }

      // Read-only: list a lane's persisted pty logs, newest first (monitor L2).
      const logsMatch = /^\/api\/projects\/([^/]+)\/logs$/.exec(url.pathname);
      if (logsMatch && req.method === 'GET') {
        const repo = await resolveProject(logsMatch[1]);
        const lane = url.searchParams.get('lane');
        if (!lane) throw new LaneValidationError("missing 'lane'");
        sendJson(res, 200, { logs: await listLaneLogs(repo, lane) });
        return;
      }

      // Read-only: one log file's raw text (path-validated, capped). No `file`
      // ⇒ the newest run's log ("just show me the last run").
      const logMatch = /^\/api\/projects\/([^/]+)\/log$/.exec(url.pathname);
      if (logMatch && req.method === 'GET') {
        const repo = await resolveProject(logMatch[1]);
        const lane = url.searchParams.get('lane');
        if (!lane) throw new LaneValidationError("missing 'lane'");
        const file = url.searchParams.get('file');
        sendJson(res, 200, file
          ? await readLaneLog(repo, lane, file)
          : await readLatestLaneLog(repo, lane));
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
      if (err instanceof GfxDisabled) {
        sendJson(res, 403, { error: err.message });
      } else if (err instanceof GfxStandin) {
        sendJson(res, 400, { error: err.message, standin: true });
      } else if (err instanceof LaneValidationError) {
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
  // Separate WS server for the graphical proxy: it echoes the client's first
  // offered subprotocol (Xpra/noVNC negotiate 'binary'), which the shared events/
  // pty server never does.
  const gfxWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => { for (const p of protocols) return p; return false; },
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // The graphical-protocol WS is served on the separate gfx origin (below), not
    // here — so this handler only ever sees token-authed console WS.
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

  // The graphical reverse proxy runs on its OWN http server / origin (a distinct
  // port), created only when --allow-gfx is on. It exposes NOTHING but the
  // capability-authed /gfx/<id>/* proxy — no SPA, no API, no token in storage —
  // so a proxied in-runner GUI's JS is same-origin with an empty page, never with
  // the console token. The capability (session id) in the path is the auth, so no
  // bearer token is required (the iframe can't send one anyway).
  let gfxServer = null;
  if (allowGfx) {
    gfxServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      try {
        if (url.pathname.startsWith('/gfx/')) { await proxyGfxHttp(req, res, url); return; }
        sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        if (err instanceof LaneValidationError) { sendJson(res, 400, { error: err.message }); return; }
        console.error(`taskherd: serve gfx error on ${req.method} ${url.pathname}: ${err.stack || err.message}`);
        sendJson(res, 500, { error: err.message });
      }
    });
    gfxServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/gfx/')) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      let resolved;
      try {
        resolved = resolveGfxTarget(url.pathname, url.search);
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
      }
      if (!resolved) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      const wsTarget = new URL(resolved.target.href);
      wsTarget.protocol = resolved.session.endpoint.wsScheme;
      gfxWss.handleUpgrade(req, socket, head, (clientWs) => {
        bridgeGfxWs(clientWs, wsTarget.href, req.headers['sec-websocket-protocol']);
      });
    });
  }

  return {
    server,
    gfxServer,
    token: authToken,
    allowShell,
    allowGfx,
    shellSessionCount: () => shellSessions.size,
    graphicalSessionCount: () => gfxSessions.size,
    gfxPort: () => gfxBoundPort,
    async listen(port, host) {
      const addr = await bindOnce(server, port, host);
      if (gfxServer) {
        // Prefer a deterministic gfx port (main + 1) for firewalling/tunnelling;
        // fall back to an ephemeral port if it is taken. The SPA learns the URL
        // from gfx-open at runtime, so the exact port need not be fixed.
        const desired = port === 0 ? 0 : addr.port + 1;
        try {
          gfxBoundPort = (await bindOnce(gfxServer, desired, host)).port;
        } catch {
          gfxBoundPort = (await bindOnce(gfxServer, 0, host)).port;
        }
      }
      return addr;
    },
    async close() {
      // Reap every serve-owned shell (a disconnecting client kills its own, but
      // a shutdown must leave no orphan interactive process behind).
      for (const s of shellSessions) hangupTree(s.child, 'SIGKILL');
      shellSessions.clear();
      // Drop graphical capabilities and tear down any live proxy sockets.
      gfxSessions.clear();
      for (const ws of gfxWss.clients) ws.terminate();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
      if (gfxServer) await new Promise((resolve) => gfxServer.close(resolve));
    },
  };
}
