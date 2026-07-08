# taskherder

> Herd scheduled **task lanes** across projects, containers, and hosts. Every
> lane runs OS commands and AI agents (Claude / Codex / Copilot) on a schedule,
> with manual gates, git-branch isolation, per-account auth, and an optional web
> console. CLI-first; the GUI is a view over the same files.

**Status:** all designed milestones are built — the cron/launchd one-shot
scheduler + pty/control seam, AI providers with per-account auth profiles and
spend budgets, git-worktree isolation (`taskherd/<lane>` branches, land gates,
`gc`), the agent loop (`taskherd-mcp` + the bundled `/task` skill), a web console
(`taskherd serve`) with live terminals / queue editing / gate control, `docker`
and `ssh` runners, a worktree **diff** viewer, web-SSH, and Xpra/noVNC graphical
streaming. First public release: **0.1.0** — usable, pre-1.0; see
[CHANGELOG.md](CHANGELOG.md) for the honest list of what is and isn't
live-verified. Full architecture is in **[DESIGN.md](DESIGN.md)**.

## Install

```
npm i -g taskherder        # global CLI: `taskherd`
# or run without installing:
npx taskherder <command>
```

**Requirements:** Node **>=18**, Linux or macOS (Windows untested). taskherder
uses [`node-pty`](https://github.com/microsoft/node-pty), a native module — a
global install may build it from source on platforms without a prebuilt binary,
so a C/C++ toolchain (Xcode CLT on macOS, `build-essential` + `python3` on Linux)
may be required. `taskherd doctor` reports whether the pty backend loaded.

## Quickstart

```sh
# In a project repo:
taskherd init                                   # scaffold .tasks/ (+ gitignore)

# A shell-command lane that runs the tests, then waits for a human sign-off:
taskherd add ci "npm test"                      # a `command` step
taskherd add ci --type manual "review + land"   # a `manual` gate

# An AI lane: run the /work milestone loop each fire, under a named auth profile:
taskherd auth login work                        # register an account profile
taskherd add dev --type ai --profile work "work the plan"

# Fire one step (the scheduler picks the least-recently-run lane and runs ONE
# step). Wire this into cron or launchd to herd continuously:
taskherd run
#   crontab:  */10 * * * *  taskherd run -C /path/to/repo
taskherd run --lane dev  # or `-l dev`: manually fire ONE step of a specific lane
taskherd run -l dev --force   # override a PAUSE for this one manual run

taskherd status          # lanes, last result, open gates, cost
taskherd ack ci          # answer the manual gate → the lane advances / lands
taskherd diff dev        # review what the agent committed to taskherd/dev
taskherd serve           # web console: live terminals, gates, queue, per-lane RUN
```

The scheduler is a **one-shot**: each fire runs a single step and exits, so a
crashed run can never wedge the herd. State is plain files — `<repo>/.tasks/`
(per project) and `~/.taskherd/` (per user) — that the CLI, the cron runner, and
the console all read and write.

## The idea in one picture

```
cron/launchd ──fires──▶ taskherd run <repo>
                          │  picks ONE step from the least-recently-run lane
                          │  in <repo>/.tasks/, runs it under a pty, updates state
                          ▼
   provider (claude/codex/copilot) → runner (local/docker/ssh)
   → profile (which account) → isolation (git worktree/inplace/none)

taskherd serve ──▶ optional web console: live task terminals, edit the queue,
                    answer manual gates, interrupt, review diffs — desktop or mobile.
```

A **step** is defined by five orthogonal axes — `type` × `provider` × `profile` ×
`runner` × `isolation` — so new capability is a new value on an axis, never a
special case. A **lane** is an ordered list of steps; lanes form a tree but run
independently; a **manual gate** blocks one lane while its siblings keep going.

## Command surface (see [DESIGN.md §18](DESIGN.md))

```
taskherd init | run | status | add | block | fork | ack | diff | attach
             | pause | resume | gc | history | cost | auth | serve
             | install | doctor
```

Package `taskherder` · command `taskherd` (bins also expose `taskherder` and
`taskherd-mcp`; `task`/`th` are opt-in shell aliases you add yourself, to avoid
clobbering Taskwarrior / go-task) · MCP server `taskherd-mcp` · skill `/task` ·
MIT.

`taskherd serve` is loopback-only by default; `--host 0.0.0.0` (or a tunnel)
exposes it, always token-gated. The interactive web-SSH and graphical-streaming
capabilities are **opt-in** behind `serve --allow-shell` and `serve --allow-gfx`
(both off by default — they are real interactive-control surfaces).

## Agent loop — MCP + the `/task` skill

`taskherd install` registers `taskherd-mcp` in the claude CLI's **user-global**
MCP config and links the bundled `/task` skill into `~/.claude/skills/` —
`taskherd doctor` checks both. The MCP server exposes `tasks_init · tasks_status
· tasks_add · tasks_block · tasks_fork · tasks_ack` (deliberately **no
`tasks_run`**: an agent must not spawn itself). Scheduled `ai` steps get the same
tools automatically via a per-run merged `--mcp-config`, so the `/task`
finalization loop works inside isolated worktree runs too — a scheduled run can
enqueue its own next step, gate on a human, or fork a sibling lane.

## Safety

Built for **unattended** use: git isolation, spend budgets, timeouts with
SIGTERM→SIGKILL escalation, a pause switch, and land-gates are **default-on**.
Autonomous agents run with `bypassPermissions`, so blast radius is a first-class
concern — every stub or capability gap fails **loudly** (greppable
`FIDELITY-STANDIN:` markers), never silently.

**Isolation isolates git state, not the filesystem.** A `command`/`ai` step runs
with your full user privileges; `worktree`/`inplace` isolation only changes which
branch and working directory it runs in — the agent can still read and write
anywhere your user can. For a real filesystem/network boundary, run the step under
a **`docker` or `ssh` runner** — that is the only true sandbox.

The web console (`taskherd serve`) binds **loopback by default** and requires a
bearer token on every request (a token holder can queue steps, i.e. run code — so
keep the token private, and prefer a tunnel/Tailscale over `--host 0.0.0.0`, which
serves the token in cleartext). The two interactive-control capabilities are
**opt-in, off by default**: `--allow-shell` (web-SSH — an interactive shell as the
serve user) and `--allow-gfx` (proxy an in-runner Xpra/noVNC GUI, served from a
**separate origin/port** so a proxied GUI can't read the console token).

## Attribution

Several design *patterns* were studied from
[`@yemi33/minions`](https://github.com/yemi33/minions) (MIT) and re-implemented
as lean original code — see [NOTICE](NOTICE) and [DESIGN.md §20](DESIGN.md). MIT
licensed; see [LICENSE](LICENSE).
