// Shared test setup: an isolated repo + TASKHERD_HOME per test so nothing
// touches the real machine's ~/.taskherd or global git config.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initTasksDir } from '../src/tasks.mjs';

const execFileAsync = promisify(execFile);

export async function gitIn(repo, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args]);
  return stdout.trim();
}

// Installs a fake `claude` provider in the test's TASKHERD_HOME: a shell script
// standing in for the real CLI, plus a providers.json pointing the claude
// provider's command at it. `scriptBody` is a POSIX shell script; typically it
// prints a claude-style cost-JSON result so cost logging can be exercised
// without a real (paid, authed, slow) claude run.
export async function installFakeClaude(home, scriptBody) {
  const bin = path.join(home, 'fake-claude.sh');
  await writeFile(bin, scriptBody);
  chmodSync(bin, 0o755);
  await writeFile(path.join(home, 'providers.json'), `${JSON.stringify({ claude: { command: bin } }, null, 2)}\n`);
  return bin;
}

// A cost-JSON result line the way `claude -p --output-format json` prints it.
export function claudeResultJson({ cost = 0.01, sessionId = 'sess-abc', input = 100, output = 50 } = {}) {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, total_cost_usd: cost, usage: { input_tokens: input, output_tokens: output },
  });
}

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

// A real git repo (seed commit on `main`, repo-local identity so nothing
// depends on the machine's global config) with .tasks/ initialized AFTER
// `git init`, so the scaffolded config gets the git-repo isolation default.
export async function makeGitRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'taskherd-git-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'taskherd-home-'));
  process.env.TASKHERD_HOME = home;
  await gitIn(repo, 'init', '-b', 'main');
  await gitIn(repo, 'config', 'user.email', 'taskherd@test');
  await gitIn(repo, 'config', 'user.name', 'taskherd test');
  await writeFile(path.join(repo, 'README.md'), 'seed\n');
  await gitIn(repo, 'add', 'README.md');
  await gitIn(repo, 'commit', '-m', 'seed');
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
