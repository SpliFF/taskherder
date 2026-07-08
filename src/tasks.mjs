// Lane store (DESIGN.md §5): load/save lane files, the five-axis step model
// (command + manual only this milestone — ai lands in M2), config inheritance.
import {
  mkdir, readFile, writeFile, readdir, appendFile, rename,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  repoTasksDir, laneFile, projectConfigFile, logsDir, descDir, runDir,
  taskherdHome, runSocketLink,
} from './paths.mjs';
import { loadProjectConfig, loadUserConfig, resolveConfig } from './config.mjs';
import { registerProject } from './registry.mjs';
import {
  isGitRepo, laneBranch, branchExists, branchBase, defaultBase, aheadCount,
  landMerge, pushAndOpenPr,
} from './git.mjs';
import { appendEvent } from './events.mjs';

const execFileAsync = promisify(execFile);

const STEP_TYPES = ['command', 'ai', 'manual'];

// A step `id` / lane name token: letters, digits, ., _, - (no ':' — that's the
// waitsFor lane:id separator). Shared with validateLaneName's charset.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class LaneValidationError extends Error {}

// Parses one `waitsFor` reference (DESIGN §22 cross-lane dependencies) into its
// target. Three forms:
//   "lane:id"  → step `id` in lane `lane`     (the cross-lane case)
//   ":id"      → step `id` in the SAME lane   (leading colon = self)
//   "lane"     → the whole lane's queue drained (no colon = whole-lane)
// `lane: null` means "resolve against the waiting step's own lane". Throws on a
// malformed ref so a bad dependency fails loudly at write time (DESIGN §1) — the
// TARGET's existence is a runtime question (it may not be enqueued yet), checked
// live by evaluateWaits, not here.
export function parseWaitRef(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new LaneValidationError(`taskherd: waitsFor entry must be a non-empty string, got ${JSON.stringify(ref)}`);
  }
  const r = ref.trim();
  const colon = r.indexOf(':');
  if (colon !== -1) {
    const lanePart = r.slice(0, colon);
    const idPart = r.slice(colon + 1);
    if (!TOKEN.test(idPart)) {
      throw new LaneValidationError(`taskherd: waitsFor ${JSON.stringify(ref)} — step id after ':' must be letters/digits/._- (e.g. "grammar-unification:U2")`);
    }
    if (lanePart !== '' && !TOKEN.test(lanePart)) {
      throw new LaneValidationError(`taskherd: waitsFor ${JSON.stringify(ref)} — lane before ':' is not a valid lane name`);
    }
    return { lane: lanePart || null, stepId: idPart };
  }
  if (!TOKEN.test(r)) {
    throw new LaneValidationError(`taskherd: waitsFor ${JSON.stringify(ref)} — a bare reference must be a lane name (whole-lane wait); use "lane:id" for a specific step`);
  }
  return { lane: r, stepId: null };
}

export function validateStep(step) {
  if (!step || typeof step !== 'object') {
    throw new LaneValidationError(`taskherd: step must be an object, got ${JSON.stringify(step)}`);
  }
  if (!STEP_TYPES.includes(step.type)) {
    throw new LaneValidationError(
      `taskherd: unsupported step type ${JSON.stringify(step.type)} (supported: ${STEP_TYPES.join(', ')})`,
    );
  }
  if (step.type === 'command' && !step.run && !step.argv) {
    throw new LaneValidationError('taskherd: command step needs `run` (shell string) or `argv` (array)');
  }
  // `provider` is resolved by inheritance (step → lane → config) at run time, so
  // it is NOT required here — only a prompt source is (DESIGN §5, §8).
  if (step.type === 'ai' && !step.task && !step.file) {
    throw new LaneValidationError('taskherd: ai step needs a `task` (prompt string) or `file` (file-as-prompt path)');
  }
  if (step.type === 'manual' && !step.message) {
    throw new LaneValidationError('taskherd: manual step needs `message`');
  }
  // Optional cross-lane dependency fields (DESIGN §22). `id` labels a step so
  // other lanes can wait on it; `waitsFor` lists refs that must be satisfied
  // before this step runs. Shape-validated here; satisfaction is a run-time,
  // whole-tree question (evaluateWaits).
  if (step.id != null && (typeof step.id !== 'string' || !TOKEN.test(step.id))) {
    throw new LaneValidationError(`taskherd: step id ${JSON.stringify(step.id)} must be letters/digits/._- (used as a waitsFor target)`);
  }
  if (step.waitsFor != null) {
    if (!Array.isArray(step.waitsFor)) {
      throw new LaneValidationError('taskherd: step `waitsFor` must be an array of "lane:id" / "lane" references');
    }
    for (const ref of step.waitsFor) parseWaitRef(ref);
  }
  // Optional precondition rule tree (DESIGN §23). Shape-validated here (leaves +
  // combinators); satisfaction is a run-time question (evaluateWhen/evaluateGate).
  if (step.when != null) parseWhen(step.when);
  return step;
}

