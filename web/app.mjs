// taskherd console SPA — a thin view over the serve API (DESIGN §15). No
// framework, no build step: state comes from GET /api/projects, live pokes
// from the per-project events WS, and the terminal is xterm.js bridged onto
// the running step's control socket.
import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { createOutputRenderer } from '/render.mjs';

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

// ── follow runs ─────────────────────────────────────────────────────────
// Opt-in: when a run starts (a run.start event over the events WS), auto-open
// its live terminal so a passive watcher doesn't have to hunt for the ATTACH
// button — the #1 reason "I watched serve and saw nothing" (the 2026-07-08
// monitor investigation). Persisted so a phone bookmark keeps the preference.
// `autoFollowedTerm` marks a terminal THIS opened (vs a manual ATTACH/SHELL/LOG):
// follow may hop it to a newer run, but never steals focus from a panel you
// opened yourself.
let followRuns = localStorage.getItem('taskherd-follow') === '1';
let autoFollowedTerm = false;
const followToggle = document.getElementById('follow-toggle');
followToggle.checked = followRuns;
followToggle.onchange = () => {
  followRuns = followToggle.checked;
  localStorage.setItem('taskherd-follow', followRuns ? '1' : '0');
};

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
let allowShell = false; // whether serve was started with --allow-shell (web-SSH)
let allowGfx = false; // whether serve was started with --allow-gfx (graphical streaming)
let gfxRunners = []; // names of runners.json runners that declare a graphical endpoint

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      const data = await api('/api/projects');
      projects = data.projects;
      allowShell = !!data.allowShell;
      allowGfx = !!data.allowGfx;
      gfxRunners = data.gfxRunners || [];
      render();
      syncEventSockets();
    } catch (err) {
      if (err.message !== 'unauthorized') toast('error', err.message);
    }
  }, 120);
}

const GLYPH = {
  done: '✓', failed: '✗', blocked: '◆', pending: '·', running: '▸', waiting: '⧗',
};

// The block banner at the top of a lane. A `failure` (a step that crashed,
// timed out, or hit a provider limit) reads as a RED error carrying the actual
// message; an intentional gate (manual sign-off, land review, budget cap) stays
// amber. `gateDetail` is the distilled tail of the failed run's output.
function gateBannerHtml(lane) {
  if (!lane.gate) return '';
  const kind = lane.gateKind || 'manual';
  const failed = kind === 'failure';
  const label = { failure: '✗ FAILED', budget: '$ BUDGET', land: '◆ LAND', manual: '◆ GATE', blocked: '◆ BLOCKED' }[kind] || '◆ GATE';
  const detail = failed && lane.gateDetail
    ? `<pre class="gate-detail">${esc(lane.gateDetail)}</pre>` : '';
  const btn = failed
    ? `<button class="btn danger" title="Clear the failure and re-queue this step (it runs again on the next fire)" data-action="ack" data-lane="${esc(lane.name)}">RETRY</button>`
    : `<button class="btn primary" title="Approve this gate — the lane continues on the next run" data-action="ack" data-lane="${esc(lane.name)}">ACK</button>`;
  return `<div class="gate-banner ${failed ? 'error' : ''}">
    <div class="gate-text">
      <span class="gate-reason"><span class="gate-label">${label}</span> ${esc(lane.gate)}</span>
      ${detail}
    </div>
    ${btn}
  </div>`;
}

