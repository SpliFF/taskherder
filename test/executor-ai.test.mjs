import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runStep } from '../src/executor.mjs';
import { newLane } from '../src/tasks.mjs';
import { profileDir, profileFile, descDir } from '../src/paths.mjs';
import { makeRepo, installFakeClaude } from './helpers.mjs';

// A fake `claude` that echoes its argv + an env marker, then prints a
// claude-style cost-JSON result — enough to exercise cost parsing, profile-env
// isolation, and file-as-prompt without a real claude run.
const FAKE = `#!/bin/sh
echo "ARGS:$*"
printf 'ENVMARK=%s\\n' "$THPROOF"
echo '{"type":"result","total_cost_usd":0.0123,"session_id":"sess-xyz","usage":{"input_tokens":10,"output_tokens":5}}'
`;

async function writeProfile(name, profile) {
  await mkdir(profileDir(name), { recursive: true });
  await writeFile(profileFile(name), JSON.stringify(profile));
}

test('runStep(ai): parses cost, tokens and session id from the provider JSON', async (t) => {
  const { repo, home, cleanup } = await makeRepo();
  t.after(cleanup);
  await installFakeClaude(home, FAKE);

  const lane = newLane('work');
  const result = await runStep(repo, lane, { type: 'ai', task: '/work' }, 0, { provider: 'claude', timeout: '10s' });

  assert.equal(result.status, 'done');
  assert.equal(result.cost, 0.0123);
  assert.equal(result.sessionId, 'sess-xyz');
  assert.deepEqual(result.tokens, { input: 10, output: 5 });
});

test('runStep(ai): the profile env reaches the child (auth isolation, DESIGN §9)', async (t) => {
  const { repo, home, cleanup } = await makeRepo();
  t.after(cleanup);
  await installFakeClaude(home, FAKE);
  await writeProfile('work', { provider: 'claude', env: { THPROOF: 'isolated-42' } });

  const lane = newLane('work');
  const result = await runStep(repo, lane, { type: 'ai', task: '/work' }, 0, { provider: 'claude', profile: 'work', timeout: '10s' });

  const log = await readFile(result.logPath, 'utf8');
  assert.match(log, /ENVMARK=isolated-42/, 'the profile env var was exported into the spawn');
});

test('runStep(ai): file-as-prompt passes the file contents as the prompt (DESIGN §5)', async (t) => {
  const { repo, home, cleanup } = await makeRepo();
  t.after(cleanup);
  await installFakeClaude(home, FAKE);
  await mkdir(descDir(repo), { recursive: true });
  await writeFile(`${descDir(repo)}/p.md`, 'PROMPT-MARKER-77');

  const lane = newLane('work');
  const result = await runStep(repo, lane, { type: 'ai', file: 'desc/p.md' }, 0, { provider: 'claude', timeout: '10s' });

  const log = await readFile(result.logPath, 'utf8');
  assert.match(log, /PROMPT-MARKER-77/, 'the file contents became the -p prompt');
});

test('runStep(ai): an unknown provider is a setup error (rejects; scheduler catches)', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const lane = newLane('work');
  await assert.rejects(
    () => runStep(repo, lane, { type: 'ai', task: '/work' }, 0, { provider: 'nope', timeout: '10s' }),
    /unknown provider/,
  );
});
