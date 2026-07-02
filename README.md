# taskherder

> Herd scheduled **task lanes** across projects, containers, and hosts. Every
> lane runs OS commands and AI agents (Claude / Codex / Copilot) on a schedule,
> with manual gates, git-branch isolation, per-account auth, and an optional web
> console. CLI-first; the GUI is a view over the same files.

**Status:** core built through M3 — scheduler + pty/control seam, AI providers +
auth profiles + budgets, and git isolation (worktrees, `taskherd/<lane>` branches,
land gates, `gc`). Next: MCP server + `/task` skill (M4). The full architecture is
in **[DESIGN.md](DESIGN.md)** — read it first.

## The idea in one picture

```
cron/launchd ──fires──▶ taskherd run <repo>
                          │  picks ONE step from the least-recently-run lane
                          │  in <repo>/.tasks/, runs it under a pty, updates state
                          ▼
   provider (claude/codex/copilot) → runner (local/docker/ssh)
   → profile (which account) → isolation (git worktree/inplace/none)

taskherd serve ──▶ optional web console: live task terminals, edit the queue,
                    answer manual gates, interrupt — from desktop or mobile.
```

A **step** is defined by five orthogonal axes — `type` × `provider` × `profile` ×
`runner` × `isolation` — so new capability is a new value on an axis, never a
special case. A **lane** is an ordered list of steps; lanes form a tree but run
independently; a **manual gate** blocks one lane while its siblings keep going.

## Command surface (see [DESIGN.md §18](DESIGN.md))

```
taskherd init | run | status | add | block | fork | ack | attach
             | pause | resume | gc | history | cost | auth | serve | doctor
```

Package `@spliff/taskherder` · command `taskherd` (opt-in `task`/`th` aliases) ·
MCP server `taskherd-mcp` · skill `/task` · MIT.

## Roadmap

Milestones **M1–M8** are defined in [DESIGN.md §21](DESIGN.md): core scheduler +
pty/control seam → AI providers + per-account profiles → git isolation → MCP +
`/task` skill → web console → docker/ssh runners → graphical streaming → publish.
