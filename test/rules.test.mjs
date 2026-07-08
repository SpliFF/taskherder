// Rules engine — the `when` precondition tree (DESIGN §23). Phase 1: pure
// `window` (time/date) + `dep` (== a waitsFor ref) leaves, all/any/not
// combinators, and the unified `evaluateGate` (waitsFor AND when). The scheduler
// integration lives at the bottom, using windows that are deterministically
// open/closed regardless of wall-clock so the assertions never flake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowSatisfied, windowNextOpen, parseWindow, parseWhen, evaluateWhen, evaluateGate,
  whenFromOpts, buildStep, newLane, saveLane, LaneValidationError,
} from '../src/tasks.mjs';
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
  assert.throws(() => parseWhen({ exit: { run: './x.sh' } }), /not implemented yet/);
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
  assert.throws(() => buildStep({ type: 'command', task: 'x', when: '{"exit":{"run":"x"}}' }), /not implemented yet/);
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