// Evaluates ONE cross-lane dependency ref against the lane set. Returns an unmet
// descriptor (with a classified `reason`) or `null` when satisfied. Shared by
// `evaluateWaits` (the `waitsFor` sugar) and the `dep` leaf of the `when` rule
// tree (evaluateWhen) — one source of truth for what "a dependency is met" means.
//   step-pending  — target step exists, not `done` yet (the normal, will-clear case)
//   lane-pending  — whole-lane target still has queued steps
//   missing-step  — target lane exists but has no step with that id (not enqueued yet / typo)
//   missing-lane  — no such lane
export function evalDepRef(ref, selfLane, lanesByName) {
  const { lane: refLane, stepId } = parseWaitRef(ref);
  const targetLane = refLane || selfLane;
  const target = lanesByName[targetLane];
  if (!target) return { ref, targetLane, stepId, reason: 'missing-lane' };
  if (stepId == null) {
    if ((target.cursor || 0) < (target.steps?.length || 0)) {
      return { ref, targetLane, stepId: null, reason: 'lane-pending' };
    }
    return null;
  }
  const targetStep = (target.steps || []).find((s) => s.id === stepId);
  if (!targetStep) return { ref, targetLane, stepId, reason: 'missing-step' };
  if (targetStep.status !== 'done') return { ref, targetLane, stepId, reason: 'step-pending' };
  return null;
}

// Evaluates a step's `waitsFor` against the whole lane set (a name→lane map).
// `selfLane` resolves same-lane (`:id`) refs. Returns the UNMET references with a
// classified reason so callers can surface why a lane isn't moving.
// satisfied === (unmet.length === 0). A step with no waitsFor is trivially satisfied.
export function evaluateWaits(step, selfLane, lanesByName) {
  const refs = step?.waitsFor;
  if (!Array.isArray(refs) || refs.length === 0) return { satisfied: true, unmet: [] };
  const unmet = [];
  for (const ref of refs) {
    const u = evalDepRef(ref, selfLane, lanesByName);
    if (u) unmet.push(u);
  }
  return { satisfied: unmet.length === 0, unmet };
}

// ── Rules engine — the `when` tree (DESIGN §23) ────────────────────────────
// A step's optional `when` field is a nestable boolean tree of preconditions,
// evaluated each fire like `waitsFor`: unmet ⇒ the step is SOFT-skipped (no gate,
// no ack, nothing persisted) and re-checked next fire. `waitsFor` is sugar for a
// top-level AND of `dep` leaves; `when` ANDs with it. Phase 1 leaves: `window`
// (pure time/date) + `dep` (== a waitsFor ref). Combinators: all / any / not.
// The `exit` probe (run a command, compare its code) is Phase 2 — parseWhen
// rejects it loudly rather than silently ignoring it (DESIGN §1/§12).

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseHHMM(s, field) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new LaneValidationError(`taskherd: when.window.${field} must be "HH:MM", got ${JSON.stringify(s)}`);
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) throw new LaneValidationError(`taskherd: when.window.${field} out of range: ${JSON.stringify(s)}`);
  return h * 60 + min;
}

// Parses a `days` spec (string "Mon-Fri" / "Sat,Sun" / "Mon", or an array of
// those) into a Set of weekday numbers (0=Sun..6=Sat). Ranges wrap (e.g.
// "Fri-Mon" = Fri,Sat,Sun,Mon). Throws loudly on an unknown day name.
function parseDays(spec) {
  const dayNum = (name) => {
    const i = WEEKDAYS.indexOf(String(name).trim().slice(0, 3).toLowerCase());
    if (i === -1) throw new LaneValidationError(`taskherd: when.window.days — unknown weekday ${JSON.stringify(name)} (use Sun..Sat)`);
    return i;
  };
  const parts = (Array.isArray(spec) ? spec : String(spec).split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (parts.length === 0) throw new LaneValidationError('taskherd: when.window.days is empty');
  const out = new Set();
  for (const part of parts) {
    const range = part.split('-');
    if (range.length === 2) {
      let a = dayNum(range[0]); const b = dayNum(range[1]);
      for (let i = 0; i < 7; i += 1) { out.add(a); if (a === b) break; a = (a + 1) % 7; }
    } else {
      out.add(dayNum(part));
    }
  }
  return out;
}

// Absolute date/datetime bound. A bare "YYYY-MM-DD" is midnight in the window's
// tz (so `local` isn't silently shifted by UTC parsing); a full datetime parses
// as-is. Returns epoch ms. Throws loudly on an unparseable value.
function parseBound(s, field, tz) {
  const str = String(s).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  let ms;
  if (dateOnly) {
    const [, y, mo, d] = dateOnly.map(Number);
    ms = tz === 'utc' ? Date.UTC(y, mo - 1, d) : new Date(y, mo - 1, d).getTime();
  } else {
    ms = Date.parse(str);
  }
  if (Number.isNaN(ms)) throw new LaneValidationError(`taskherd: when.window.${field} is not a valid date/datetime: ${JSON.stringify(s)}`);
  return ms;
}

// Validates + normalizes a `window` leaf into a cheap struct the evaluator uses
// (times → minutes, days → a weekday Set, bounds → epoch ms). windowSatisfied /
// windowNextOpen operate on this normalized form.
export function parseWindow(win) {
  if (!win || typeof win !== 'object' || Array.isArray(win)) {
    throw new LaneValidationError(`taskherd: when.window must be an object, got ${JSON.stringify(win)}`);
  }
  const tz = win.tz == null ? 'local' : String(win.tz).toLowerCase();
  if (tz !== 'local' && tz !== 'utc') {
    throw new LaneValidationError(`taskherd: when.window.tz must be "local" or "utc" (Phase 1), got ${JSON.stringify(win.tz)}`);
  }
  const norm = { tz, raw: win };
  if (win.after != null) norm.after = parseHHMM(win.after, 'after');
  if (win.before != null) norm.before = parseHHMM(win.before, 'before');
  if (win.days != null) norm.days = parseDays(win.days);
  if (win.from != null) norm.from = parseBound(win.from, 'from', tz);
  if (win.until != null) norm.until = parseBound(win.until, 'until', tz);
  if (norm.after == null && norm.before == null && norm.days == null && norm.from == null && norm.until == null) {
    throw new LaneValidationError('taskherd: when.window needs at least one of after/before/days/from/until');
  }
  return norm;
}

// tz-aware parts of a Date (local vs utc), so the same code path serves both.
function partsOf(d, tz) {
  return tz === 'utc'
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() }
    : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), wd: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
}
function instantAt(y, mo, d, minutes, tz) {
  const hh = Math.floor(minutes / 60); const mm = minutes % 60;
  return tz === 'utc' ? new Date(Date.UTC(y, mo, d, hh, mm)) : new Date(y, mo, d, hh, mm);
}

