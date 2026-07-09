// Rules engine — the `when` precondition tree (DESIGN §23). Phase 1: pure
// `window` (time/date) + `dep` (== a waitsFor ref) leaves, all/any/not
// combinators, and the unified `evaluateGate` (waitsFor AND when). Phase 2: the
// impure `exit` probe (run a command, compare its code) with its safety envelope
// — fail-closed, timeout escalation, short-circuit, per-fire memoization, opt-in
// cache TTL. The scheduler integration lives at the bottom, using windows that
// are deterministically open/closed regardless of wall-clock so the assertions
// never flake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  windowSatisfied, windowNextOpen, parseWindow, parseWhen, evaluateWhen, evaluateGate,
  whenFromOpts, buildStep, newLane, saveLane, LaneValidationError,
  parseExitRule, exitCodeMatches, probeKey, resolveWhenProbes, describeWhen,
} from '../src/tasks.mjs';
import { executeExitProbe, createProbeSession } from '../src/probes.mjs';
import { pausedFile, needsAttentionFile, eventsFile } from '../src/paths.mjs';
import { tick } from '../src/scheduler.mjs';
import { makeRepo } from './helpers.mjs';
import { statusData } from '../src/history.mjs';

// A fixed local clock: Thu 2026-07-09 14:30 local.
const THU_1430 = new Date(2026, 6, 9, 14, 30);
// windowSatisfied/windowNextOpen take the NORMALIZED struct (as evaluateWhen
// feeds them) — parseWindow is that normalizer.
const parseWin = (w) => parseWindow(w);

test('window: after/before daytime window (inclusive after, exclusive before)', () => {
  const w = { after: '09:00', before: '17:00' };
  assert.equal(windowSatisfied(parseWin(w), new Date(2026, 6, 9, 9, 0)), true);   // exactly 09:00
  assert.equal(windowSatisfied(parseWin(w), new Date(2026, 6, 9, 14, 30)), true);
  assert.equal(windowSatisfied(parseWin(w), new Date(2026, 6, 9, 8, 59)), false);
  assert.equal(windowSatisfied(parseWin(w), new Date(2026, 6, 9, 17, 0)), false);  // 17:00 excluded
});

test('window: one-sided after / before', () => {
  assert.equal(windowSatisfied(parseWin({ after: '22:00' }), new Date(2026, 6, 9, 23, 0)), true);
  assert.equal(windowSatisfied(parseWin({ after: '22:00' }), new Date(2026, 6, 9, 21, 0)), false);
  assert.equal(windowSatisfied(parseWin({ before: '06:00' }), new Date(2026, 6, 9, 5, 0)), true);
  assert.equal(windowSatisfied(parseWin({ before: '06:00' }), new Date(2026, 6, 9, 7, 0)), false);
});

test('window: overnight wraparound (after > before)', () => {
  const w = parseWin({ after: '22:00', before: '06:00' });
  assert.equal(windowSatisfied(w, new Date(2026, 6, 9, 23, 30)), true);  // late evening
  assert.equal(windowSatisfied(w, new Date(2026, 6, 9, 2, 0)), true);    // small hours
  assert.equal(windowSatisfied(w, new Date(2026, 6, 9, 12, 0)), false);  // midday
});

test('window: days set with ranges and wrap', () => {
  const biz = parseWin({ days: 'Mon-Fri' });
  assert.equal(windowSatisfied(biz, new Date(2026, 6, 9, 12, 0)), true);   // Thu
  assert.equal(windowSatisfied(biz, new Date(2026, 6, 11, 12, 0)), false); // Sat
  const wknd = parseWin({ days: ['Sat', 'Sun'] });
  assert.equal(windowSatisfied(wknd, new Date(2026, 6, 11, 12, 0)), true); // Sat
  const wrap = parseWin({ days: 'Fri-Mon' });                              // Fri,Sat,Sun,Mon
  assert.equal(windowSatisfied(wrap, new Date(2026, 6, 8, 12, 0)), false); // Wed
  assert.equal(windowSatisfied(wrap, new Date(2026, 6, 13, 12, 0)), true); // Mon
});

