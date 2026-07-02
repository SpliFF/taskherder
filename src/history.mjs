// history.jsonl audit trail + the `status` renderer (DESIGN.md §5, §13).
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { historyFile } from './paths.mjs';
import { loadAllLanes } from './tasks.mjs';

export async function appendHistory(repo, record) {
  await appendFile(historyFile(repo), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

export async function readHistory(repo) {
  const file = historyFile(repo);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function renderStatus(repo) {
  const lanes = await loadAllLanes(repo);
  const history = await readHistory(repo);
  if (lanes.length === 0) return 'no lanes yet — `taskherd add <lane> "<task>"` to create one';

  const lines = [];
  for (const lane of lanes) {
    const total = lane.steps.length;
    const last = [...history].reverse().find((h) => h.lane === lane.name);
    const lastResult = last ? `${last.result}${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}` : 'never run';
    lines.push(`${lane.name}  [${lane.cursor}/${total}]  ${lane.status}  last: ${lastResult}`);
    if (lane.status === 'blocked' && lane.steps[lane.cursor]) {
      const step = lane.steps[lane.cursor];
      const reason = step.type === 'manual' ? step.message : (step.parkedReason || 'failed, parked for review');
      lines.push(`  gate: ${reason}`);
    }
  }
  return lines.join('\n');
}
