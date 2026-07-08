// Post-run log viewer (DESIGN §15 Layer 2, monitor follow-up). The executor
// persists every step's pty output to `.tasks/logs/<lane>-<ISO-ts>.log`
// (executor.mjs). While a step runs, the control socket streams it live (attach /
// the console term panel); once it exits the socket is gone and the log FILE is
// the only record. This module reads those files back — the historical half of
// "monitor a run, incl. one this process didn't start". Read-only; the CLI
// `taskherd logs`, the serve `/logs`+`/log` endpoints, and the console LOG button
// are all thin clients of it, and all render stream-json through src/render.mjs.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { logsDir } from './paths.mjs';
import { validateLaneName, LaneValidationError } from './tasks.mjs';

// Logs can get large for a chatty ai step (stream-json emits an event per token
// delta). Cap what we hand a client; the HEAD is kept so the stream-json renderer
// sniffs cleanly from the first event, and truncation is always flagged.
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// Files are named `<lane>-<ts>.log`. A lane name is already restricted to
// `[A-Za-z0-9][A-Za-z0-9._-]*` (validateLaneName), so the prefix is a safe,
// non-traversing token; we only ever accept a bare filename that starts with it.
function assertLogName(lane, file) {
  if (typeof file !== 'string' || !file) throw new LaneValidationError("missing 'file'");
  if (file !== path.basename(file) || file.includes('\0')) {
    throw new LaneValidationError(`invalid log file name '${file}'`); // no separators / traversal / NUL
  }
  if (!file.startsWith(`${lane}-`) || !file.endsWith('.log')) {
    throw new LaneValidationError(`log file '${file}' does not belong to lane '${lane}'`);
  }
}

// List a lane's persisted logs, newest first: `{ file, bytes, mtime }`.
export async function listLaneLogs(repo, lane) {
  validateLaneName(lane);
  const dir = logsDir(repo);
  let names;
  try { names = await readdir(dir); } catch { return []; } // no logs dir yet ⇒ none
  const prefix = `${lane}-`;
  const out = [];
  for (const file of names) {
    if (!file.startsWith(prefix) || !file.endsWith('.log')) continue;
    // eslint-disable-next-line no-await-in-loop
    const st = await stat(path.join(dir, file)).catch(() => null);
    if (st && st.isFile()) out.push({ file, bytes: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Read one log file's raw text, path-validated + capped. `file` must be a bare
// filename belonging to `lane`. Returns `{ file, exists:false }` if it's gone.
export async function readLaneLog(repo, lane, file, { maxBytes = LOG_MAX_BYTES } = {}) {
  validateLaneName(lane);
  assertLogName(lane, file);
  const dir = logsDir(repo);
  const full = path.join(dir, file);
  // Belt-and-suspenders: the resolved path must stay inside the logs dir.
  const rel = path.relative(dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new LaneValidationError('log path escapes the logs directory');
  }
  let buf;
  try { buf = await readFile(full); } catch { return { file, exists: false }; }
  const bytes = buf.length;
  const truncated = bytes > maxBytes;
  // Keep the HEAD so stream-json sniffs from event 1; flag the drop, never silent.
  const text = (truncated ? buf.subarray(0, maxBytes) : buf).toString('utf8');
  return { file, exists: true, bytes, truncated, text };
}

// Convenience for "just show me the last run": the newest log, read. Returns
// `{ exists:false }` when the lane has no logs at all.
export async function readLatestLaneLog(repo, lane, opts = {}) {
  const [latest] = await listLaneLogs(repo, lane);
  if (!latest) return { exists: false };
  return readLaneLog(repo, lane, latest.file, opts);
}