test('window: absolute from/until range (until exclusive)', () => {
  const w = parseWin({ from: '2026-08-01', until: '2026-09-01' });
  assert.equal(windowSatisfied(w, new Date(2026, 7, 15)), true);   // mid-August
  assert.equal(windowSatisfied(w, new Date(2026, 6, 31)), false);  // before from
  assert.equal(windowSatisfied(w, new Date(2026, 8, 1)), false);   // Sep 1 excluded
});

test('window: tz local vs utc are honored, unknown tz throws', () => {
  // 23:30 UTC on the 9th. In a fixed-offset check we only assert utc math itself.
  const w = parseWin({ after: '12:00', tz: 'utc' });
  assert.equal(windowSatisfied(w, new Date(Date.UTC(2026, 6, 9, 13, 0))), true);
  assert.equal(windowSatisfied(w, new Date(Date.UTC(2026, 6, 9, 11, 0))), false);
  assert.throws(() => parseWin({ after: '09:00', tz: 'Pacific/Auckland' }), LaneValidationError);
});

test('windowNextOpen: computes the next opening instant for a business-hours window', () => {
  const w = parseWin({ after: '09:00', before: '17:00', days: 'Mon-Fri' });
  // Thu 08:00 → opens today 09:00.
  const a = windowNextOpen(w, new Date(2026, 6, 9, 8, 0));
  assert.equal(a.closed, false);
  assert.deepEqual([a.nextOpen.getFullYear(), a.nextOpen.getMonth(), a.nextOpen.getDate(), a.nextOpen.getHours()], [2026, 6, 9, 9]);
  // Fri 18:00 → skips the weekend, opens Mon 09:00.
  const b = windowNextOpen(w, new Date(2026, 6, 10, 18, 0));
  assert.equal(b.nextOpen.getDay(), 1); // Monday
  assert.equal(b.nextOpen.getHours(), 9);
});

test('windowNextOpen: a passed `until` reports closed with no next open', () => {
  const w = parseWin({ until: '2026-07-01' });
  const r = windowNextOpen(w, THU_1430);
  assert.equal(r.closed, true);
  assert.equal(r.nextOpen, null);
});

test('parseWhen: rejects unknown/not-yet-implemented rules and malformed trees', () => {
  assert.throws(() => parseWhen({ file: './x' }), /not implemented yet/);
  assert.throws(() => parseWhen({ http: { url: 'http://x' } }), /not implemented yet/);
  assert.throws(() => parseWhen({ nope: 1 }), /unknown `when` rule/);
  assert.throws(() => parseWhen({ all: [], any: [] }), /exactly one key/);
  assert.throws(() => parseWhen({ all: [] }), /non-empty array/);
  assert.throws(() => parseWhen({ window: {} }), /at least one of/);
  assert.throws(() => parseWhen({ window: { after: '9am' } }), /must be "HH:MM"/);
  assert.throws(() => parseWhen({ window: { days: 'Funday' } }), /unknown weekday/);
  // valid trees round-trip unchanged
  const ok = { all: [{ window: { days: 'Mon-Fri' } }, { not: { dep: 'build:U2' } }] };
  assert.deepEqual(parseWhen(ok), ok);
});

test('evaluateWhen: all / any / not combinators over window leaves', () => {
  const now = THU_1430; // Thu 14:30
  const ctx = { selfLane: 'main', lanesByName: {}, now };
  const open = { window: { after: '09:00', before: '17:00' } };
  const closed = { window: { after: '18:00', before: '20:00' } };
  assert.equal(evaluateWhen({ all: [open, { window: { days: 'Mon-Fri' } }] }, ctx).satisfied, true);
  assert.equal(evaluateWhen({ all: [open, closed] }, ctx).satisfied, false);
  assert.equal(evaluateWhen({ any: [closed, open] }, ctx).satisfied, true);
  assert.equal(evaluateWhen({ any: [closed, { window: { days: 'Sat' } }] }, ctx).satisfied, false);
  assert.equal(evaluateWhen({ not: closed }, ctx).satisfied, true);
  assert.equal(evaluateWhen({ not: open }, ctx).satisfied, false);
});