// Is `now` inside the window? Pure. All present fields are ANDed; an after>before
// pair is an overnight wraparound (e.g. 22:00–06:00).
export function windowSatisfied(win, now) {
  const p = partsOf(now, win.tz);
  if (win.days && !win.days.has(p.wd)) return false;
  if (win.from != null && now.getTime() < win.from) return false;
  if (win.until != null && now.getTime() >= win.until) return false;
  const { after: a, before: b } = win;
  if (a != null && b != null) return a <= b ? (p.min >= a && p.min < b) : (p.min >= a || p.min < b);
  if (a != null) return p.min >= a;
  if (b != null) return p.min < b;
  return true;
}

// Best-effort next wall-clock instant the window opens (for a status ETA). Every
// closed→open transition lands on one of {`from`, a day's 00:00, a day's `after`},
// so testing those candidates over the next 2 weeks finds the earliest. Returns
// `{ nextOpen: Date|null, closed: bool }` — closed when `until` has passed.
export function windowNextOpen(win, now) {
  if (win.until != null && now.getTime() >= win.until) return { nextOpen: null, closed: true };
  let best = null;
  const consider = (inst) => {
    if (inst.getTime() > now.getTime() && windowSatisfied(win, inst) && (best === null || inst.getTime() < best.getTime())) best = inst;
  };
  if (win.from != null) consider(new Date(win.from));
  for (let off = 0; off <= 14; off += 1) {
    const base = new Date(now.getTime() + off * 86400000);
    const p = partsOf(base, win.tz);
    consider(instantAt(p.y, p.mo, p.d, 0, win.tz));
    if (win.after != null) consider(instantAt(p.y, p.mo, p.d, win.after, win.tz));
  }
  return { nextOpen: best, closed: false };
}

function fmtInstant(d, tz) {
  const p = partsOf(d, tz);
  const pad = (n) => String(n).padStart(2, '0');
  const wd = WEEKDAYS[p.wd].replace(/^\w/, (c) => c.toUpperCase());
  return `${wd} ${p.y}-${pad(p.mo + 1)}-${pad(p.d)} ${pad(Math.floor(p.min / 60))}:${pad(p.min % 60)}${tz === 'utc' ? 'Z' : ''}`;
}

// Validates a `when` rule tree (recursively), throwing loudly on any unknown or
// not-yet-implemented rule so a bad/aspirational rule fails at write time, never
// silently passes at run time. Returns the tree unchanged.
export function parseWhen(rule) {
  if (rule == null) return rule;
  if (typeof rule !== 'object' || Array.isArray(rule)) {
    throw new LaneValidationError(`taskherd: a \`when\` rule must be an object, got ${JSON.stringify(rule)}`);
  }
  const keys = Object.keys(rule);
  if (keys.length !== 1) {
    throw new LaneValidationError(`taskherd: a \`when\` rule must have exactly one key (all/any/not/window/dep), got {${keys.join(', ')}}`);
  }
  const [key] = keys;
  const val = rule[key];
  if (key === 'all' || key === 'any') {
    if (!Array.isArray(val) || val.length === 0) throw new LaneValidationError(`taskherd: when.${key} must be a non-empty array of rules`);
    val.forEach((r) => parseWhen(r));
  } else if (key === 'not') {
    parseWhen(val);
  } else if (key === 'window') {
    parseWindow(val);
  } else if (key === 'dep') {
    parseWaitRef(val);
  } else if (key === 'exit' || key === 'file' || key === 'http' || key === 'env') {
    throw new LaneValidationError(`taskherd: \`when\` rule "${key}" is not implemented yet (Phase 1 supports window/dep + all/any/not); see PLAN-rules.md`);
  } else {
    throw new LaneValidationError(`taskherd: unknown \`when\` rule "${key}" (expected all/any/not/window/dep)`);
  }
  return rule;
}

// Compact human string for a rule (status/ETA surfacing).
function describeWhen(rule) {
  const [key] = Object.keys(rule);
  const val = rule[key];
  if (key === 'all' || key === 'any') return `${key}(${val.map(describeWhen).join(', ')})`;
  if (key === 'not') return `not(${describeWhen(val)})`;
  if (key === 'dep') return `dep ${val}`;
  if (key === 'window') {
    const w = val;
    const bits = [];
    if (w.days) bits.push(String(Array.isArray(w.days) ? w.days.join(',') : w.days));
    if (w.after || w.before) bits.push(`${w.after || '00:00'}-${w.before || '24:00'}`);
    if (w.from) bits.push(`from ${w.from}`);
    if (w.until) bits.push(`until ${w.until}`);
    return `window(${bits.join(' ')})`;
  }
  return key;
}

