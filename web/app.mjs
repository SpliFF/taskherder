// taskherd console SPA — a thin view over the serve API (DESIGN §15). No
// framework, no build step: state comes from GET /api/projects, live pokes
// from the per-project events WS, and the terminal is xterm.js bridged onto
// the running step's control socket.
import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

const app = document.getElementById('app');
const conn = document.getElementById('conn');

// ── auth token ──────────────────────────────────────────────────────────
// `taskherd serve` prints a ?token= URL; keep it in localStorage so the
// phone bookmark works without the query string, and strip it from the URL.
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  localStorage.setItem('taskherd-token', urlToken);
  history.replaceState(null, '', location.pathname);
}
const token = () => localStorage.getItem('taskherd-token') || '';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(kind, text, ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { renderAuthHelp(); throw new Error('unauthorized'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderAuthHelp() {
  app.innerHTML = `<div class="auth-help">
    <p>UNAUTHORIZED</p>
    <p>Open the console through the URL printed by <code>taskherd serve</code> —
    it carries the access token (<code>?token=…</code>, stored locally after the
    first visit). The token lives in <code>~/.taskherd/serve-token</code>.</p>
  </div>`;
}

// ── state + rendering ───────────────────────────────────────────────────
let projects = [];

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      ({ projects } = await api('/api/projects'));
      render();
      syncEventSockets();
    } catch (err) {
      if (err.message !== 'unauthorized') toast('error', err.message);
    }
  }, 120);
}

const GLYPH = { done: '✓', failed: '✗', blocked: '◆', pending: '·', running: '▸' };

function laneHtml(p, lane) {
  const running = lane.running;
  const editableFrom = lane.cursor + (running ? 1 : 0);
  const steps = lane.steps.map((s, i) => {
    const active = i === lane.cursor && running;
    const cls = active ? 'running' : s.status;
    const tools = (i >= editableFrom && s.status === 'pending') ? `
      <span class="step-tools">
        <button class="btn ghost" data-action="step-up" data-lane="${esc(lane.name)}" data-idx="${i}" ${i <= editableFrom ? 'disabled' : ''}>↑</button>
        <button class="btn ghost" data-action="step-down" data-lane="${esc(lane.name)}" data-idx="${i}" ${i >= lane.steps.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn ghost" data-action="step-edit" data-lane="${esc(lane.name)}" data-idx="${i}" data-type="${esc(s.type)}">✎</button>
        <button class="btn ghost" data-action="step-del" data-lane="${esc(lane.name)}" data-idx="${i}">✕</button>
      </span>` : '';
    return `<li class="step ${esc(s.status)}">
      <span class="step-idx">${i}</span>
      <span class="step-glyph">${active ? GLYPH.running : (GLYPH[s.status] || '·')}</span>
      <span class="step-text">${esc(s.summary)}</span>
      <span class="step-type">${esc(s.type)}</span>${tools}
    </li>`;
  }).join('');

  return `<article class="lane ${running ? 'is-running' : ''} ${lane.gate ? 'is-blocked' : ''}">
    <div class="lane-head">
      <span class="dot ${running ? 'running' : (lane.gate ? 'blocked' : 'idle')}">●</span>
      <span class="lane-name">${esc(lane.name)}</span>
      ${lane.parent ? `<span class="lane-parent">⑂ ${esc(lane.parent)}</span>` : ''}
      <span class="lane-meta">[${lane.cursor}/${lane.steps.length}] ${esc(lane.status)}${lane.spent ? ` · $${lane.spent.toFixed(2)}` : ''}</span>
    </div>
    ${lane.gate ? `<div class="gate-banner">
      <span class="gate-reason">◆ ${esc(lane.gate)}</span>
      <button class="btn primary" data-action="ack" data-lane="${esc(lane.name)}">ACK</button>
    </div>` : ''}
    ${steps ? `<ul class="steps">${steps}</ul>` : ''}
    ${lane.onEmpty === 'default' && lane.default ? `<div class="lane-default">${esc(lane.default.task || lane.default.run || 'default')} <span class="step-type">(${esc(lane.default.type || 'ai')} · recurring)</span></div>` : ''}
    <div class="lane-actions">
      ${running ? `
        <button class="btn" data-action="attach" data-project="${esc(p.id)}" data-lane="${esc(lane.name)}">ATTACH</button>
        <button class="btn warn" data-action="interrupt" data-lane="${esc(lane.name)}">INTERRUPT</button>` : ''}
      <button class="btn ghost" data-action="diff" data-lane="${esc(lane.name)}">DIFF</button>
      <button class="btn ghost" data-action="fork" data-lane="${esc(lane.name)}">FORK</button>
    </div>
    <form class="add-row" data-action="add-step" data-lane="${esc(lane.name)}">
      <select name="type"><option>command</option><option>ai</option><option>manual</option></select>
      <input name="task" placeholder="queue a step…" autocomplete="off">
      <button class="btn" type="submit">ADD</button>
    </form>
  </article>`;
}