test('evaluateWhen: dep leaf mirrors a waitsFor ref', () => {
  const done = newLane('build');
  done.steps = [{ type: 'command', run: 'x', id: 'U2', status: 'done' }];
  done.cursor = 1;
  const pending = newLane('build2');
  pending.steps = [{ type: 'command', run: 'x', id: 'U2', status: 'pending' }];
  const ctx = { selfLane: 'main', lanesByName: { build: done, build2: pending }, now: THU_1430 };
  assert.equal(evaluateWhen({ dep: 'build:U2' }, ctx).satisfied, true);
  const r = evaluateWhen({ dep: 'build2:U2' }, ctx);
  assert.equal(r.satisfied, false);
  assert.equal(r.unmet[0].reason, 'step-pending');
});

test('evaluateGate: ANDs waitsFor and when; window unmet is flagged reason=window', () => {
  const build = newLane('build');
  build.steps = [{ type: 'command', run: 'x', id: 'U2', status: 'pending' }];
  const byName = { build };
  // waitsFor satisfied, window closed → gate closed with a window unmet.
  const step = { type: 'command', run: 'go', when: { window: { after: '18:00' } } };
  const g = evaluateGate(step, 'main', byName, new Date(2026, 6, 9, 14, 30));
  assert.equal(g.satisfied, false);
  assert.equal(g.unmet[0].reason, 'window');
  assert.match(g.unmet[0].ref, /window \(opens/);
  // window open + waitsFor unmet → gate closed with a dep unmet.
  const step2 = { type: 'command', run: 'go', waitsFor: ['build:U2'], when: { window: { after: '00:00' } } };
  const g2 = evaluateGate(step2, 'main', byName, THU_1430);
  assert.equal(g2.satisfied, false);
  assert.equal(g2.unmet[0].reason, 'step-pending');
});

test('whenFromOpts / buildStep: window convenience flags build a when rule; --when ANDs', () => {
  const s = buildStep({ type: 'command', task: 'x', after: '09:00', before: '17:00', days: 'Mon-Fri' });
  assert.deepEqual(s.when, { window: { after: '09:00', before: '17:00', days: 'Mon-Fri' } });
  // raw --when plus a window flag are ANDed together
  const both = whenFromOpts({ when: '{"dep":"build:U2"}', after: '09:00' });
  assert.deepEqual(both, { all: [{ dep: 'build:U2' }, { window: { after: '09:00' } }] });
  // a bad rule fails loudly at build time
  assert.throws(() => buildStep({ type: 'command', task: 'x', when: '{"http":{"url":"x"}}' }), /not implemented yet/);
  assert.equal(whenFromOpts({ type: 'command', task: 'x' }), null); // nothing specified
});

test('scheduler: a window-gated step soft-skips while closed, runs when open (DESIGN §23)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  // A window that can never be open now (starts in the year 2999) — deterministic.
  const closed = newLane('closed');
  closed.steps = [{ type: 'command', run: 'echo hi', status: 'pending', when: { window: { from: '2999-01-01' } } }];
  await saveLane(repo, closed);

  const r1 = await tick(repo);
  assert.equal(r1.outcome, 'idle', 'a closed-window lane must not run');
  // Soft skip: nothing persisted, step still pending, lane not blocked.
  const s1 = await statusData(repo);
  const lane1 = s1.lanes.find((l) => l.name === 'closed');
  assert.equal(lane1.status, 'waiting');
  assert.equal(lane1.steps[0].status, 'pending');
  assert.match(lane1.waiting[0], /window/);
  // The snapshot advertises the step's rule for the console `when` chip (§23):
  // raw `when` for a tooltip + a compact `whenLabel`.
  assert.deepEqual(lane1.steps[0].when, { window: { from: '2999-01-01' } });
  assert.equal(lane1.steps[0].whenLabel, 'window(from 2999-01-01)');

  // An always-open window (after 00:00 ⇒ min>=0 ⇒ always) runs immediately.
  const open = newLane('open');
  open.steps = [{ type: 'command', run: 'echo hi', status: 'pending', when: { window: { after: '00:00' } } }];
  await saveLane(repo, open);

  const r2 = await tick(repo, { lane: 'open' });
  assert.equal(r2.outcome, 'ran');
  assert.equal(r2.lane, 'open');

  // The closed lane is still just waiting — never surfaced as a stall/attention.
  const r3 = await tick(repo, { lane: 'closed' });
  assert.equal(r3.outcome, 'not-runnable');
  assert.match(r3.reason, /window opens|window/);
});

// ── Phase 2 — the `exit` probe ──────────────────────────────────────────────

