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
  return `${last.result}${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}`;
}

export async function renderStatus(repo) {
  const { lanes, unloadable } = await loadAllLanesResilient(repo);
  const history = await readHistory(repo);
  if (lanes.length === 0 && unloadable.length === 0) {
    return 'no lanes yet — `taskherd add <lane> "<task>"` to create one';
  }

  const lines = [];
  for (const lane of lanes) {
    const total = lane.steps.length;
    const last = [...history].reverse().find((h) => h.lane === lane.name);
    // Lane files aren't rewritten mid-run; a live control socket is the signal
    // that this lane's step is executing right now (DESIGN §13).
    const running = existsSync(runSocketLink(repo, lane.name));
    const state = running ? 'running' : lane.status;
    lines.push(`${lane.name}  [${lane.cursor}/${total}]  ${state}  last: ${lastResultLabel(last)}`);
    if (lane.status === 'blocked' && lane.steps[lane.cursor]) {
      const step = lane.steps[lane.cursor];
      const reason = step.type === 'manual' ? step.message : (step.parkedReason || 'failed, parked for review');
      lines.push(`  gate: ${reason}`);
    }
  }
  for (const bad of unloadable) {
    lines.push(`${bad.name}  [unloadable]  ${bad.error}`);
  }
  return lines.join('\n');
}
