// history.jsonl audit trail + the `status` renderer (DESIGN.md §5, §13).
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { historyFile, runSocketLink } from './paths.mjs';
import { loadAllLanesResilient } from './tasks.mjs';

export async function appendHistory(repo, record) {
  await appendFile(historyFile(repo), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

export async function readHistory(repo) {
  const file = historyFile(repo);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function lastResultLabel(last) {
  if (!last) return 'never run';
  if (last.timedOut) return 'failed (timed out)';
  if (last.signal) return `failed (signal ${last.signal})`;
  return `${last.result}${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}`;
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(4)}`;
}

// Structured status — one source for the CLI renderer below and the serve
// API (DESIGN §3: CLI and console are both just clients of the files).
export async function statusData(repo) {
  const { lanes, unloadable } = await loadAllLanesResilient(repo);
  const history = await readHistory(repo);

  // Running cost totals (DESIGN §10).
  const spentByLane = {};
  let totalSpent = 0;
  for (const rec of history) {
    if (typeof rec.cost !== 'number') continue;
    spentByLane[rec.lane] = (spentByLane[rec.lane] || 0) + rec.cost;
    totalSpent += rec.cost;
  }

  const out = lanes.map((lane) => {
    const last = [...history].reverse().find((h) => h.lane === lane.name);
    // Lane files aren't rewritten mid-run; a live control socket is the signal
    // that this lane's step is executing right now (DESIGN §13).
    const running = existsSync(runSocketLink(repo, lane.name));
    let gate = null;
    if (lane.status === 'blocked') {
      const step = lane.steps[lane.cursor];
      gate = step
        ? (step.type === 'manual' ? step.message : (step.parkedReason || 'failed, parked for review'))
        : (lane.budgetBlock || 'blocked');
    }
    return {
      name: lane.name,
      parent: lane.parent || null,
      cursor: lane.cursor,
      status: running ? 'running' : lane.status,
      running,
      gate,
      onEmpty: lane.onEmpty || null,
      default: lane.default || null,
      steps: (lane.steps || []).map((s) => ({
        type: s.type,
        status: s.status,
        summary: s.type === 'manual' ? s.message : (s.task || s.run || s.file || (s.argv || []).join(' ') || ''),
        ...(s.parkedReason ? { parkedReason: s.parkedReason } : {}),
        ...(s.land ? { land: s.land } : {}),
      })),
      last: last ? { result: lastResultLabel(last), ts: last.ts } : null,
      spent: spentByLane[lane.name] || 0,
    };
  });
  return { lanes: out, unloadable, totalSpent };
}

export async function renderStatus(repo) {
  const { lanes, unloadable, totalSpent } = await statusData(repo);
  if (lanes.length === 0 && unloadable.length === 0) {
    return 'no lanes yet — `taskherd add <lane> "<task>"` to create one';
  }

  const lines = [];
  for (const lane of lanes) {
    const spent = lane.spent ? `  spent: ${fmtUsd(lane.spent)}` : '';
    lines.push(`${lane.name}  [${lane.cursor}/${lane.steps.length}]  ${lane.status}  last: ${lane.last ? lane.last.result : 'never run'}${spent}`);
    if (lane.gate) lines.push(`  gate: ${lane.gate}`);
  }
  for (const bad of unloadable) {
    lines.push(`${bad.name}  [unloadable]  ${bad.error}`);
  }
  if (totalSpent > 0) lines.push(`total spent: ${fmtUsd(totalSpent)}`);
  return lines.join('\n');
}