function render() {
  if (projects.length === 0) {
    app.innerHTML = '<p class="boot">no projects registered — run <code>taskherd init</code> (or <code>taskherd serve</code> inside a repo) to register one</p>';
    return;
  }
  app.innerHTML = projects.map((p) => {
    if (p.missing) {
      return `<section class="project" data-project="${esc(p.id)}">
        <div class="project-head"><h2>${esc(p.name)}</h2><span class="project-path">${esc(p.path)}</span></div>
        <p class="missing">✗ .tasks/ missing at this path (project moved or deleted)</p>
      </section>`;
    }
    const lanes = (p.lanes || []).map((l) => laneHtml(p, l)).join('')
      || '<p class="boot">no lanes yet</p>';
    const unloadable = (p.unloadable || []).map((u) => `<p class="missing">✗ ${esc(u.name)}: ${esc(u.error)}</p>`).join('');
    return `<section class="project" data-project="${esc(p.id)}">
      <div class="project-head">
        <h2>${esc(p.name)}</h2>
        <span class="project-path">${esc(p.path)}</span>
        <span class="project-spend">${p.totalSpent ? `Σ $${p.totalSpent.toFixed(2)}` : ''}</span>
        <button class="btn ${p.paused ? 'primary' : 'warn'}" data-action="${p.paused ? 'resume' : 'pause'}">${p.paused ? 'RESUME' : 'PAUSE'}</button>
      </div>
      ${p.paused ? '<div class="paused-banner">⏸ PAUSED — no lanes will run until resumed</div>' : ''}
      ${p.error ? `<p class="missing">✗ ${esc(p.error)}</p>` : ''}
      <div class="lanes">${lanes}${unloadable}</div>
    </section>`;
  }).join('');
}

// ── actions ─────────────────────────────────────────────────────────────
function projectIdFor(el) {
  return el.closest('.project')?.dataset.project;
}

async function act(id, action, body, okMsg) {
  try {
    await api(`/api/projects/${encodeURIComponent(id)}/${action}`, body);
    if (okMsg) toast('ok', okMsg);
    scheduleRefresh();
  } catch (err) {
    if (err.message !== 'unauthorized') toast('error', err.message);
  }
}