test('parseExitRule / parseWhen: exit leaf shape is validated loudly at write time', () => {
  // valid forms round-trip unchanged through parseWhen
  const shellForm = { exit: { run: './scripts/ready.sh' } };
  assert.deepEqual(parseWhen(shellForm), shellForm);
  const argvForm = { exit: { argv: ['test', '-f', 'x'], in: [0, 1], timeout: '10s', cache: '5m' } };
  assert.deepEqual(parseWhen(argvForm), argvForm);
  // exactly one of run/argv
  assert.throws(() => parseExitRule({ run: 'x', argv: ['x'] }), /exactly one of/);
  assert.throws(() => parseExitRule({}), /exactly one of/);
  // one matcher only, integers only
  assert.throws(() => parseExitRule({ run: 'x', equals: 0, in: [1] }), /only one of equals\/in\/not/);
  assert.throws(() => parseExitRule({ run: 'x', equals: 'zero' }), /must be an integer/);
  assert.throws(() => parseExitRule({ run: 'x', in: [] }), /non-empty array of integer/);
  // durations and env fail loudly, never silently
  assert.throws(() => parseExitRule({ run: 'x', timeout: 'soon' }), /cannot parse duration/);
  assert.throws(() => parseExitRule({ run: 'x', cache: '-5m' }), /cannot parse duration/);
  assert.throws(() => parseExitRule({ run: 'x', env: { FOO: 1 } }), /must be a string/);
  // unknown fields are refused (a typo'd guardrail must not silently vanish)
  assert.throws(() => parseExitRule({ run: 'x', equal: 0 }), /unknown field/);
});

test('exitCodeMatches: equals(default 0)/in/not; null code NEVER matches (fail-closed)', () => {
  assert.equal(exitCodeMatches({ run: 'x' }, 0), true);
  assert.equal(exitCodeMatches({ run: 'x' }, 1), false);
  assert.equal(exitCodeMatches({ run: 'x', equals: 3 }, 3), true);
  assert.equal(exitCodeMatches({ run: 'x', in: [1, 2] }, 2), true);
  assert.equal(exitCodeMatches({ run: 'x', in: [1, 2] }, 0), false);
  assert.equal(exitCodeMatches({ run: 'x', not: 1 }, 0), true);
  assert.equal(exitCodeMatches({ run: 'x', not: 1 }, 1), false);
  // spawn error / timeout / signal all surface as code null → unsatisfied
  assert.equal(exitCodeMatches({ run: 'x' }, null), false);
  assert.equal(exitCodeMatches({ run: 'x', not: 1 }, null), false);
});

test('evaluateWhen: exit leaf reads ctx.probes; absent results fail closed (status never executes)', () => {
  const rule = { exit: { run: './ready.sh' } };
  const base = { selfLane: 'main', lanesByName: {}, now: THU_1430 };
  // no probe results at all — the read-only-surface case
  const dry = evaluateWhen(rule, base);
  assert.equal(dry.satisfied, false);
  assert.equal(dry.unmet[0].reason, 'probe');
  assert.match(dry.unmet[0].ref, /exit\(\.\/ready\.sh\) \(probed at fire time\)/);
  // a matching result satisfies; a non-matching one carries the code in the ref
  const key = probeKey(rule.exit);
  const okCtx = { ...base, probes: new Map([[key, { code: 0 }]]) };
  assert.equal(evaluateWhen(rule, okCtx).satisfied, true);
  const badCtx = { ...base, probes: new Map([[key, { code: 3 }]]) };
  const bad = evaluateWhen(rule, badCtx);
  assert.equal(bad.satisfied, false);
  assert.match(bad.unmet[0].ref, /exit 3/);
  const errCtx = { ...base, probes: new Map([[key, { code: null, error: 'spawn ENOENT' }]]) };
  assert.match(evaluateWhen(rule, errCtx).unmet[0].ref, /error: spawn ENOENT/);
  assert.equal(describeWhen(rule), 'exit(./ready.sh)');
});

