---
name: task
description: Execute one unit of scheduled lane work, then provision the next fire — enqueue a follow-up step, gate on a human, or fork an independent workstream via the taskherd tasks_* tools. Use when fired as a scheduled taskherd step, or to finish any work session in a taskherd-managed repo.
---

# /task — the taskherder finalization loop

You are (usually) one scheduled fire of a **task lane**: cron ran `taskherd run`,
which picked this lane and spawned you once. Whatever you do not record before
exiting is gone — the next fire starts fresh. `/task` = do the work, then
**provision the next fire**.

Environment: `TASKHERD_LANE` is the lane you are running in; `TASKHERD_REPO` is
the main repo (your cwd may be a throwaway git worktree on branch
`taskherd/<lane>` — commit normally, never push or switch branches; landing is
taskherd's job, gated by a human).

## 1. Work

Do one bounded unit of work:

- If the project has its own work loop (a `/work` skill, a PLAN.md "Work
  pattern"), follow it: one milestone, verify, commit per project policy, stop.
- Otherwise: execute the lane's task as given, verify it actually works, commit.

## 2. Finalize — provision the next fire

Check for the `tasks_*` MCP tools (from the `taskherd` server). **If they are
missing and there is no `.tasks/` dir, skip to step 3** — never fake it.
Start with `tasks_status` to see the lane tree as it is now.

- **Next up → usually nothing.** A recurring lane re-runs its default prompt
  next fire with zero bookkeeping. Only `tasks_add` an explicit step when the
  next fire needs something *specific* — a particular prompt, model, provider,
  or a one-off `command` step.
- **An open thread needs a human** (a design question, missing credentials, a
  sign-off, an outward-facing action like publishing) → `tasks_block` with a
  message saying exactly what the human must decide or do (put long prose in a
  `.tasks/desc/*.md` file and reference it). This pauses only your lane;
  siblings continue. Do **not** block for things you can decide yourself.
- **You discovered an independent workstream** (parallelizable, different
  cadence, or different risk profile) → `tasks_fork` a sibling lane off yours,
  seeded with an initial step or default. Do not fork what is really just your
  own next step.
- **Fork-time contract when the repo runs parallel lanes** (DESIGN §25 —
  `tasks_status` shows a `parallel:` line when it does): fork only
  **independent, disjoint file scopes** into isolated lanes; declare every
  shared resource isolation can't prove disjoint (a port, one external DB, a
  rate-limited account) as a `mutex` tag on *both* lanes; work whose file
  scope **overlaps** yours stays in **your** lane — serial by construction, no
  analysis needed. Servers you start should bind at `TASKHERD_PORT_BASE` (a
  per-lane 50-port block) so concurrent lanes never fight over a port.
- **Durable field notes from a worktree → `tasks_note`**, never a copied
  working-memory file. If your cwd is a worktree, any `PLAN*.md` there is a
  read-only snapshot seeded by the bootstrap manifest (DESIGN §24) — edits to
  it are **never synced back** and will be silently lost. `tasks_note` appends
  to `.tasks/notes/<lane>.md` in the main repo; a human (or a designated
  serial lane) integrates notes into the shared plan.
- **Pick axes per task nature** when enqueuing (§17): architecture/design work
  → a strong model, `inplace` if it needs the live checkout; scoped mechanical
  work → a cheaper model, `worktree`; a different account → that `profile`; a
  remote/container build → that `runner`. Omit anything the lane/project
  default already gets right. **Allocating for a sub-task? Call `tasks_options`
  first** (DESIGN §26): the static schema can't know what *this box* offers, but
  the catalog reports the real runners, resolved defaults, and which risky
  values are operator-gated here — allocate from those, not guesses.
- **Container lanes** (DESIGN §26): a lane that must run its steps *inside a
  container that can do git* uses **`isolation: clone` + a docker image runner**
  (a plain `worktree` cannot do git in a container — its `.git` is a host path).
  `lifecycle` defaults to **`ephemeral`** (a fresh `docker run --rm` per fire —
  the safe default); **prefer `persistent`** for a stable, single-account,
  install-heavy lane (a `bootstrap.generate`/`npm ci` cost is the tell) — it is
  ONE taskherd-managed container per lane, so `node_modules`/caches/`generate`
  output stay **warm between fires** instead of rebuilding each time. It is
  **operator-gated** (`containers.allowPersistent`): call `tasks_options` to see
  whether it's permitted here — selecting it where it isn't parks the lane.
  Caveat: persistent state is **shared across fires**, so a poisoned cache or a
  half-written dep persists too — `taskherd gc` (which reaps the container with
  the clone) is the reset. `mcpTransport: mount` (default) is what lets an
  in-container agent finalize through `tasks_*`; it needs node in the image (else
  it degrades to a loud stand-in). Land/diff work exactly as for a worktree lane.
- **Keep the plan and the lane tree consistent.** The lane tree is the
  *executable projection* of the plan's "Next up / Open threads": a thread you
  gated should be marked as gated in the plan file, and vice versa — never
  tracked in one but silently missing from the other.

There is deliberately no `tasks_run` — never try to trigger the scheduler
yourself; the next cron fire picks up what you enqueued.

## 3. Hand off

End with the handoff block, in your final message and (if the project keeps
one) the plan file — via `tasks_note` when your cwd is a worktree, since a
copied plan snapshot never syncs back:

- **Landed:** what shipped this fire (commits on `taskherd/<lane>`).
- **Tests:** suite result, before → after.
- **Open threads:** each one, and whether it is now a gate (`tasks_block`), a
  fork, or just noted.
- **Next up:** what the next fire will do — the lane default, or the specific
  step you enqueued.
