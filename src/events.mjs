// The structured event stream (DESIGN.md §13). Lifecycle events only —
// `run.start`, `gate.blocked`, `run.exit`, `land.*`. Raw pty `output` is
// deliberately NOT persisted here (unbounded growth); the per-run log file plus
// the executor's in-memory ring buffer serve live/late attach instead.
import { appendFile } from 'node:fs/promises';
import { eventsFile } from './paths.mjs';
import { notifyGateBlocked } from './notify.mjs';

export async function appendEvent(repo, event) {
  await appendFile(eventsFile(repo), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  // Every pending→blocked transition emits here exactly once, which makes this
  // the §6 "notify once" point for the §14 os channel.
  if (event.event === 'gate.blocked') await notifyGateBlocked(repo, event);
}
