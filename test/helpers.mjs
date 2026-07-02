// Shared test setup: an isolated repo + TASKHERD_HOME per test so nothing
// touches the real machine's ~/.taskherd or global git config.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initTasksDir } from '../src/tasks.mjs';

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
