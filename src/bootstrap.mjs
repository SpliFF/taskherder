// Worktree bootstrap — the seed manifest (DESIGN §24). A fresh worktree checks
// out tracked files only; the manifest declares the gitignored state a lane's
// tree needs and runs when the pool worktree is created. The verb encodes the
// sharing decision: `link` (symlink → main checkout: shared, live, read-mostly),
// `copy` (snapshot at seed time, reflink-cheap, diverges by design, never synced
// back), `generate` (commands run serially in the fresh tree). Deliberately
// imports nothing from tasks.mjs/git.mjs — git.mjs calls into here.
import {
  mkdir, readdir, readFile, writeFile, rm, symlink, cp, stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const VERBS = ['link', 'copy', 'generate'];

// A link/copy entry becomes a path under both the main checkout and the tree —
// absolute paths, traversal, and `.tasks` (§24 rule 3: the single source of
// coordination truth is never forked into a worktree) must all fail loudly at
// parse time, never half-apply.
function assertSafeEntry(verb, entry) {
  const rel = entry.replace(/\/+$/, '');
  if (path.isAbsolute(rel) || rel.split('/').includes('..') || rel === '' || rel === '.') {
    throw new Error(`taskherd: bootstrap.${verb} entry ${JSON.stringify(entry)} must be a relative path inside the repo (no absolute paths, no "..")`);
  }
  if (rel === '.tasks' || rel.startsWith('.tasks/')) {
    throw new Error(`taskherd: bootstrap.${verb} must not seed .tasks/ — it is the single source of coordination truth, reached via TASKHERD_REPO (§24 rule 3)`);
  }
  if (verb === 'link' && /[*?]/.test(rel)) {
    throw new Error(`taskherd: bootstrap.link entry ${JSON.stringify(entry)} — globs are only supported in \`copy\` (a link names one shared path)`);
  }
  if (verb === 'copy' && /[*?]/.test(path.dirname(rel))) {
    throw new Error(`taskherd: bootstrap.copy entry ${JSON.stringify(entry)} — glob patterns are only supported in the final path segment`);
  }
}

// Validates a bootstrap manifest, throwing loudly on unknown verbs / non-array
// values / unsafe entries — fail-closed like parseWhen: a malformed manifest
// parks the lane at seed time, it never silently half-applies (§24 rule 1).
// Returns the manifest unchanged (or null when nothing is configured).
export function parseBootstrap(manifest) {
  if (manifest == null) return null;
  if (typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`taskherd: bootstrap manifest must be an object of {link,copy,generate} arrays, got ${JSON.stringify(manifest)}`);
  }
  for (const [verb, val] of Object.entries(manifest)) {
    if (!VERBS.includes(verb)) {
      throw new Error(`taskherd: unknown bootstrap verb ${JSON.stringify(verb)} (expected link/copy/generate) — refusing to apply the manifest (§24)`);
    }
    if (!Array.isArray(val)) {
      throw new Error(`taskherd: bootstrap.${verb} must be an array of strings, got ${JSON.stringify(val)}`);
    }
    for (const entry of val) {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`taskherd: bootstrap.${verb} entries must be non-empty strings, got ${JSON.stringify(entry)}`);
      }
      if (verb !== 'generate') assertSafeEntry(verb, entry);
    }
  }
  return manifest;
}

// Reflink-cheap copy (§24): APFS clonefile via `cp -c` on darwin,
// `cp --reflink=auto` on linux (which falls back to a plain copy internally),
// plain fs.cp elsewhere — or whenever the cp attempt fails (non-reflink
// filesystem). The fallback is a working copy, not a capability gap, so it is
// silent. `cpArgv` is injectable so tests can force the fallback path.
export function defaultCpArgv() {
  if (process.platform === 'darwin') return ['cp', '-c', '-R'];
  if (process.platform === 'linux') return ['cp', '--reflink=auto', '-R'];
  return null;
}

export async function copyPath(src, dst, cpArgv = defaultCpArgv()) {
  if (cpArgv) {
    try {
      await execFileAsync(cpArgv[0], [...cpArgv.slice(1), src, dst]);
      return;
    } catch {
      // fall through to the plain copy
    }
  }
  await cp(src, dst, { recursive: true });
}

// Expands one copy entry: a literal path, or a glob (`*`/`?`) in the FINAL
// segment only (parse-time enforced). Returns repo-relative matches, sorted.
async function expandCopyEntry(repo, entry) {
  const rel = entry.replace(/\/+$/, '');
  const base = path.basename(rel);
  if (!/[*?]/.test(base)) {
    return existsSync(path.join(repo, rel)) ? [rel] : [];
  }
  const dir = path.dirname(rel);
  let names = [];
  try {
    names = await readdir(path.join(repo, dir));
  } catch {
    return [];
  }
  const rx = new RegExp(`^${base.split('').map((ch) => {
    if (ch === '*') return '[^/]*';
    if (ch === '?') return '[^/]';
    return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('')}$`);
  return names.filter((n) => rx.test(n)).map((n) => (dir === '.' ? n : path.join(dir, n))).sort();
}