app.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  const id = projectIdFor(btn);
  const { action, lane } = btn.dataset;
  const idx = btn.dataset.idx != null ? Number(btn.dataset.idx) : null;
  if (action === 'ack') act(id, 'ack', { lane }, `acked ${lane}`);
  else if (action === 'pause') act(id, 'pause', {}, 'paused');
  else if (action === 'resume') act(id, 'resume', {}, 'resumed');
  else if (action === 'interrupt') act(id, 'signal', { lane, signal: 'SIGINT' }, `SIGINT → ${lane}`);
  else if (action === 'step-del') act(id, 'remove-step', { lane, index: idx });
  else if (action === 'step-up') act(id, 'move-step', { lane, from: idx, to: idx - 1 });
  else if (action === 'step-down') act(id, 'move-step', { lane, from: idx, to: idx + 1 });
  else if (action === 'step-edit') {
    const current = btn.closest('.step')?.querySelector('.step-text')?.textContent || '';
    const v = prompt(`edit ${btn.dataset.type} step ${idx}`, current);
    if (v == null || v === current) return;
    const patch = btn.dataset.type === 'manual' ? { message: v }
      : btn.dataset.type === 'ai' ? { task: v, file: null } : { run: v };
    act(id, 'edit-step', { lane, index: idx, patch });
  } else if (action === 'fork') {
    const name = prompt(`fork a new lane off '${lane}' — name:`);
    if (name) act(id, 'fork', { name: name.trim(), from: lane }, `forked ${name.trim()}`);
  } else if (action === 'attach') {
    openTerminal(id, lane);
  } else if (action === 'diff') {
    openDiff(id, lane);
  }
});

app.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-action="add-step"]');
  if (!form) return;
  e.preventDefault();
  const id = projectIdFor(form);
  const type = form.elements.type.value;
  const text = form.elements.task.value.trim();
  if (!text) return;
  const step = type === 'manual' ? { type, message: text } : { type, task: text };
  act(id, 'add', { lane: form.dataset.lane, step }, 'step queued');
  form.reset();
});

// ── live events ─────────────────────────────────────────────────────────
const eventSockets = new Map(); // project id -> WebSocket

function syncEventSockets() {
  const want = new Set(projects.filter((p) => !p.missing).map((p) => p.id));
  for (const [id, ws] of eventSockets) {
    if (!want.has(id)) { ws.close(); eventSockets.delete(id); }
  }
  for (const id of want) {
    if (!eventSockets.has(id)) openEventSocket(id);
  }
}

function updateConn() {
  const live = [...eventSockets.values()].some((ws) => ws.readyState === WebSocket.OPEN);
  conn.classList.toggle('live', live);
  conn.textContent = live ? '● live' : '● offline';
}

function openEventSocket(id) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/events?project=${encodeURIComponent(id)}&token=${encodeURIComponent(token())}`);
  eventSockets.set(id, ws);
  ws.onopen = updateConn;
  ws.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.event === 'gate.blocked') toast('gate', `◆ ${ev.lane}: ${ev.reason || 'blocked'}`, 8000);
      if (ev.event === 'run.exit') toast('ok', `${ev.lane} exited (${ev.code === 0 ? 'ok' : `code ${ev.code}`})`);
    } catch { /* poke only */ }
    scheduleRefresh();
  };
  ws.onclose = () => {
    eventSockets.delete(id);
    updateConn();
    setTimeout(() => { if (!eventSockets.has(id)) scheduleRefresh(); }, 3000);
  };
  ws.onerror = () => ws.close();
}

// ── terminal (xterm.js over the WS pty bridge) ──────────────────────────
const panel = document.getElementById('term-panel');
const termHost = document.getElementById('term-host');
const termTitle = document.getElementById('term-title');
let term = null;
let termWs = null;
let fit = null;

function closeTerminal() {
  if (termWs) { termWs.onclose = null; termWs.close(); termWs = null; }
  if (term) { term.dispose(); term = null; fit = null; }
  panel.hidden = true;
}

function openTerminal(id, lane) {
  closeTerminal();
  closeDiff();
  panel.hidden = false;
  termTitle.textContent = `${lane} — live`;
  term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, SF Mono, Menlo, monospace', theme: { background: '#0a0c0a' }, convertEol: false });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termHost);
  fit.fit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  termWs = new WebSocket(`${proto}://${location.host}/ws/pty?project=${encodeURIComponent(id)}&lane=${encodeURIComponent(lane)}&token=${encodeURIComponent(token())}`);
  const sendResize = () => {
    if (termWs?.readyState === WebSocket.OPEN && term) {
      termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };
  termWs.onopen = () => { fit.fit(); sendResize(); };
  termWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.event === 'output' && term) {
        term.write(Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0)));
      }
    } catch { /* ignore malformed lines */ }
  };
  termWs.onclose = (e) => {
    termTitle.textContent = `${lane} — ${e.code === 4404 ? 'not running' : 'ended'}`;
    if (term) term.write('\r\n\x1b[33m[taskherd: stream closed]\x1b[0m\r\n');
    termWs = null;
  };
  term.onData((d) => {
    if (termWs?.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ type: 'input', data: d }));
  });
  term.onResize(sendResize);
  window.addEventListener('resize', () => { if (fit) fit.fit(); });
}