test('resolveWhenProbes: a probe runs ONLY when the tree outcome depends on it (short-circuit)', async () => {
  const ctxOf = () => ({ selfLane: 'main', lanesByName: {}, now: THU_1430, probes: new Map() });
  let calls = 0;
  const passProbe = async () => { calls += 1; return { code: 0 }; };

  // all[closed-window, exit] — the free leg already fails; the probe must not run.
  calls = 0;
  const closedAll = { type: 'command', run: 'x', when: { all: [{ window: { from: '2999-01-01' } }, { exit: { run: 'true' } }] } };
  let ctx = ctxOf();
  await resolveWhenProbes(closedAll, ctx, passProbe);
  assert.equal(calls, 0, 'probe must be skipped when a pure leg already decides the AND');
  assert.equal(evaluateGate(closedAll, 'main', {}, THU_1430, ctx.probes).satisfied, false);

  // any[always-open-window, exit] — already satisfied; the probe must not run.
  calls = 0;
  const openAny = { type: 'command', run: 'x', when: { any: [{ window: { after: '00:00' } }, { exit: { run: 'false' } }] } };
  ctx = ctxOf();
  await resolveWhenProbes(openAny, ctx, passProbe);
  assert.equal(calls, 0, 'probe must be skipped when a pure leg already decides the OR');
  assert.equal(evaluateGate(openAny, 'main', {}, THU_1430, ctx.probes).satisfied, true);

  // unmet waitsFor — the gate is an AND, the probe cannot open it, so it never runs.
  calls = 0;
  const waits = { type: 'command', run: 'x', waitsFor: ['nolane:U1'], when: { exit: { run: 'true' } } };
  await resolveWhenProbes(waits, ctxOf(), passProbe);
  assert.equal(calls, 0, 'probe must be skipped while waitsFor is unmet');

  // a bare exit rule runs exactly once, memoized across steps sharing the spec.
  calls = 0;
  const bare = { type: 'command', run: 'x', when: { exit: { run: 'true' } } };
  ctx = ctxOf();
  await resolveWhenProbes(bare, ctx, passProbe);
  await resolveWhenProbes(bare, ctx, passProbe); // second step, same fire, same spec
  assert.equal(calls, 1, 'per-fire memoization: one execution per probe spec');
  assert.equal(evaluateGate(bare, 'main', {}, THU_1430, ctx.probes).satisfied, true);

  // not(exit) is undecided until the probe runs (3VL correctness under NOT):
  // the probe PASSES, so the negated gate is unsatisfied.
  calls = 0;
  const negated = { type: 'command', run: 'x', when: { not: { exit: { run: 'true' } } } };
  ctx = ctxOf();
  await resolveWhenProbes(negated, ctx, passProbe);
  assert.equal(calls, 1, 'a probe under not() must still run — its result decides the tree');
  assert.equal(evaluateGate(negated, 'main', {}, THU_1430, ctx.probes).satisfied, false);
});

test('executeExitProbe: real spawn — exit codes, argv form, env, cwd=repo, timeout escalation', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  // exit code propagates
  assert.equal((await executeExitProbe({ run: 'exit 3' }, { repo })).code, 3);
  // argv form (no shell)
  assert.equal((await executeExitProbe({ argv: ['true'] }, { repo })).code, 0);
  // env reaches the probe
  assert.equal((await executeExitProbe({ run: 'test "$FOO" = bar', env: { FOO: 'bar' } }, { repo })).code, 0);
  // cwd is the repo root (the step hasn't started; there may be no worktree)
  assert.equal((await executeExitProbe({ run: 'test -d .tasks' }, { repo })).code, 0);
  // timeout: SIGTERM lands, code is null (fail-closed), and it returns promptly
  const t0 = Date.now();
  const timedOut = await executeExitProbe({ run: 'sleep 30', timeout: '300ms' }, { repo });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.code, null);
  assert.ok(Date.now() - t0 < 10_000, 'timeout escalation must not hang the tick');
  // spawn error (argv target missing) is an error result, not a throw
  const enoent = await executeExitProbe({ argv: ['no-such-binary-xyz'] }, { repo });
  assert.equal(enoent.code, null);
  assert.ok(enoent.error, 'spawn failure must carry an error message');
});

