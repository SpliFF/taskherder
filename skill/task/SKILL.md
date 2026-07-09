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
  default already gets right.
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
