// Budget enforcement (DESIGN.md §10). Cost is only known *after* a run, so
// budgets are enforced against recorded spend in history.jsonl. Only `ai` steps
// carry cost, so budgets gate only them.
//
// Three windows, distinguished by how they clear:
//  - budget.usdPerDay  — daily cap. A day already at the cap SOFT-skips the lane
//    this tick (not persisted); it becomes runnable again once the day rolls.
//  - budget.usd (cumulative, the default) — lifetime lane cap. Once met it is a
//    persistent gate: the lane blocks until acked (or the cap is raised).
//  - budget.usd with perRun:true — a per-run ceiling. Can't be predicted, so it
//    is checked AFTER the run and blocks the lane if that one run overspent.

// Sum recorded cost from history for a lane (optionally since an ISO timestamp).
export function sumSpend(history, { lane, since } = {}) {
  let total = 0;
  for (const rec of history) {
    if (lane && rec.lane !== lane) continue;
    if (since && (!rec.ts || rec.ts < since)) continue;
    if (typeof rec.cost === 'number') total += rec.cost;
  }
  return total;
}

// Start of the UTC day containing nowIso, as an ISO timestamp.
export function startOfDay(nowIso) {
  return `${String(nowIso).slice(0, 10)}T00:00:00.000Z`;
}

function fmt(n) {
  return `$${Number(n).toFixed(4)}`;
}

// Daily cap — soft. Returns a reason string if today's spend already meets the
// cap, else null.
export function checkDailyBudget(budget, history, laneName, nowIso) {
  if (!budget || budget.usdPerDay == null) return null;
  const today = sumSpend(history, { lane: laneName, since: startOfDay(nowIso) });
  if (today >= budget.usdPerDay) {
    return `over daily budget: ${fmt(today)} spent today ≥ ${fmt(budget.usdPerDay)} cap`;
  }
  return null;
}

// Cumulative lifetime cap — persistent gate. Returns a reason or null. `perRun`
// budgets are handled post-run, not here.
export function checkCumulativeBudget(budget, history, laneName) {
  if (!budget || budget.usd == null || budget.perRun) return null;
  const total = sumSpend(history, { lane: laneName });
  if (total >= budget.usd) {
    return `budget exhausted: ${fmt(total)} spent ≥ ${fmt(budget.usd)} cap`;
  }
  return null;
}

// Per-run ceiling — checked after a run completes with a known cost. Returns a
// reason or null.
export function checkPerRunBudget(budget, runCost) {
  if (!budget || !budget.perRun || budget.usd == null || runCost == null) return null;
  if (runCost > budget.usd) {
    return `run cost ${fmt(runCost)} exceeded per-run budget ${fmt(budget.usd)}`;
  }
  return null;
}
