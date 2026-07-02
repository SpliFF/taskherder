import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadProfile, profileEnv, listProfiles, isolationWarnings,
} from '../src/profiles.mjs';
import { profileFile, profileDir } from '../src/paths.mjs';

async function withHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'th-home-'));
  const prev = process.env.TASKHERD_HOME;
  process.env.TASKHERD_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.TASKHERD_HOME;
    else process.env.TASKHERD_HOME = prev;
    return rm(home, { recursive: true, force: true });
  });
  return home;
}

async function writeProfile(name, profile) {
  await mkdir(profileDir(name), { recursive: true });
  await writeFile(profileFile(name), JSON.stringify(profile));
}

test('loadProfile + profileEnv: reads env and expands ~', async (t) => {
  await withHome(t);
  await writeProfile('work', { provider: 'claude', env: { CLAUDE_CONFIG_DIR: '~/wk/claude', X: 'literal' } });
  const profile = await loadProfile('work');
  const env = profileEnv(profile);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), 'wk/claude'), '~ expands to homedir');
  assert.equal(env.X, 'literal');
});

test('loadProfile: a missing profile errors loudly with the login hint', async (t) => {
  await withHome(t);
  await assert.rejects(() => loadProfile('ghost'), /no profile "ghost".*auth login/s);
});

test('listProfiles: lists profile directories', async (t) => {
  await withHome(t);
  await writeProfile('work', { provider: 'claude' });
  await writeProfile('personal', { provider: 'claude' });
  assert.deepEqual(listProfiles(), ['personal', 'work']);
});

test('isolationWarnings: an ANTHROPIC_API_KEY profile is fully isolated (no warning)', () => {
  assert.deepEqual(isolationWarnings({ env: { ANTHROPIC_API_KEY: 'sk-x' } }), []);
});

test('isolationWarnings: no auth env at all → warns it does not isolate', () => {
  const w = isolationWarnings({ env: {} });
  assert.equal(w.length, 1);
  assert.match(w[0], /does NOT isolate/);
});

test('isolationWarnings: on macOS a CLAUDE_CONFIG_DIR-only profile warns about the keychain (DESIGN §9)', () => {
  const w = isolationWarnings({ env: { CLAUDE_CONFIG_DIR: '/x' } });
  if (process.platform === 'darwin') {
    assert.equal(w.length, 1);
    assert.match(w[0], /keychain/);
  } else {
    assert.deepEqual(w, [], 'the keychain caveat is macOS-specific');
  }
});