// A lane held by an unmet cross-lane dependency (DESIGN §22 waitsFor). Unlike a
// gate, this needs NO human action — it clears itself the instant the
// prerequisite lands — so it reads as calm cyan info, with the refs but no ACK.
function waitBannerHtml(lane) {
  if (!lane.waiting?.length) return '';
  const refs = lane.waiting.map((r) => `<code>${esc(r)}</code>`).join(', ');
  // A window wait (DESIGN §23) opens on a clock, a probe wait clears when its
  // command starts passing — say so instead of the dep-specific "lands".
  const isWindow = lane.waiting.some((r) => /^window/.test(r));
  const isProbe = lane.waiting.some((r) => /^exit\(/.test(r));
  const note = isWindow
    ? 'opens on schedule — no action needed'
    : (isProbe
      ? 'clears when the probe passes — no action needed'
      : 'clears when the dependency lands — no action needed');
  return `<div class="wait-banner">
    <span class="wait-label">⧗ WAITING</span>
    <span class="wait-refs">on ${refs}</span>
    <span class="wait-note">${note}</span>
  </div>`;
}

// A runnable lane held back by admission control (DESIGN §25 rule 3):
// "serialized: waiting on <blocker>". Like a dep/window wait it needs no human
// action — it starts the moment the slot frees — so it reads as the same calm
// cyan info banner, never an alert.
function serializedBannerHtml(lane) {
  if (!lane.serialized) return '';
  return `<div class="wait-banner">
    <span class="wait-label">⧗ SERIALIZED</span>
    <span class="wait-refs">${esc(lane.serialized.replace(/^serialized: /, ''))}</span>
    <span class="wait-note">runs when the slot frees — no action needed</span>
  </div>`;
}

function laneHtml(p, lane) {
  const running = lane.running;
  const waiting = !!lane.waiting?.length;
  const editableFrom = lane.cursor + (running ? 1 : 0);
  const steps = lane.steps.map((s, i) => {
    const active = i === lane.cursor && running;
    // The step at the cursor is the one holding a waiting lane (DESIGN §22) —
    // point at it with the ⧗ glyph so it's clear WHICH step is blocked on a dep.
    const waitingHere = i === lane.cursor && waiting;
    const glyph = active ? GLYPH.running : (waitingHere ? GLYPH.waiting : (GLYPH[s.status] || '·'));
    // Dependency chips: `#id` marks a step other lanes can wait on; `⧗ refs`
    // marks a step that itself waits on those refs.
    const idChip = s.id ? `<span class="step-id" title="step label — other lanes can wait on this (waitsFor target)">#${esc(s.id)}</span>` : '';
    const waitsChip = s.waitsFor?.length
      ? `<span class="step-waits" title="won't run until these land: ${esc(s.waitsFor.join(', '))}">⧗ ${esc(s.waitsFor.join(', '))}</span>` : '';
    // A `when` schedule chip (DESIGN §23): advertises a time/date-window or rule
    // gate on a queued step even before its lane is actively waiting on it.
    const whenChip = s.whenLabel
      ? `<span class="step-when" title="only runs when: ${esc(s.whenLabel)}">⏰ ${esc(s.whenLabel)}</span>` : '';
    const tools = (i >= editableFrom && s.status === 'pending') ? `
      <span class="step-tools">
        <button class="btn ghost" title="Move this step earlier in the queue" data-action="step-up" data-lane="${esc(lane.name)}" data-idx="${i}" ${i <= editableFrom ? 'disabled' : ''}>↑</button>
        <button class="btn ghost" title="Move this step later in the queue" data-action="step-down" data-lane="${esc(lane.name)}" data-idx="${i}" ${i >= lane.steps.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn ghost" title="Edit this step's prompt/command" data-action="step-edit" data-lane="${esc(lane.name)}" data-idx="${i}" data-type="${esc(s.type)}">✎</button>
        <button class="btn ghost" title="Remove this step from the queue" data-action="step-del" data-lane="${esc(lane.name)}" data-idx="${i}">✕</button>
      </span>` : '';
    return `<li class="step ${esc(s.status)}${waitingHere ? ' waiting-here' : ''}">
      <span class="step-idx">${i}</span>
      <span class="step-glyph">${glyph}</span>
      <span class="step-text">${esc(s.summary)}</span>
      ${idChip}${waitsChip}${whenChip}
      <span class="step-type">${esc(s.type)}</span>${tools}
    </li>`;
  }).join('');

  const failed = lane.gateKind === 'failure';
  const dot = running ? 'running' : (failed ? 'failed' : (lane.gate ? 'blocked' : (waiting ? 'waiting' : 'idle')));

  return `<article class="lane ${running ? 'is-running' : ''} ${lane.gate ? 'is-blocked' : ''} ${failed ? 'is-failed' : ''} ${waiting ? 'is-waiting' : ''}">
    <div class="lane-head">
      <span class="dot ${dot}">●</span>
      <span class="lane-name">${esc(lane.name)}</span>
      ${lane.parent ? `<span class="lane-parent">⑂ ${esc(lane.parent)}</span>` : ''}
      <span class="lane-meta">[${lane.cursor}/${lane.steps.length}] ${esc(failed ? 'failed' : lane.status)}${lane.spent ? ` · $${lane.spent.toFixed(2)}` : ''}</span>
    </div>
    ${gateBannerHtml(lane)}
    ${waitBannerHtml(lane)}
    ${serializedBannerHtml(lane)}
    ${steps ? `<ul class="steps">${steps}</ul>` : ''}
    ${lane.onEmpty === 'default' && lane.default ? `<div class="lane-default">${esc(lane.default.task || lane.default.run || 'default')} <span class="step-type">(${esc(lane.default.type || 'ai')} · recurring)</span></div>` : ''}
    <div class="lane-actions">
      ${running ? `
        <button class="btn" title="Watch the running step's live terminal" data-action="attach" data-project="${esc(p.id)}" data-lane="${esc(lane.name)}">ATTACH</button>
        <button class="btn warn" title="Send SIGINT (Ctrl-C) to the running step" data-action="interrupt" data-lane="${esc(lane.name)}">INTERRUPT</button>`
    : `<button class="btn accent" title="Run this lane's next step now (a manual one-lane fire)" data-action="run" data-lane="${esc(lane.name)}">▸ RUN</button>`}
      <button class="btn ghost" title="Review this lane's branch diff before landing (worktree/inplace lanes)" data-action="diff" data-lane="${esc(lane.name)}">DIFF</button>
      <button class="btn ghost" title="Replay this lane's last run log (AI steps rendered as a transcript)" data-action="log" data-project="${esc(p.id)}" data-lane="${esc(lane.name)}">LOG</button>
      <button class="btn ghost" title="Create a new sibling lane branched from this one" data-action="fork" data-lane="${esc(lane.name)}">FORK</button>
    </div>
    <form class="add-row" data-action="add-step" data-lane="${esc(lane.name)}">
      <select name="type"><option>command</option><option>ai</option><option>manual</option></select>
      <input name="task" placeholder="queue a step…" autocomplete="off" title="A prompt (ai), a shell command (command), or gate text (manual)">
      <button class="btn" type="submit" title="Queue this step onto the lane">ADD</button>
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
        ${p.parallel ? `<span class="run-count ${p.parallel.running.length ? 'live' : ''}" title="parallel lanes (DESIGN §25): ${p.parallel.running.length} running, max ${p.parallel.max}${p.parallel.running.length ? ` — ${esc(p.parallel.running.join(', '))}` : ''}">▸ ${p.parallel.running.length}/${p.parallel.max}</span>` : ''}
        ${allowShell ? `<button class="btn ghost" data-action="shell" title="open a shell on this host (web-SSH)">SHELL</button>` : ''}
        ${allowGfx && gfxRunners.length ? `<button class="btn ghost" data-action="gui" title="stream a runner's GUI (Xpra/noVNC)">GUI</button>` : ''}
        <button class="btn ${p.paused ? 'primary' : 'warn'}" title="${p.paused ? 'Resume the herd — lanes can run again' : 'Pause the herd — no lanes run until resumed'}" data-action="${p.paused ? 'resume' : 'pause'}">${p.paused ? 'RESUME' : 'PAUSE'}</button>
      </div>
      ${p.paused ? '<div class="paused-banner">⏸ PAUSED — no lanes will run until resumed</div>' : ''}
      ${(p.overlaps || []).map((o) => `<div class="overlap-banner">⚠ scope overlap: <strong>${esc(o.lanes.join(' + '))}</strong> both touch ${esc(o.files.join(', '))}${o.count > o.files.length ? ` (+${o.count - o.files.length} more)` : ''} — land conflicts likely (DESIGN §25)</div>`).join('')}
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

// Manually fire one lane's next step (the RUN button). The run happens in the
// serve process and streams live like a cron fire; the response tells us how it
// started so we can toast the real outcome. A paused herd offers a force retry.
async function runLane(id, lane, force = false) {
  try {
    const res = await api(`/api/projects/${encodeURIComponent(id)}/run`, { lane, force });
    const o = res.outcome;
    if (o === 'running') toast('ok', `▸ ${lane}: running`);
    else if (o === 'ran') toast('ok', `▸ ${lane}: step ${res.step} → ${res.result}`);
    else if (o === 'not-runnable') toast('gate', `${lane}: ${res.reason}`, 7000);
    else if (o === 'locked') toast('gate', `${lane}: a run is already in progress`);
    else if (o === 'idle') toast('gate', `${lane}: nothing runnable`);
    else if (o === 'paused') {
      // eslint-disable-next-line no-alert
      if (confirm(`The herd is paused. Force-run '${lane}' this once anyway?`)) { await runLane(id, lane, true); return; }
    } else toast('ok', `${lane}: ${o || 'ok'}`);
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
  else if (action === 'run') runLane(id, lane);
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
  } else if (action === 'shell') {
    openShell(id, 'local');
  } else if (action === 'gui') {
    openGui(id);
  } else if (action === 'diff') {
    openDiff(id, lane);
  } else if (action === 'log') {
    openLog(id, lane);
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
      if (ev.event === 'gate.blocked') {
        const err = ev.kind === 'failure';
        toast(err ? 'error' : 'gate', `${err ? '✗' : '◆'} ${ev.lane}: ${ev.reason || 'blocked'}`, 8000);
      }
      // A cross-lane wait that has stalled the whole herd (DESIGN §22) — a true
      // dependency cycle is a red deadlock, a plain stall is amber (both need a
      // human to land a prerequisite or break a dependency; neither self-clears).
      if (ev.event === 'waitsFor.deadlock') {
        toast('error', `⧗ DEADLOCK: ${(ev.cycle || []).join(' ⇄ ')} — ack or remove a dependency`, 10000);
      }
      if (ev.event === 'waitsFor.stalled') {
        toast('gate', `⧗ stalled: ${(ev.waiting || []).map((w) => w.lane).join(', ')} waiting on unmet dependencies`, 8000);
      }
      if (ev.event === 'run.exit') toast('ok', `${ev.lane} exited (${ev.code === 0 ? 'ok' : `code ${ev.code}`})`);
      // Auto-follow (opt-in): open the starting run's live terminal, but only
      // when idle (no panel open) or when the open panel is one WE auto-opened —
      // so it hops to the newest run without yanking you out of a diff/shell/log
      // you opened yourself.
      if (ev.event === 'run.start' && followRuns && ev.lane) {
        const idle = panel.hidden && diffPanel.hidden && gfxPanel.hidden;
        if (idle || autoFollowedTerm) {
          openTerminal(id, ev.lane);
          autoFollowedTerm = true;
        }
      }
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
  autoFollowedTerm = false; // any open path calls this ⇒ a fresh panel is never mistaken for an auto-followed one
  panel.hidden = true;
}

// Map a WS close code to a short human status shown in the panel title.
function closeReason(code) {
  if (code === 4404) return 'not running';
  if (code === 4403) return 'disabled (start serve with --allow-shell)';
  if (code === 4429) return 'too many shell sessions';
  if (code === 4400 || code === 4500) return 'unavailable';
  return 'ended';
}

// Opens the xterm panel bridged onto a WS pty stream. Both a running step's
// control socket (/ws/pty, attach) and a serve-owned runner shell (/ws/shell,
// web-SSH) speak the same frame protocol — output frames out, input/resize/
// signal in — so they share this exact wiring; only the URL + title differ.
// `createOutputRenderer` (the stream-json → readable-transcript renderer) lives
// in the shared /render.mjs so the CLI `taskherd attach` paints AI steps the
// SAME way this console does — one implementation, no drift (DESIGN §3).

// Open the terminal panel with a fresh xterm (mutually exclusive with the diff /
// gfx panels). Shared by the live pty bridge (openPty) and the static log replay
// (openLog) — both paint through the same createOutputRenderer.
function mountTerm(title) {
  closeTerminal();
  closeDiff();
  closeGfx();
  panel.hidden = false;
  termTitle.textContent = title;
  term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, SF Mono, Menlo, monospace', theme: { background: '#0a0c0a' }, convertEol: false });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termHost);
  fit.fit();
  return term;
}

function openPty(wsUrl, title) {
  mountTerm(title);
  termWs = new WebSocket(wsUrl);
  // A streaming UTF-8 decoder (so a multibyte char split across output frames
  // isn't corrupted) feeding the raw/stream-json renderer.
  const decoder = new TextDecoder();
  const renderer = createOutputRenderer(term);
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
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        renderer.feed(decoder.decode(bytes, { stream: true }));
      }
    } catch { /* ignore malformed frame */ }
  };
  termWs.onclose = (e) => {
    renderer.flush(); // paint any final event that arrived without a trailing newline
    termTitle.textContent = `${title} — ${closeReason(e.code)}`;
    if (term) term.write('\r\n\x1b[33m[taskherd: stream closed]\x1b[0m\r\n');
    termWs = null;
  };
  term.onData((d) => {
    if (termWs?.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ type: 'input', data: d }));
  });
  term.onResize(sendResize);
  window.addEventListener('resize', () => { if (fit) fit.fit(); });
}

const wsProto = () => (location.protocol === 'https:' ? 'wss' : 'ws');

// Replay a lane's last run log into the terminal panel — the historical twin of
// ATTACH (once a step exits its control socket is gone, but the pty log file
// remains). Static (no WS), rendered through the SAME createOutputRenderer, so an
// ai step reads back as a transcript, not raw stream-json.
async function openLog(id, lane) {
  mountTerm(`${lane} — log…`);
  const mine = term; // guard against the user opening another panel mid-fetch
  let log;
  try {
    log = await api(`/api/projects/${encodeURIComponent(id)}/log?lane=${encodeURIComponent(lane)}`);
  } catch (err) {
    if (err.message !== 'unauthorized' && term === mine) term.write(`\r\n\x1b[31m✗ ${err.message}\x1b[0m\r\n`);
    return;
  }
  if (term !== mine) return;
  if (!log.exists) {
    termTitle.textContent = `${lane} — log`;
    term.write(`\x1b[2mno logs yet for ${lane} — run a step first\x1b[0m\r\n`);
    return;
  }
  termTitle.textContent = `${lane} — ${log.file}${log.truncated ? ' (truncated)' : ''}`;
  const renderer = createOutputRenderer(term);
  renderer.feed(log.text);
  renderer.flush();
}

function openTerminal(id, lane) {
  openPty(
    `${wsProto()}://${location.host}/ws/pty?project=${encodeURIComponent(id)}&lane=${encodeURIComponent(lane)}&token=${encodeURIComponent(token())}`,
    `${lane} — live`,
  );
}

// Web-SSH (§15 L2): a serve-owned interactive shell into a runner host. Only
// reachable when serve ran with --allow-shell (the SHELL button is hidden
// otherwise); a disabled server closes the WS with 4403, surfaced in the title.
function openShell(id, runner) {
  openPty(
    `${wsProto()}://${location.host}/ws/shell?project=${encodeURIComponent(id)}&runner=${encodeURIComponent(runner)}&token=${encodeURIComponent(token())}`,
    `${runner} shell`,
  );
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
  closeGfx();
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

// ── graphical stream (§15 Layer 2 — Xpra/noVNC) ──────────────────────────
// The runner runs its own Xpra/noVNC server; serve reverse-proxies its HTML5
// client under an unguessable capability path (minted by gfx-open) that we drop
// into an iframe. A runner with no graphical endpoint returns a 400+standin —
// surfaced as a toast, never a silent blank frame.
const gfxPanel = document.getElementById('gfx-panel');
const gfxFrame = document.getElementById('gfx-frame');
const gfxTitle = document.getElementById('gfx-title');

function closeGfx() {
  gfxPanel.hidden = true;
  gfxFrame.removeAttribute('src'); // stop the stream + drop the proxied WS
}

async function openGui(id) {
  let runner = gfxRunners[0];
  if (gfxRunners.length > 1) {
    const pick = prompt(`stream which runner's GUI?\n(${gfxRunners.join(', ')})`, gfxRunners[0]);
    if (!pick) return;
    runner = pick.trim();
  }
  if (!runner) { toast('error', 'no graphical runner configured (runners.json "graphical")'); return; }
  let r;
  try {
    r = await api(`/api/projects/${encodeURIComponent(id)}/gfx-open`, { runner });
  } catch (err) {
    if (err.message !== 'unauthorized') toast('error', err.message); // 400+standin lands here
    return;
  }
  closeTerminal();
  closeDiff();
  gfxPanel.hidden = false;
  gfxTitle.textContent = `${r.name} — ${r.kind}`;
  gfxFrame.src = r.url;
}

document.getElementById('gfx-close').onclick = closeGfx;

// ── resizable bottom pane ────────────────────────────────────────────────
// Drag a panel's top-edge handle to resize the lanes/panel split. The height is
// a shared CSS var, so it applies to whichever of term/diff/gfx is open. On drag
// we re-emit `resize` so the xterm fit addon reflows to the new height.
for (const handle of document.querySelectorAll('.panel-resize')) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const h = Math.max(140, Math.min(window.innerHeight * 0.82, window.innerHeight - ev.clientY));
      document.documentElement.style.setProperty('--panel-h', `${h}px`);
      window.dispatchEvent(new Event('resize'));
    };
    const onUp = (ev) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// ── boot ────────────────────────────────────────────────────────────────
scheduleRefresh();
setInterval(scheduleRefresh, 20000); // safety net if a watcher/WS misses a change