// Evaluates a `when` rule tree against a context {selfLane, lanesByName, now}.
// Returns `{ satisfied, unmet[] }` — the same shape as evaluateWaits, so every
// waiting/stall/status consumer extends for free. Each unmet entry carries a
// human `ref` and a `reason` (window unmet ⇒ reason:'window', so stall detection
// can tell a self-clearing clock wait from a dep that may deadlock).
export function evaluateWhen(rule, ctx) {
  if (rule == null) return { satisfied: true, unmet: [] };
  const [key] = Object.keys(rule);
  const val = rule[key];
  if (key === 'all') {
    const unmet = [];
    for (const r of val) unmet.push(...evaluateWhen(r, ctx).unmet);
    return { satisfied: unmet.length === 0, unmet };
  }
  if (key === 'any') {
    const subs = val.map((r) => evaluateWhen(r, ctx));
    if (subs.some((s) => s.satisfied)) return { satisfied: true, unmet: [] };
    return { satisfied: false, unmet: [{ reason: 'any', ref: describeWhen(rule) }] };
  }
  if (key === 'not') {
    const sub = evaluateWhen(val, ctx);
    if (sub.satisfied) return { satisfied: false, unmet: [{ reason: 'not', ref: `not(${describeWhen(val)})` }] };
    return { satisfied: true, unmet: [] };
  }
  if (key === 'dep') {
    const u = evalDepRef(val, ctx.selfLane, ctx.lanesByName);
    return u ? { satisfied: false, unmet: [u] } : { satisfied: true, unmet: [] };
  }
  // window
  const win = parseWindow(val);
  if (windowSatisfied(win, ctx.now)) return { satisfied: true, unmet: [] };
  const { nextOpen, closed } = windowNextOpen(win, ctx.now);
  const ref = closed ? `window (closed)` : (nextOpen ? `window (opens ${fmtInstant(nextOpen, win.tz)})` : 'window (waiting)');
  return { satisfied: false, unmet: [{ reason: 'window', ref, nextOpen: nextOpen ? nextOpen.toISOString() : null, closed }] };
}

// The unified precondition gate for a step: `waitsFor` (dep sugar) AND `when`
// (the rule tree), merged into one `{ satisfied, unmet[] }`. This is what the
// scheduler and status consult — one place that decides "may this step start?".
export function evaluateGate(step, selfLane, lanesByName, now = new Date()) {
  const unmet = [...evaluateWaits(step, selfLane, lanesByName).unmet];
  if (step?.when != null) unmet.push(...evaluateWhen(step.when, { selfLane, lanesByName, now }).unmet);
  return { satisfied: unmet.length === 0, unmet };
}

// Which lanes are soft-waiting on an unmet precondition right now (DESIGN §22/§23):
// a lane whose next action is a step with an unmet `waitsFor`/`when`. Pure over a
// lane set — shared by the scheduler (skip these this fire) and status rendering
// (show the wait). A `blocked` lane is a real gate/failure, not a soft wait, so
// it's excluded. Returns `[{ lane: name, index, unmet }]`.
export function computeWaiting(lanes, fallback = {}, now = new Date()) {
  const byName = Object.fromEntries(lanes.map((l) => [l.name, l]));
  const waiting = [];
  for (const lane of lanes) {
    if (lane.status === 'blocked') continue;
    const action = nextAction(lane, fallback);
    if (action.kind === 'idle') continue;
    const { satisfied, unmet } = evaluateGate(action.step, lane.name, byName, now);
    if (!satisfied) waiting.push({ lane: lane.name, index: action.index, unmet });
  }
  return waiting;
}