async function runGenerate(cmd, wt) {
  try {
    await execFileAsync('/bin/sh', ['-c', cmd], { cwd: wt, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const tail = `${err.stderr || ''}\n${err.stdout || ''}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(
      `taskherd: bootstrap generate ${JSON.stringify(cmd)} failed in ${wt}${typeof err.code === 'number' ? ` (exit ${err.code})` : ''}${tail ? `:\n${tail}` : ''}`,
    );
  }
}

// Executes a (validated) manifest against a fresh tree. Missing link/copy
// sources are ONE loud warning each (the file may legitimately not exist on
// this machine — §24 rule 1) and never clobber a path already present in the
// tree; a failed `generate` throws, which parks the lane as a setup error.
export async function seedWorktree(repo, wt, manifest, { log = console.error, cpArgv = defaultCpArgv() } = {}) {
  const m = parseBootstrap(manifest);
  if (!m) return { linked: [], copied: [], generated: [], warnings: [] };
  const warnings = [];
  const warn = (msg) => {
    const w = `taskherd: WARNING bootstrap ${msg}`;
    warnings.push(w);
    log(w);
  };

  const linked = [];
  for (const entry of m.link || []) {
    const rel = entry.replace(/\/+$/, '');
    const src = path.join(repo, rel);
    const dst = path.join(wt, rel);
    if (!existsSync(src)) {
      warn(`link source ${rel} missing from ${repo} — skipped (it may not exist on this machine)`);
      continue;
    }
    if (existsSync(dst)) {
      warn(`link target ${rel} already exists in ${wt} — left as-is`);
      continue;
    }
    await mkdir(path.dirname(dst), { recursive: true });
    await symlink(path.resolve(src), dst);
    linked.push(rel);
  }

  const copied = [];
  for (const entry of m.copy || []) {
    const matches = await expandCopyEntry(repo, entry);
    if (matches.length === 0) {
      warn(`copy source ${entry} matched nothing in ${repo} — skipped (it may not exist on this machine)`);
      continue;
    }
    for (const rel of matches) {
      const dst = path.join(wt, rel);
      if (existsSync(dst)) {
        warn(`copy target ${rel} already exists in ${wt} — left as-is`);
        continue;
      }
      await mkdir(path.dirname(dst), { recursive: true });
      await copyPath(path.join(repo, rel), dst, cpArgv);
      copied.push(rel);
    }
  }

  const generated = [];
  for (const cmd of m.generate || []) {
    await runGenerate(cmd, wt); // throws → setup error → the lane parks (§24 rule 1)
    generated.push(cmd);
  }

  log(`taskherd: seeded worktree ${wt} (${linked.length} linked, ${copied.length} copied, ${generated.length} generated)`);
  return { linked, copied, generated, warnings };
}

// Seeding-state marker. It lives in the tree's git ADMIN dir, NOT in the tree
// itself — an untracked marker file would dirty `git status` (breaking
// isClean/gc) and survive into commits. For a linked worktree (§24) `.git` is a
// file pointing at the admin dir under the main repo; for a `clone` (§26) `.git`
// IS a real directory. Either way the admin dir is cleaned up when the tree is
// removed (`git worktree remove/prune`, or gc's `rm -rf` for a clone), so gc +
// recreate re-seeds for free (§24 rule 2 / §26).
async function treeAdminDir(tree) {
  const gitPath = path.join(tree, '.git');
  const st = await stat(gitPath);
  if (st.isDirectory()) return gitPath; // a clone — the real .git directory
  const text = await readFile(gitPath, 'utf8');
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) {
    throw new Error(`taskherd: ${gitPath} is not a linked-worktree pointer or a git directory — cannot track seeding state`);
  }
  return path.resolve(tree, m[1]);
}

function seedingMarker(adminDir) {
  return path.join(adminDir, 'taskherd-seeding');
}

export async function markSeeding(wt) {
  await writeFile(seedingMarker(await treeAdminDir(wt)), `${new Date().toISOString()}\n`);
}

export async function clearSeeding(wt) {
  await rm(seedingMarker(await treeAdminDir(wt)), { force: true });
}

// True when a creation-time seeding started but never completed (a failed
// `generate` parked the lane mid-seed). The pool must finish seeding before
// running a step there — a half-seeded tree must never run silently (§24
// rule 1). Absent marker = seeded or pre-manifest legacy tree: not re-seeded
// (seeding belongs to creation; a changed manifest applies on gc + recreate).
export async function isSeedingPending(wt) {
  return existsSync(seedingMarker(await treeAdminDir(wt)));
}

// §24 rule 4 — the ignored-file advisory: after seeding, top-level gitignored
// entries present in the main checkout but absent from the tree get ONE loud
// warning naming the manifest, so a missing .env is an actionable message
// instead of a mystery test failure. Advisory only; never blocks, never throws.
export async function ignoredAdvisory(repo, wt, { log = console.error } = {}) {
  let out = '';
  try {
    ({ stdout: out } = await execFileAsync(
      'git',
      ['-C', repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch {
    return []; // not a git repo / git unavailable — nothing to advise on
  }
  const missing = [];
  for (const line of out.split('\n')) {
    const entry = line.replace(/\/+$/, '');
    if (!entry || entry.includes('/')) continue; // top-level entries only (§24 rule 4)
    if (entry === '.tasks') continue; // never seeded, by design (§24 rule 3)
    if (!existsSync(path.join(wt, entry))) missing.push(entry);
  }
  if (missing.length) {
    log(`taskherd: NOTE worktree ${wt} lacks gitignored state the main checkout has: ${missing.join(', ')} — if the lane needs it, seed it via the bootstrap manifest ("bootstrap": {"link"/"copy"/"generate"} in .tasks/config.json; DESIGN §24)`);
  }
  return missing;
}
