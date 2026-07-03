// Project registry (DESIGN §4: ~/.taskherd/projects.json) — the web console's
// map of which repos to aggregate. Keyed by repoId (basename + path hash) so
// two checkouts with the same basename never collide and the id is URL-safe
// for the serve API. Registration happens on `taskherd init` and when `serve`
// starts in a repo; removal is manual (edit the file) — a registered path that
// no longer exists is surfaced as missing by the console, never silently
// dropped.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { taskherdHome, repoId, repoTasksDir } from './paths.mjs';

export function projectsFile() {
  return path.join(taskherdHome(), 'projects.json');
}

export async function loadProjects() {
  try {
    return JSON.parse(await readFile(projectsFile(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`taskherd: malformed registry JSON at ${projectsFile()}: ${err.message}`);
  }
}

async function saveProjects(projects) {
  await mkdir(taskherdHome(), { recursive: true });
  const file = projectsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(projects, null, 2)}\n`);
  await rename(tmp, file);
}

// Idempotent: re-registering the same repo refreshes its path (a moved
// checkout gets a new id anyway, since the id hashes the resolved path).
export async function registerProject(repo) {
  const resolved = path.resolve(repo);
  const id = repoId(resolved);
  const projects = await loadProjects();
  if (projects[id]?.path === resolved) return { id, path: resolved };
  projects[id] = { path: resolved };
  await saveProjects(projects);
  return { id, path: resolved };
}

// Registry entries annotated with reality: a project whose path or .tasks/ is
// gone stays listed (with `missing: true`) so the console can say so loudly
// instead of quietly shrinking the list.
export async function listProjects() {
  const projects = await loadProjects();
  return Object.entries(projects).map(([id, entry]) => ({
    id,
    path: entry.path,
    name: path.basename(entry.path),
    missing: !existsSync(repoTasksDir(entry.path)),
  }));
}