test('createProbeSession: cache TTL reuses a recorded result across sessions; when.probe event emitted', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const counter = join(repo, 'probe-count');
  const cached = { run: `echo x >> ${counter}`, cache: '1h' };

  const s1 = await createProbeSession(repo);
  const r1 = await s1.run(cached, { lane: 'demo' });
  assert.equal(r1.code, 0);
  const r2 = await s1.run(cached, { lane: 'demo' }); // TTL fresh — reused, not re-run
  assert.equal(r2.code, 0);
  assert.equal((await readFile(counter, 'utf8')).trim(), 'x', 'TTL must reuse, not re-execute');
  await s1.flush();

  // A NEW session (next fire) still reuses the persisted result within the TTL.
  const s2 = await createProbeSession(repo);
  await s2.run(cached, { lane: 'demo' });
  assert.equal((await readFile(counter, 'utf8')).trim(), 'x', 'cache must persist across fires');

  // Without `cache`, every fire re-probes.
  const uncached = { run: `echo y >> ${counter}` };
  await s2.run(uncached, {});
  const s3 = await createProbeSession(repo);
  await s3.run(uncached, {});
  const lines = (await readFile(counter, 'utf8')).trim().split('\n');
  assert.deepEqual(lines, ['x', 'y', 'y'], 'an uncached probe runs once per fire');

  // Probes are code execution — every real run leaves a when.probe event trail.
  const events = (await readFile(eventsFile(repo), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const probeEvents = events.filter((e) => e.event === 'when.probe');
  assert.equal(probeEvents.length, 3, 'one event per real execution, none for cached reuse');
  assert.equal(probeEvents[0].lane, 'demo');
  assert.equal(probeEvents[0].code, 0);
  assert.equal(probeEvents[0].satisfied, true);
});

test('scheduler: an exit-probe-gated step soft-skips while failing, runs when passing; PAUSED never probes', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const flag = join(repo, 'ready-flag');

  const lane = newLane('probe');
  lane.steps = [{ type: 'command', run: 'echo hi', status: 'pending', when: { exit: { run: `test -f ${flag}` } } }];
  await saveLane(repo, lane);

  // Probe fails → soft skip: nothing persisted, no gate, no attention, no stall.
  const r1 = await tick(repo);
  assert.equal(r1.outcome, 'idle');
  const s1 = await statusData(repo);
  const l1 = s1.lanes.find((l) => l.name === 'probe');
  assert.equal(l1.status, 'waiting');
  assert.equal(l1.steps[0].status, 'pending');
  assert.match(l1.waiting[0], /^exit\(/);
  assert.match(l1.steps[0].whenLabel, /^exit\(test -f /); // the console ⏰ chip label (truncated if long)
  assert.equal(existsSync(needsAttentionFile(repo)), false, 'a probe wait is not an attention item (v1 soft)');
  const ev1 = (await readFile(eventsFile(repo), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ev1.some((e) => e.event === 'waitsFor.stalled' || e.event === 'waitsFor.deadlock'), false);
  assert.equal(ev1.filter((e) => e.event === 'when.probe').length, 1);

  // A targeted run explains the wait in probe terms.
  const r2 = await tick(repo, { lane: 'probe' });
  assert.equal(r2.outcome, 'not-runnable');
  assert.match(r2.reason, /probe passes/);

  // The world changes → the very next fire runs the step.
  await writeFile(flag, '');
  const r3 = await tick(repo);
  assert.equal(r3.outcome, 'ran');
  assert.equal(r3.lane, 'probe');

  // PAUSED suppresses probing entirely — the probe command must not execute.
  const counter = join(repo, 'paused-count');
  const paused = newLane('paused-probe');
  paused.steps = [{ type: 'command', run: 'echo hi', status: 'pending', when: { exit: { run: `echo x >> ${counter}` } } }];
  await saveLane(repo, paused);
  await writeFile(pausedFile(repo), '');
  const r4 = await tick(repo);
  assert.equal(r4.outcome, 'paused');
  assert.equal(existsSync(counter), false, 'a paused repo must never be probed');
});

test('scheduler: two lanes sharing one probe spec cost a single execution per fire', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const counter = join(repo, 'shared-count');
  const when = { exit: { run: `echo x >> ${counter}; exit 1` } };
  for (const name of ['a', 'b']) {
    const lane = newLane(name);
    lane.steps = [{ type: 'command', run: 'echo hi', status: 'pending', when }];
    await saveLane(repo, lane);
  }
  const r = await tick(repo);
  assert.equal(r.outcome, 'idle'); // both probes report exit 1 → both wait
  assert.equal((await readFile(counter, 'utf8')).trim(), 'x', 'per-fire memoization spans lanes');
});