// Finds lanes trapped in a `waitsFor` CYCLE (A waits on B, B waits on A) — a true
// deadlock that will never self-clear, vs. a lane merely waiting on one that can
// still make progress. Edges only count toward a cycle when they point at
// another WAITING lane (a wait on a runnable/idle lane will resolve on its own).
// Returns the lane names on any cycle (empty if none). Used to escalate a stall
// from "surface it" to "loud DEADLOCK" (DESIGN §1/§22).
export function detectWaitCycles(waiting) {
  const waitingNames = new Set(waiting.map((w) => w.lane));
  const adj = new Map();
  for (const w of waiting) {
    const outs = new Set();
    for (const u of w.unmet) if (waitingNames.has(u.targetLane)) outs.add(u.targetLane);
    adj.set(w.lane, outs);
  }
  const onCycle = new Set();
  const state = new Map(); // undefined=unseen, 1=on-stack, 2=done
  const stack = [];
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) || []) {
      if (state.get(next) === 1) {
        for (const n of stack.slice(stack.indexOf(next))) onCycle.add(n);
      } else if (!state.get(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of adj.keys()) if (!state.get(node)) visit(node);
  return [...onCycle];
}

// Axis fields default to null = inherit (step → lane → project → user config,
// DESIGN §5). M1 hardcoded 'none'/'manual-gate'/'local' here, which silently
// pinned every lane and defeated project-level defaults — now only an explicit
// value overrides.
export function newLane(name, overrides = {}) {
  return {
    name,
    parent: null,
    onEmpty: null,
    default: null,
    isolation: null,
    land: null,
    profile: null,
    runner: null,
    provider: null,
    cursor: 0,
    lastRun: 0,
    status: 'idle',
    steps: [],
    ...overrides,
  };
}

export async function laneExists(repo, name) {
  return existsSync(laneFile(repo, name));
}

export async function listLaneNames(repo) {
  const dir = repoTasksDir(repo);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith('.json') && f !== 'config.json' && f !== 'state.json')
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export async function loadLane(repo, name) {
  const raw = await readFile(laneFile(repo, name), 'utf8');
  let lane;
  try {
    lane = JSON.parse(raw);
  } catch (err) {
    throw new LaneValidationError(`taskherd: malformed lane JSON at ${laneFile(repo, name)}: ${err.message}`);
  }
  for (const step of lane.steps || []) validateStep(step);
  return lane;
}

export async function loadAllLanes(repo) {
  const names = await listLaneNames(repo);
  const lanes = [];
  for (const name of names) lanes.push(await loadLane(repo, name));
  return lanes;
}

// Like loadAllLanes but a single broken lane file (bad JSON, an unsupported
// step type from a hand-edit or a pre-M2 `ai` step) does NOT take down every
// other lane. Returns the loadable lanes plus a list of the ones that failed so
// callers can surface them loudly (DESIGN §1: no-silent-failure ≠ fail-everything).
export async function loadAllLanesResilient(repo) {
  const names = await listLaneNames(repo);
  const lanes = [];
  const unloadable = [];
  for (const name of names) {
    try {
      lanes.push(await loadLane(repo, name));
    } catch (err) {
      unloadable.push({ name, error: err.message });
    }
  }
  return { lanes, unloadable };
}

// Atomic write: lane files are the source of truth, so a crash mid-write must
// not leave a truncated/corrupt file. Write a sibling temp then rename (atomic
// on the same filesystem). The temp name avoids `.json` so listLaneNames never
// picks it up as a lane mid-write.
export async function saveLane(repo, lane) {
  for (const step of lane.steps || []) validateStep(step);
  const file = laneFile(repo, lane.name);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(lane, null, 2)}\n`);
  await rename(tmp, file);
  return lane;
}

// Project/user-level `default`/`onEmpty` (DESIGN §6, deferred from M2): a lane
// that doesn't set its own falls back to the project's, then the user's. The
// §5 config example nests `onEmpty` inside the default step object, so both
// spellings count.
export function defaultFallback(projectConfig = {}, userConfig = {}) {
  return {
    onEmpty: projectConfig.onEmpty ?? projectConfig.default?.onEmpty
      ?? userConfig.onEmpty ?? userConfig.default?.onEmpty ?? null,
    default: projectConfig.default ?? userConfig.default ?? null,
  };
}

// Determines what the scheduler should do next with this lane, without
// mutating it. See DESIGN §6 step 5. `fallback` carries the project/user-level
// default + onEmpty (defaultFallback above) for lanes that don't set their own.
export function nextAction(lane, fallback = {}) {
  if (lane.cursor < lane.steps.length) {
    return { kind: 'step', step: lane.steps[lane.cursor], index: lane.cursor };
  }
  const onEmpty = lane.onEmpty ?? fallback.onEmpty ?? 'idle';
  const def = lane.default ?? fallback.default ?? null;
  if (onEmpty === 'default' && def) {
    // Strip the config-side `onEmpty` marker so it doesn't ride into the step.
    const { onEmpty: _configMarker, ...step } = def;
    return { kind: 'default', step: { ...step, status: 'pending' }, index: lane.cursor };
  }
  return { kind: 'idle' };
}

export async function resolveStepConfig(repo, lane, step) {
  const [projectConfig, userConfig] = await Promise.all([loadProjectConfig(repo), loadUserConfig()]);
  return resolveConfig(step, lane, projectConfig, userConfig);
}

// Land check (DESIGN §7): when a lane has finished its queue and its
// taskherd/<lane> branch carries commits beyond base, the land policy decides
// what happens — `manual-gate` (default) appends a blocking gate whose ack
// merges; `pr` pushes the branch + opens a PR; `leave` does nothing. Mutates
// `lane` in memory (caller saves). Lanes that recur via an onEmpty default
// never "complete", so they never land here (§6 steady state); a land-check
// failure logs loudly and degrades to `leave` — the branch keeps the work.
export async function maybeLand(repo, lane) {
  const branch = laneBranch(lane.name);
  try {
    const [projectConfig, userConfig] = await Promise.all([loadProjectConfig(repo), loadUserConfig()]);
    const fallback = defaultFallback(projectConfig, userConfig);
    const onEmpty = lane.onEmpty ?? fallback.onEmpty ?? 'idle';
    if (onEmpty === 'default' && (lane.default ?? fallback.default)) return null;
    if (!(await isGitRepo(repo)) || !(await branchExists(repo, branch))) return null;
    const cfg = resolveConfig(null, lane, projectConfig, userConfig);
    const land = cfg.land || 'manual-gate';
    if (land === 'leave') return null;
    const base = cfg.base || (await branchBase(repo, branch)) || (await defaultBase(repo));
    const ahead = await aheadCount(repo, branch, base);
    if (ahead === 0) return null;

    if (land === 'pr') {
      try {
        const url = await pushAndOpenPr(repo, branch, base, lane.name);
        await appendEvent(repo, {
          event: 'land.pr', lane: lane.name, branch, base, url,
        });
        return { landed: 'pr', url };
      } catch (err) {
        const gate = {
          type: 'manual',
          message: `land: could not push/PR ${branch}: ${err.message} — land it manually, then ack`,
          status: 'blocked',
        };
        lane.steps.push(gate);
        lane.status = 'blocked';
        await appendEvent(repo, {
          event: 'gate.blocked', lane: lane.name, step: lane.steps.length - 1, reason: gate.message,
        });
        return { landed: 'gate', reason: gate.message };
      }
    }

    // manual-gate (default): the gate carries the branch/base so ack knows to merge.
    const gate = {
      type: 'manual',
      message: `land: ${branch} is ${ahead} commit(s) ahead of ${base} — review `
        + `(git diff ${base}...${branch}) and ack to merge`,
      land: { branch, base },
      status: 'blocked',
    };
    lane.steps.push(gate);
    lane.status = 'blocked';
    await appendEvent(repo, {
      event: 'land.gate', lane: lane.name, branch, base, ahead,
    });
    await appendEvent(repo, {
      event: 'gate.blocked', lane: lane.name, step: lane.steps.length - 1, reason: gate.message,
    });
    return { landed: 'gate', reason: gate.message };
  } catch (err) {
    console.error(`taskherd: lane ${lane.name} land check failed (branch ${branch} left in place): ${err.message}`);
    return null;
  }
}

// Clears whatever gate currently sits at the lane's cursor: a land gate merges
// its branch into base first (a failed merge throws and the gate stays), a
// manual gate advances past (cursor++), a parked failure resets for retry in
// place. Shared by the CLI's `ack` and (later) the MCP `tasks_ack` tool.
export async function ackLane(repo, name) {
  validateLaneName(name);
  const lane = await loadLane(repo, name);
  const step = lane.steps[lane.cursor];
  if (!step || (step.status !== 'blocked' && step.status !== 'failed')) {
    // No step-gate at the cursor: a budget-blocked lane whose gate sits on a
    // synthetic default step (cursor past end) is cleared here (DESIGN §10).
    if (lane.status === 'blocked' && lane.budgetBlock) {
      lane.status = 'idle';
      delete lane.budgetBlock;
      // A budget block on the lane's final run suppressed the land check —
      // clearing it re-runs the check so completed work still lands.
      if (lane.cursor >= lane.steps.length) await maybeLand(repo, lane);
      await saveLane(repo, lane);
      return { kind: 'budget', lane };
    }
    return { kind: 'none', lane };
  }
  delete lane.budgetBlock; // clearing a step-gate also clears any budget marker
  if (step.status === 'blocked') {
    const land = step.land?.branch ? step.land : null;
    let merged = null;
    if (land) {
      merged = await landMerge(repo, land.branch, land.base); // throws on conflict; gate stays
      await appendEvent(repo, {
        event: 'land.merged', lane: name, branch: land.branch, base: land.base, commit: merged,
      });
    }
    step.status = 'done';
    lane.cursor += 1;
    lane.status = 'idle';
    // Acking the final gate can complete the queue — the same land trigger as
    // a run finishing in the scheduler (a lane ending in a sign-off gate must
    // still land). An acked land gate's branch is no longer ahead, so no re-gate.
    if (lane.cursor >= lane.steps.length) await maybeLand(repo, lane);
    await saveLane(repo, lane);
    return land ? { kind: 'land', lane, merged: { ...land, commit: merged } } : { kind: 'gate', lane };
  }
  step.status = 'pending';
  step.attempts = 0;
  delete step.parkedReason;
  delete step.error; // the surfaced failure excerpt clears with the retry
  lane.status = 'idle';
  await saveLane(repo, lane);
  return { kind: 'failure', lane };
}

// Lane names become file paths (`.tasks/<name>.json`) and branch names
// (`taskherd/<name>`), and MCP clients pass them straight from an agent — a
// separator or a leading dot must fail loudly, never escape .tasks/.
export function validateLaneName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new LaneValidationError(
      `taskherd: invalid lane name ${JSON.stringify(name)} (letters, digits, ., _, - only; must not start with .)`,
    );
  }
  return name;
}

// Normalizes a `waitsFor` opt (array, or a comma/space-separated string from the
// CLI) into a clean array of ref strings, or null when empty.
export function normalizeWaitsFor(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  const out = arr.map((s) => String(s).trim()).filter(Boolean);
  return out.length ? out : null;
}

// Builds the optional `when` rule tree (DESIGN §23) from opts: a raw `when`
// (object or JSON string) and/or the window convenience fields
// (after/before/days/from/until/tz). When both are given they are ANDed. Returns
// null when nothing is specified. Throws loudly on malformed JSON / rules.
export function whenFromOpts(opts) {
  let explicit = null;
  if (opts.when != null) {
    explicit = typeof opts.when === 'string' ? JSON.parse(opts.when) : opts.when;
  }
  const win = {};
  for (const f of ['after', 'before', 'days', 'from', 'until', 'tz']) {
    if (opts[f] != null) win[f] = opts[f];
  }
  const windowRule = Object.keys(win).length ? { window: win } : null;
  let rule = null;
  if (explicit && windowRule) rule = { all: [explicit, windowRule] };
  else rule = explicit || windowRule;
  return rule ? parseWhen(rule) : null;
}

// The cross-lane dependency fields (DESIGN §22) + the `when` rule tree (§23) are
// common to every step type, like `status` — attach them uniformly so
// `add`/`block`/`fork` all support them.
function withDeps(step, opts) {
  if (opts.id) step.id = opts.id;
  const waitsFor = normalizeWaitsFor(opts.waitsFor);
  if (waitsFor) step.waitsFor = waitsFor;
  const when = whenFromOpts(opts);
  if (when) step.when = when;
  return step;
}

// Canonical step builder shared by every client of the lane files (the CLI's
// `add`, MCP `tasks_add`/`tasks_block`/`tasks_fork` — DESIGN §3: they must not
// drift apart). Opts are camelCase; validates before returning.
export function buildStep(opts = {}) {
  const type = opts.type || 'command';
  if (type === 'manual') {
    return validateStep(withDeps({
      type: 'manual',
      message: opts.message || opts.task,
      ...(opts.file ? { file: opts.file } : {}),
      status: 'pending',
    }, opts));
  }
  if (type === 'ai') {
    const step = { type: 'ai', status: 'pending' };
    if (opts.file) step.file = opts.file;
    else if (opts.task) step.task = opts.task;
    if (opts.provider) step.provider = opts.provider;
    if (opts.model) step.model = opts.model;
    if (opts.profile) step.profile = opts.profile;
    if (opts.runner) step.runner = opts.runner;
    if (opts.session) step.session = typeof opts.session === 'string' ? { mode: opts.session } : opts.session;
    const args = {};
    if (opts.permissionMode) args.permissionMode = opts.permissionMode;
    if (opts.maxTurns != null) args.maxTurns = Number(opts.maxTurns);
    if (Object.keys(args).length) step.args = args;
    let budget = null;
    if (opts.budgetUsd != null) {
      budget = { usd: Number(opts.budgetUsd) };
      if (opts.budgetPerRun) budget.perRun = true;
    }
    if (opts.budgetPerDay != null) budget = { ...(budget || {}), usdPerDay: Number(opts.budgetPerDay) };
    if (budget) step.budget = budget;
    return validateStep(withDeps(step, opts));
  }
  // A command step honors the `runner` axis too (DESIGN §11: a read-only/remote
  // command is a first-class runner target — e.g. a container build or a remote
  // deploy). Mirrors the ai branch; without it `add --runner docker:… "cmd"`
  // silently dropped the runner and ran on the host.
  const step = { type: 'command', run: opts.run ?? opts.task, status: 'pending' };
  if (opts.runner) step.runner = opts.runner;
  return validateStep(withDeps(step, opts));
}

// Lane-level axis settings a client may set alongside a step (DESIGN §7:
// isolation/land/base are per-lane, not per-step).
function applyLaneOpts(lane, laneOpts = {}) {
  if (laneOpts.isolation) lane.isolation = laneOpts.isolation;
  if (laneOpts.land) lane.land = laneOpts.land;
  if (laneOpts.base) lane.base = laneOpts.base;
  if (laneOpts.onEmpty) lane.onEmpty = laneOpts.onEmpty;
}

// Resolves where a newly-added step lands in lane.steps (DESIGN §15 "reorder,
// add"): `'end'`/undefined appends (the default), `'next'` inserts at the
// editable frontier so it fires on the very NEXT fire — ahead of a step
// already waiting at the cursor — and an integer inserts BEFORE that index.
// Never returns an index inside the frozen region (see editableFrontier): a
// step that already ran, or the live step whose result the executor writes
// back by index. An out-of-range `at` fails loudly rather than silently
// clamping to the end.
function resolveInsertIndex(repo, lane, at) {
  if (at == null || at === 'end') return lane.steps.length;
  const frontier = editableFrontier(repo, lane);
  if (at === 'next') return frontier;
  const idx = Number(at);
  if (!Number.isInteger(idx) || idx < frontier || idx > lane.steps.length) {
    throw new LaneValidationError(
      `taskherd: cannot insert into lane '${lane.name}' at ${JSON.stringify(at)} — `
      + `use 'next', 'end', or an index in ${frontier}..${lane.steps.length}`,
    );
  }
  return idx;
}

// Appends a step to a lane (creating the lane on first use), or — with
// `asDefault` — sets the lane's recurring default (DESIGN §6). `laneOpts.at`
// ('next' | 'end' | index) chooses where a queued step lands so a client can
// interpose one ahead of the pending cursor step instead of only appending
// (DESIGN §15). Shared by the CLI `add`/`block` and MCP `tasks_add`/`tasks_block`.
export async function addStep(repo, laneName, stepOpts, laneOpts = {}) {
  validateLaneName(laneName);
  const lane = (await laneExists(repo, laneName)) ? await loadLane(repo, laneName) : newLane(laneName);
  const step = buildStep(stepOpts);
  applyLaneOpts(lane, laneOpts);
  if (laneOpts.asDefault) {
    const { status: _transient, ...defaultStep } = step;
    lane.default = defaultStep;
    lane.onEmpty = 'default';
    await saveLane(repo, lane);
    return { lane, step: defaultStep, index: 'default' };
  }
  const at = resolveInsertIndex(repo, lane, laneOpts.at);
  lane.steps.splice(at, 0, step);
  await saveLane(repo, lane);
  return { lane, step, index: at };
}

// Queue editing (DESIGN §15 "reorder, add, edit, remove steps"). Only the
// still-pending future of the queue is editable: indices before the cursor are
// history, and while a step is live (its control socket exists) the step at
// the cursor is off-limits too — the executor patches its result back BY INDEX
// after the run (the M1.1 lost-update fix), so shifting or mutating it would
// corrupt that write-back. Blocked/failed steps go through `ack`, not editing.
export function laneIsRunning(repo, laneName) {
  return existsSync(runSocketLink(repo, laneName));
}

// The first index a client may touch: everything below is frozen. Steps before
// the cursor already ran; while the lane is live the cursor step is off-limits
// too — the executor patches its result back BY INDEX after the run (the M1.1
// lost-update fix), so shifting or mutating it would corrupt that write-back.
// Shared by the edit guards and the insert-position resolver so the boundary
// can't drift between them.
function editableFrontier(repo, lane) {
  return lane.cursor + (laneIsRunning(repo, lane.name) ? 1 : 0);
}

function assertEditableIndex(repo, lane, index, verb) {
  const min = editableFrontier(repo, lane);
  if (!Number.isInteger(index) || index < 0 || index >= lane.steps.length) {
    throw new LaneValidationError(`taskherd: lane '${lane.name}' has no step ${index}`);
  }
  if (index < min) {
    throw new LaneValidationError(
      `taskherd: cannot ${verb} step ${index} of lane '${lane.name}' — `
      + (index < lane.cursor ? 'it already ran' : 'it is running (or next); interrupt or ack instead'),
    );
  }
  if (lane.steps[index].status !== 'pending') {
    throw new LaneValidationError(
      `taskherd: cannot ${verb} step ${index} of lane '${lane.name}' (status ${lane.steps[index].status}) — clear it with ack`,
    );
  }
}

export async function removeStep(repo, laneName, index) {
  validateLaneName(laneName);
  const lane = await loadLane(repo, laneName);
  assertEditableIndex(repo, lane, index, 'remove');
  const [removed] = lane.steps.splice(index, 1);
  await saveLane(repo, lane);
  return { lane, removed };
}

export async function moveStep(repo, laneName, from, to) {
  validateLaneName(laneName);
  const lane = await loadLane(repo, laneName);
  assertEditableIndex(repo, lane, from, 'move');
  assertEditableIndex(repo, lane, to, 'move to');
  const [step] = lane.steps.splice(from, 1);
  lane.steps.splice(to, 0, step);
  await saveLane(repo, lane);
  return { lane, step };
}

// Patches fields onto a pending step and re-validates. Run-state fields can
// never ride in through a patch — status/attempts are the scheduler's.
export async function editStep(repo, laneName, index, patch = {}) {
  validateLaneName(laneName);
  const lane = await loadLane(repo, laneName);
  assertEditableIndex(repo, lane, index, 'edit');
  const {
    status: _s, attempts: _a, parkedReason: _p, ...fields
  } = patch;
  const step = { ...lane.steps[index], ...fields };
  // A patch may null a field out (e.g. switch task -> file prompt).
  for (const [k, v] of Object.entries(fields)) if (v === null) delete step[k];
  validateStep(step);
  lane.steps[index] = step;
  await saveLane(repo, lane);
  return { lane, step };
}

// Forks a sibling lane off a parent (DESIGN §18 `taskherd fork`, MCP
// `tasks_fork`, §17 "independent workstreams"): a NEW lane with `parent` set,
// running independently from creation. The parent must exist — forking off a
// typo must fail loudly, not scaffold an orphan. An initial step (or default)
// gives the fork something to do on its first fire.
export async function forkLane(repo, name, from, { stepOpts = null, laneOpts = {} } = {}) {
  validateLaneName(name);
  if (await laneExists(repo, name)) {
    throw new LaneValidationError(`taskherd: lane '${name}' already exists — fork needs a new lane name`);
  }
  if (!from) {
    throw new LaneValidationError('taskherd: fork needs a parent lane (--from <lane>)');
  }
  validateLaneName(from);
  if (!(await laneExists(repo, from))) {
    throw new LaneValidationError(`taskherd: parent lane '${from}' does not exist`);
  }
  const lane = newLane(name, { parent: from });
  applyLaneOpts(lane, laneOpts);
  if (stepOpts) {
    const step = buildStep(stepOpts);
    if (laneOpts.asDefault) {
      const { status: _transient, ...defaultStep } = step;
      lane.default = defaultStep;
      lane.onEmpty = 'default';
    } else {
      lane.steps.push(step);
    }
  }
  await saveLane(repo, lane);
  return lane;
}

async function ensureGlobalGitignore() {
  let excludesFile;
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', 'core.excludesFile']);
    excludesFile = stdout.trim();
  } catch {
    excludesFile = null;
  }
  if (!excludesFile) {
    excludesFile = path.join(os.homedir(), '.config', 'git', 'ignore');
    await execFileAsync('git', ['config', '--global', 'core.excludesFile', excludesFile]);
  }
  const resolved = excludesFile.replace(/^~/, os.homedir());
  await mkdir(path.dirname(resolved), { recursive: true });
  let existing = '';
  try {
    existing = await readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const lines = existing.split('\n');
  if (!lines.some((l) => l.trim() === '.tasks/')) {
    await appendFile(resolved, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}.tasks/\n`);
  }
}

