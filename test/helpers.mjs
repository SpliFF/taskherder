// Shared test setup: an isolated repo + TASKHERD_HOME per test so nothing
// touches the real machine's ~/.taskherd or global git config.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initTasksDir } from '../src/tasks.mjs';

// Poll until `cond()` is truthy (or throw after `timeout`). Used to wait for a
// run's control socket to appear before attaching in a test.
export async function waitFor(cond, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: condition never became true');
    await new Promise((r) => { setTimeout(r, interval); });
  }
}

export async function makeRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'taskherd-repo-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'taskherd-home-'));
  process.env.TASKHERD_HOME = home;
  await initTasksDir(repo, { globalGitignore: false });
  return {
    repo,
    home,
    async cleanup() {
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}