document.getElementById('term-close').onclick = closeTerminal;
document.getElementById('term-int').onclick = () => termWs?.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));
document.getElementById('term-term').onclick = () => termWs?.send(JSON.stringify({ type: 'signal', signal: 'SIGTERM' }));

// ── worktree diff viewer (§15 Layer 2) ──────────────────────────────────
// Review what an autonomous agent committed to taskherd/<lane> before acking
// its land gate — the same laneDiff the CLI prints, over the read-only diff API.
const diffPanel = document.getElementById('diff-panel');
const diffBody = document.getElementById('diff-body');
const diffTitle = document.getElementById('diff-title');

function closeDiff() {
  diffPanel.hidden = true;
  diffBody.innerHTML = '';
}

// Colour a unified-diff line by its lead character (adds/dels/hunks/meta), the
// full text HTML-escaped — the patch is untrusted agent output.
function diffLineHtml(line) {
  const c = line[0];
  let cls = 'ctx';
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) cls = 'meta';
  else if (c === '@') cls = 'hunk';
  else if (c === '+') cls = 'add';
  else if (c === '-') cls = 'del';
  return `<span class="dl ${cls}">${esc(line) || ' '}</span>`;
}

async function openDiff(id, lane) {
  closeTerminal();
  diffPanel.hidden = false;
  diffTitle.textContent = `${lane} — diff`;
  diffBody.innerHTML = '<p class="boot">loading diff…</p>';
  let d;
  try {
    d = await api(`/api/projects/${encodeURIComponent(id)}/diff?lane=${encodeURIComponent(lane)}`);
  } catch (err) {
    if (err.message !== 'unauthorized') diffBody.innerHTML = `<p class="missing">✗ ${esc(err.message)}</p>`;
    return;
  }
  if (!d.exists) {
    diffBody.innerHTML = `<p class="boot">lane <code>${esc(lane)}</code> has no branch <code>${esc(d.branch)}</code> yet — it hasn't run under git isolation.</p>`;
    return;
  }
  diffTitle.textContent = `${lane} — ${d.branch} vs ${d.base}`;
  const files = d.files.map((f) => `<li class="difffile">
      <span class="difffile-stat">${f.binary ? 'bin' : `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>`}</span>
      <span class="difffile-path">${esc(f.path)}</span>
    </li>`).join('');
  // Each .dl is display:block (its own line); join with '' so the pre's
  // white-space:pre doesn't inject a blank line between every diff row.
  const body = d.patch
    ? `<pre class="diff">${d.patch.split('\n').map(diffLineHtml).join('')}</pre>`
    : '<p class="boot">no textual changes</p>';
  diffBody.innerHTML = `
    <div class="diff-summary">
      <span>${d.ahead} commit(s) ahead · ${d.files.length} file(s)</span>
      ${d.dirty ? '<span class="diff-dirty">⚠ worktree has uncommitted changes</span>' : ''}
    </div>
    ${files ? `<ul class="difffiles">${files}</ul>` : ''}
    ${body}
    ${d.truncated ? `<p class="diff-trunc">diff truncated at ${d.bytes} bytes — use <code>taskherd diff ${esc(lane)}</code> for the full patch</p>` : ''}`;
  diffBody.scrollTop = 0;
}

document.getElementById('diff-close').onclick = closeDiff;

// ── boot ────────────────────────────────────────────────────────────────
scheduleRefresh();
setInterval(scheduleRefresh, 20000); // safety net if a watcher/WS misses a change
