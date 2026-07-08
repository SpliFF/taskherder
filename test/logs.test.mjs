import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listLaneLogs, readLaneLog, readLatestLaneLog } from '../src/logs.mjs';
import { logsDir } from '../src/paths.mjs';
import { LaneValidationError } from '../src/tasks.mjs';
import { makeRepo } from './helpers.mjs';

// Seed a log file for `lane` at timestamp `ts` (ISO with :/. already replaced).
async function seedLog(repo, lane, ts, body) {
  const dir = logsDir(repo);
  await mkdir(dir, { recursive: true });
  const file = `${lane}-${ts}.log`;
  await writeFile(path.join(dir, file), body);
  return file;
}

test('listLaneLogs: returns a lane\'s logs newest-first, ignoring other lanes', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await seedLog(repo, 'web', '2026-07-09T10-00-00-000Z', 'old');
  await new Promise((r) => { setTimeout(r, 5); });
  await seedLog(repo, 'web', '2026-07-09T11-00-00-000Z', 'new');
  await seedLog(repo, 'api', '2026-07-09T12-00-00-000Z', 'other lane');

  const logs = await listLaneLogs(repo, 'web');
  assert.equal(logs.length, 2, 'only web\'s logs');
  assert.match(logs[0].file, /11-00-00/, 'newest first');
  assert.match(logs[1].file, /10-00-00/);
  assert.equal(typeof logs[0].bytes, 'number');
});

test('listLaneLogs: no logs dir yet ⇒ empty list, not a throw', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  assert.deepEqual(await listLaneLogs(repo, 'fresh'), []);
});

test('readLaneLog: reads a named log; readLatestLaneLog picks the newest', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const f1 = await seedLog(repo, 'web', '2026-07-09T10-00-00-000Z', 'first run');
  await new Promise((r) => { setTimeout(r, 5); });
  await seedLog(repo, 'web', '2026-07-09T11-00-00-000Z', 'second run');

  const one = await readLaneLog(repo, 'web', f1);
  assert.equal(one.exists, true);
  assert.equal(one.text, 'first run');
  assert.equal(one.truncated, false);

  const latest = await readLatestLaneLog(repo, 'web');
  assert.equal(latest.text, 'second run');
});

test('readLaneLog: caps a large file at maxBytes and flags truncation (HEAD kept)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const f = await seedLog(repo, 'web', '2026-07-09T10-00-00-000Z', `HEAD${'x'.repeat(5000)}`);
  const log = await readLaneLog(repo, 'web', f, { maxBytes: 100 });
  assert.equal(log.truncated, true);
  assert.equal(log.bytes, 5004);
  assert.equal(log.text.length, 100);
  assert.match(log.text, /^HEAD/, 'the head is kept so stream-json sniffs from event 1');
});

test('readLaneLog: a missing file resolves to exists:false, not a throw', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const log = await readLaneLog(repo, 'web', 'web-2026-01-01T00-00-00-000Z.log');
  assert.equal(log.exists, false);
});

test('readLaneLog: rejects path traversal and cross-lane / non-log names (no read escape)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await assert.rejects(() => readLaneLog(repo, 'web', '../../../etc/passwd'), LaneValidationError);
  await assert.rejects(() => readLaneLog(repo, 'web', 'web/../../secret.log'), LaneValidationError);
  await assert.rejects(() => readLaneLog(repo, 'web', 'other-lane-ts.log'), LaneValidationError); // wrong lane prefix
  await assert.rejects(() => readLaneLog(repo, 'web', 'web-ts.txt'), LaneValidationError); // not a .log
  await assert.rejects(() => readLaneLog(repo, 'web', ''), LaneValidationError); // empty
  await assert.rejects(() => readLaneLog(repo, '../evil', 'x.log'), LaneValidationError); // bad lane name
});
