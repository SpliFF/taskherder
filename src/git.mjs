// Git integration (DESIGN.md §7): worktree/inplace isolation on
// `taskherd/<lane>` branches, land policies (manual-gate / pr / leave), and the
// worktree pool + gc. All plain `git` subprocesses — no dependency.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { worktreeDir, wtRepoDir, laneFile } from './paths.mjs';

const execFileAsync = promisify(execFile);

// Wraps stderr into the thrown message so a failed git op reads as the actual
// git error, not a generic child_process exit status.
async function git(cwd, ...args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
    return stdout.trim();
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim().split('\n')[0];
    throw new Error(`git ${args.join(' ')}: ${detail}`);
  }
}

// Like git() but returns stdout verbatim (no trim) with a large buffer — for
// diff output, where whitespace is meaningful and the default 1MB execFile cap
// would throw on a big change set.
async function gitRaw(cwd, ...args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim().split('\n')[0];
    throw new Error(`git ${args.join(' ')}: ${detail}`);
  }
}

export async function isGitRepo(repo) {
  try {
    await execFileAsync('git', ['-C', repo, 'rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

// A `base` ref is caller/agent-controlled (lane config, serve `?base=`, CLI
// `--base`) and reaches git as a bare positional revision argument. A value
// starting with `-` would be parsed as an OPTION — e.g. `--output=<file>` on
// `git diff` writes the diff to an attacker-chosen path (an arbitrary-write
// primitive), and this runs in the un-token-gated scheduler. Reject a leading
// dash (never a legitimate ref); callers also pass `--end-of-options` as a
// second layer. Branch names are always `taskherd/`-prefixed, hence safe.
function assertSafeBase(base) {
  if (typeof base !== 'string' || base === '' || base.startsWith('-')) {
    throw new Error(
      `taskherd: unsafe base ref ${JSON.stringify(base)} — must be a non-empty ref that does not start with '-' (§7/§12)`,
    );
  }
  return base;
}

export function laneBranch(laneName) {
  return `taskherd/${laneName}`;
}

// The branch the main checkout is on, or null when HEAD is detached.
export async function currentBranch(repo) {
  try {
    return await git(repo, 'symbolic-ref', '--short', 'HEAD');
  } catch {
    return null;
  }
}

// The fork/land base when config doesn't name one (DESIGN §7: "default =
// the repo's default-branch tip"): origin's default branch if a remote defines
// one, else whatever the main checkout is on.
export async function defaultBase(repo) {
  try {
    const ref = await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    return ref.replace(/^origin\//, '');
  } catch {
    // no remote HEAD — local-only repo
  }
  const cur = await currentBranch(repo);
  if (cur) return cur;
  throw new Error(
    `taskherd: cannot determine a base branch for ${repo} (detached HEAD, no origin/HEAD) — set "base" in .tasks/config.json`,
  );
}

export async function branchExists(repo, branch) {
  try {
    await execFileAsync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// The base recorded when the lane branch was created. Land-time resolution
// must not re-derive the base from the current checkout — inplace isolation
// switches the checkout to the lane branch itself, which would make
// `defaultBase` circular.
export async function branchBase(repo, branch) {
  try {
    return await git(repo, 'config', `branch.${branch}.taskherdbase`);
  } catch {
    return null;
  }
}

async function ensureBranch(repo, branch, base) {
  assertSafeBase(base);
  if (await branchExists(repo, branch)) return;
  await git(repo, 'branch', branch, base);
  await git(repo, 'config', `branch.${branch}.taskherdbase`, base);
}

// Worktree isolation (§7): ~/.taskherd/wt/<repo-id>/<lane> on taskherd/<lane>,
// forked from base. The pool: an existing valid worktree is reused across
// fires; a registration whose directory was deleted by hand is pruned and the
// worktree re-added. A directory that exists but isn't a worktree is a loud
// error, never silently reused.
export async function ensureWorktree(repo, laneName, base) {
  const dir = worktreeDir(repo, laneName);
  if (existsSync(path.join(dir, '.git'))) return dir; // pool hit
  if (existsSync(dir)) {
    throw new Error(
      `taskherd: ${dir} exists but is not a git worktree — remove it and re-run`,
    );
  }
  await ensureBranch(repo, laneBranch(laneName), base);
  await git(repo, 'worktree', 'prune');
  await mkdir(path.dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', dir, laneBranch(laneName));
  return dir;
}

// Inplace isolation (§7): the main checkout, switched to taskherd/<lane>. A
// checkout that would clobber uncommitted changes fails, which throws here and
// parks the lane — the user's dirty tree is never overwritten silently.
export async function ensureInplaceBranch(repo, laneName, base) {
  const branch = laneBranch(laneName);
  if ((await currentBranch(repo)) === branch) return repo;
  await ensureBranch(repo, branch, base);
  await git(repo, 'checkout', branch);
  return repo;
}

export async function aheadCount(repo, branch, base) {
  assertSafeBase(base);
  if (!(await branchExists(repo, branch))) return 0;
  return Number(await git(repo, 'rev-list', '--count', '--end-of-options', `${base}..${branch}`));
}

export async function mergedIntoBase(repo, branch, base) {
  assertSafeBase(base);
  try {
    await execFileAsync('git', ['-C', repo, 'merge-base', '--is-ancestor', branch, base]);
    return true;
  } catch {
    return false;
  }
}

export async function isClean(dir) {
  return (await git(dir, 'status', '--porcelain')) === '';
}

export async function headCommit(dir) {
  try {
    return await git(dir, 'rev-parse', '--short', 'HEAD');
  } catch {
    return null;
  }
}

// Merge the lane branch into base (a land approval, §7). When base is checked
// out in the main tree, a real --no-ff merge keeps the lane's work grouped.
// Otherwise a fast-forward-only ref update (`git fetch . branch:base`), which
// git refuses when base is checked out elsewhere or the merge isn't an ff —
// those cases throw and the land gate stays blocked for a human to resolve.
export async function landMerge(repo, branch, base) {
  assertSafeBase(base);
  if ((await currentBranch(repo)) === base) {
    await git(repo, 'merge', '--no-ff', '-m', `taskherd: land ${branch}`, branch);
  } else {
    await git(repo, 'fetch', '.', `${branch}:${base}`);
  }
  return git(repo, 'rev-parse', '--short', base);
}

// Land policy `pr` (§7): push the branch and open a PR via gh. Throws with the
// underlying error (no remote, gh missing/unauthenticated) so the caller can
// park the lane with the real reason.
export async function pushAndOpenPr(repo, branch, base, laneName) {
  await git(repo, 'push', '-u', 'origin', branch);
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'create', '--head', branch, '--base', base,
      '--title', `taskherd: land ${laneName}`,
      '--body', `Automated land of lane \`${laneName}\` (branch \`${branch}\`).`,
    ], { cwd: repo });
    return stdout.trim();
  } catch (err) {
    throw new Error(`gh pr create: ${(err.stderr || err.message || '').trim().split('\n')[0]}`);
  }
}

// gc (§7): remove finished worktrees + `git worktree prune`. "Finished" =
// clean AND (branch merged into base, or the lane file is gone). Removing a
// worktree never loses committed work — the branch keeps it — so the branch is
// only deleted when merged (`-d` refuses otherwise anyway). Anything kept says
// why, so gc is never a silent no-op.
export async function gcWorktrees(repo, configBase = null) {
  const report = [];
  let names = [];
  try {
    names = await readdir(wtRepoDir(repo));
  } catch {
    // no worktree pool for this repo yet
  }
  for (const name of names) {
    const dir = worktreeDir(repo, name);
    const branch = laneBranch(name);
    if (!existsSync(path.join(dir, '.git'))) {
      report.push({ lane: name, action: 'kept', reason: `${dir} is not a git worktree — remove it manually` });
      continue;
    }
    if (!(await isClean(dir).catch(() => false))) {
      report.push({ lane: name, action: 'kept', reason: 'uncommitted changes' });
      continue;
    }
    const base = configBase || (await branchBase(repo, branch)) || (await defaultBase(repo));
    const merged = await mergedIntoBase(repo, branch, base);
    const laneStillExists = existsSync(laneFile(repo, name));
    if (!merged && laneStillExists) {
      report.push({ lane: name, action: 'kept', reason: `unmerged work on ${branch}` });
      continue;
    }
    await git(repo, 'worktree', 'remove', dir);
    if (merged && (await branchExists(repo, branch))) {
      await git(repo, 'branch', '-d', branch);
      report.push({ lane: name, action: 'removed', reason: `merged into ${base}; branch deleted` });
    } else {
      report.push({ lane: name, action: 'removed', reason: `lane gone; unmerged branch ${branch} kept` });
    }
  }
  await git(repo, 'worktree', 'prune').catch(() => {});
  return report;
}

// Parse one `git diff --numstat` line: "<added>\t<deleted>\t<path>". A binary
// file renders added/deleted as "-"; a rename keeps "old => new" (git's own
// human-readable form) verbatim in the path field.
function parseNumstat(line) {
  const t1 = line.indexOf('\t');
  const t2 = line.indexOf('\t', t1 + 1);
  if (t1 === -1 || t2 === -1) return null;
  const a = line.slice(0, t1);
  const d = line.slice(t1 + 1, t2);
  const binary = a === '-' && d === '-';
  return {
    path: line.slice(t2 + 1),
    added: binary ? null : Number(a),
    deleted: binary ? null : Number(d),
    binary,
  };
}

// The lane's branch diff, for reviewing an autonomous agent's work before
// landing it (DESIGN §15 Layer 2 — the worktree diff viewer; the missing piece
// of the manual-gate land loop). Three-dot `base...branch` shows what the lane
// changed since it forked from base, so base moving forward doesn't read as
// noise. The `taskherd/<lane>` branch lives in the main repo's object store
// even for a worktree lane (worktrees share it), so this reads from `repo`
// directly — no worktree checkout needed. The patch is capped (a runaway agent
// could emit a huge diff); truncation is flagged, never silent. `dirty` surfaces
// uncommitted work left in a pool worktree (e.g. a lane parked mid-run).
export async function laneDiff(repo, laneName, { base = null, maxBytes = 400_000 } = {}) {
  const branch = laneBranch(laneName);
  if (!(await branchExists(repo, branch))) {
    return { exists: false, branch };
  }
  const resolvedBase = base || (await branchBase(repo, branch)) || (await defaultBase(repo));
  assertSafeBase(resolvedBase);
  const range = `${resolvedBase}...${branch}`;
  const numstat = (await gitRaw(repo, 'diff', '--numstat', '--end-of-options', range)).replace(/\n+$/, '');
  const files = numstat ? numstat.split('\n').map(parseNumstat).filter(Boolean) : [];
  const full = await gitRaw(repo, 'diff', '--end-of-options', range);
  const bytes = Buffer.byteLength(full);
  const truncated = bytes > maxBytes;
  const patch = truncated ? full.slice(0, maxBytes) : full;
  const ahead = await aheadCount(repo, branch, resolvedBase);

  let dirty = false;
  const wt = worktreeDir(repo, laneName);
  if (existsSync(path.join(wt, '.git'))) {
    dirty = !(await isClean(wt).catch(() => true));
  }
  return {
    exists: true, branch, base: resolvedBase, ahead, files, patch, truncated, bytes, dirty,
  };
}