export async function initTasksDir(repo, { globalGitignore = true } = {}) {
  const dir = repoTasksDir(repo);
  await mkdir(dir, { recursive: true });
  await mkdir(logsDir(repo), { recursive: true });
  await mkdir(descDir(repo), { recursive: true });
  await mkdir(runDir(repo), { recursive: true });
  await mkdir(taskherdHome(), { recursive: true });

  const cfgFile = projectConfigFile(repo);
  if (!existsSync(cfgFile)) {
    const defaultConfig = {
      default: null,
      profile: null,
      runner: 'local',
      // Safety-first (DESIGN §7, §12): a git repo gets worktree isolation by
      // default — autonomous edits land on taskherd/<lane>, never the user's
      // checkout. Where there's no repo to isolate, 'none'.
      isolation: (await isGitRepo(repo)) ? 'worktree' : 'none',
      land: 'manual-gate',
      budget: null,
      timeout: '45m',
      maxTurns: null,
    };
    await writeFile(cfgFile, `${JSON.stringify(defaultConfig, null, 2)}\n`);
  }

  if (globalGitignore) await ensureGlobalGitignore();

  // The web console aggregates registered projects (DESIGN §4 projects.json);
  // init is the natural registration point — `taskherd serve` also registers
  // its own repo so pre-M5 projects appear on first serve.
  await registerProject(repo);

  return dir;
}
