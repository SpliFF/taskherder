# taskherder — Design

> Herd scheduled **task lanes** across projects, containers, and hosts.
> Every lane runs OS commands and AI agents (Claude / Codex / Copilot) on a
> schedule, with manual gates, git-branch isolation, per-account auth, and an
> optional web console. CLI-first; the GUI is a view over the same files.

**Package:** `taskherder` (npm, unscoped) · **command:** `taskherd` (bins also
`taskherder`, `taskherd-mcp`; opt-in `task`/`th`) · **MCP server:** `taskherd-mcp`
· **skill:** `/task` · **repo:** `SpliFF/taskherder` · **license:** MIT.

---

## 1. Principles

1. **Files are the source of truth.** All state lives in plain files
   (`<repo>/.tasks/`, `~/.taskherd/`). The CLI, the scheduler, and the web
   console are all just *clients* of those files + an event stream. Nothing
   requires a running server.
2. **Orthogonal axes, not features.** A step is defined by picking one value on
   each of five independent axes (§2). No axis knows about another; new
   capability = a new value on an axis, never a special case.
3. **Lean; borrow, don't fork.** Node built-ins first, minimal deps. Lift proven
   *patterns* (not code mass) from `@yemi33/minions` (MIT, §20). Reject its
   daemon/dashboard/5-agent weight.
4. **Safe by default for unattended use.** Isolation, budgets, timeouts, a pause
   switch, and human land-gates are on by default — an autonomous agent with
   `bypassPermissions` is a loaded gun (§10, §12).
5. **No silent failures.** Every shortcut, capability gap, or stand-in logs
   loudly and is greppable. (Inherited instinct from the springrts drive.)
6. **Design the whole shape up front** so the observability/control seam exists
   from milestone 1 and the GUI/runners bolt on without a re-plumb.

---

## 2. Core concept — the five axes

A **step** is one unit of work. It is fully described by choosing one value per
axis:

| Axis | Values | Decides |
|------|--------|---------|
| **type** | `command` · `ai` · `manual` | *what* runs |
| **provider** (ai only) | `claude` · `codex` · `copilot` · … | *which* AI CLI + flags |
| **profile** (auth) | `personal` · `work` · a named API cred · … | *as whom* it authenticates |
| **runner** | `local` · `docker:<ctr>` · `ssh:<host>` | *where* the process executes |
| **isolation** (git) | `worktree` · `inplace` · `none` | *what* working tree it sees |

The pipeline for any step: **provider** renders an argv → **runner** executes
that argv somewhere → **profile** supplies the credential env → **isolation**
decides the working directory → the **executor** wraps it in a pty, streams
events, and enforces guardrails.

A **lane** is an ordered list of steps + a cursor (the next step to run). Lanes
form a **tree** via `parent` but each runs **independently**. A **`.tasks/`
folder** is a set of lane files = one project's herd.

---

## 3. Architecture

Three layers, cleanly separable:

```
┌ STATE ─────────────────────────────────────────────┐
│  <repo>/.tasks/     lanes, config, logs, history,   │   ← source of truth
│  ~/.taskherd/       profiles, providers, runners     │      (plain files)
└────────────────────────────────────────────────────┘
        ▲                         ▲                 ▲
        │ read/write              │ read/write      │ read + stream
┌ EXECUTOR ───────────┐  ┌ CLI ───────────┐  ┌ CONTROL PLANE ─────────┐
│ `taskherd run`      │  │ add/status/... │  │ `taskherd serve`       │
│ cron/launchd fires  │  │ (standalone)   │  │ web console (optional) │
│ picks a lane, runs  │  └────────────────┘  │ HTTP + WebSocket       │
│ ONE step under a    │                      │ live pty + control     │
│ pty, emits events   │──── events.jsonl ───▶│ answer gates, interrupt│
└─────────────────────┘   run/<id>.sock ────▶└────────────────────────┘
```

- **Executor** (`taskherd run <repo>`): the scheduler entrypoint. Fired by
  cron/launchd (or the serve process). Picks one lane's next step, runs it, updates
  state. Stateless between fires.
- **CLI**: mutates/reads files directly. Works with zero servers.
- **Control plane** (`taskherd serve`): optional. Aggregates state across
  registered projects, serves the web console, tails `events.jsonl`, and attaches
  to running steps' pty/control sockets for live view + control.

**The seam that must exist from milestone 1:** every step runs under a **pty**,
emits structured **events**, and exposes a **control channel**. Built in the
CLI-only era, so the web console is a pure add-on later.

---

## 4. Storage layout

### Per-project — `<repo>/.tasks/` (a single globally-gitignored folder)

```
<repo>/.tasks/
  config.json            project defaults (provider, profile, runner, isolation, land, budget)
  <lane>.json            one lane per file (main.json, bar-ui.json, …)
  desc/*.md              prose for manual gates / complex-task prompts (file-as-prompt)
  notes/<lane>.md        per-lane field notes (`tasks_note` — §24)
  logs/<lane>-<ts>.log   per-run transcript (pty capture)
  events.jsonl           append-only event stream (start/output/gate/exit/cost)
  history.jsonl          one line per completed run (audit: exit, cost, tokens, commit)
  run/<id>.sock          control socket of a live step (removed on exit)
  run/<lane>.json        live-run manifest: pid, isolation, runner, mutex tags (§25)
  NEEDS-ATTENTION.md      human-readable list of open manual gates
  PAUSED                  presence = all lanes halted (kill-switch)
  .lock                  per-repo run mutex (atomic mkdir)
```

`.tasks/` is added to the user's **global gitignore** (`~/.config/git/ignore`
or `core.excludesFile`) on `taskherd init`. A project opts *in* to committing its
lanes by adding `!.tasks/` to its own `.gitignore`.

### Per-user — `~/.taskherd/`

```
~/.taskherd/
  config.json            global defaults
  providers.json         provider templates + per-provider flag tables (§8)
  profiles/<name>/       one auth context per profile (§9): CLAUDE_CONFIG_DIR, creds, budget
  runners.json           docker/ssh runner definitions (§11)
  projects.json          registry of projects (for the web console + cross-project status)
  wt/<repo-id>/<lane>/   git worktrees (kept OUTSIDE repo trees — §7)
```

> **Why worktrees live under `~/.taskherd/wt/`, not `.tasks/wt/`:** nesting a
> full checkout inside the repo's own (gitignored) tree confuses git status,
> file-watchers, IDE indexers, and recursive tools. Worktrees are ephemeral
> execution state, not task definitions, so they belong in user-level state.
> *(Deviation from "everything in `.tasks/`" — called out deliberately.)*

---

## 5. Data model

### Lane file — `<repo>/.tasks/<name>.json`

```json
{
  "name": "bar-ui",
  "parent": "main",
  "onEmpty": "default",
  "default": { "type": "ai", "provider": "claude", "task": "/work" },
  "isolation": "worktree",
  "land": "manual-gate",
  "profile": "personal",
  "cursor": 1,
  "lastRun": 126,
  "steps": [
    { "type": "ai", "provider": "claude", "model": "sonnet", "task": "/work",
      "status": "done" },
    { "type": "manual", "message": "Confirm the new BAR HUD layout",
      "file": "desc/bar-hud-signoff.md", "status": "blocked" }
  ]
}
```

### Step — the union over `type`

```jsonc
// command: any OS command (the general cron replacement)
{ "type": "command", "run": "npm test", "shell": true, "status": "pending" }
{ "type": "command", "argv": ["make", "build"] }

// ai: provider-driven; any provider CLI arg overridable, incl. the permission model
{ "type": "ai", "provider": "claude", "task": "/work",   // or "file": "desc/x.md"
  "model": "opus", "session": { "mode": "fresh" },        // or {mode:"resume", id:"…"}
  "args": { "permissionMode": "acceptEdits", "maxTurns": 20 },
  "budget": { "usd": 2.0 } }

// manual: a gate. Does not run. Blocks THIS lane until `ack`; siblings continue.
{ "type": "manual", "message": "…", "file": "desc/…md", "approve": "os" }
```

Common fields resolved by inheritance **step → lane → project `config.json` →
`~/.taskherd/config.json`**: `provider`, `profile`, `runner`, `isolation`,
`land`, `model`, `budget`, `timeout`. `status`: `pending → running → done |
failed | blocked`.

### Project defaults — `<repo>/.tasks/config.json`

```json
{
  "default": { "type": "ai", "provider": "claude", "task": "/work", "onEmpty": "default" },
  "profile": "personal",
  "runner": "local",
  "isolation": "worktree",
  "land": "manual-gate",
  "budget": { "usd": 5.0, "perRun": true },
  "timeout": "45m",
  "maxTurns": 40
}
```

---

## 6. Scheduler

Fired per tick by cron/launchd (or the serve process). **One step per fire.**
*(With parallel lanes enabled, a fire may **admit alongside** live isolated
runs instead of skipping — §25; the one-step-per-fire grain is unchanged.)*

1. **Mutex** — atomic `mkdir .tasks/.lock`; a second fire while one runs logs a
   skip and exits (fires are minutes apart; stale lock cleared after `STALE_MIN`).
   *Halt entirely if `.tasks/PAUSED` exists.*
2. **Load lanes**; a lane whose next action is a reached `manual` gate transitions
   `pending → blocked`, notifies once (§14), and is skipped.
3. **Runnable lanes** = not idle, not gated, not a parked failure.
4. **Fair pick** — the least-recently-run runnable lane (`lastRun` vs a global
   counter; tie → name). No starvation.
5. **Next action** = the pending step at cursor, else (cursor past end) the
   lane/project `default` if `onEmpty:"default"`, else the lane is idle.
6. **Run** the step through the executor (§3, §13). On success → `done`, cursor++.
   On failure → retry once, then **park as a manual gate** pointing at the log
   (a poison step can't loop; siblings keep going).
7. **Record** to `history.jsonl` (exit, cost, tokens, commit, log path); stamp
   `lastRun`.

**Fallback:** no `.tasks/` lanes → run the configured `default` once (a plain
scheduled command). Keeps trivial use zero-config.

`onEmpty:"default"` means an empty lane just runs `/work` (or any default) each
fire — so the steady state needs **no** bookkeeping; finalization (§17) only
writes the tree for *deviations* (specific steps, gates, forks).

---

## 7. Git integration

Isolation is **per-lane** (default from `config.json`):

- **`worktree`** *(default for code lanes)* — a git worktree at
  `~/.taskherd/wt/<repo-id>/<lane>/` on branch `taskherd/<lane>`, forked from
  `base` (default = the repo's default-branch tip). Full isolation; the user's
  checkout is never touched; unlocks true concurrency (§25). Seeded with
  gitignored state per the bootstrap manifest (§24).
- **`inplace`** — runs in the main checkout on `taskherd/<lane>`. For lanes that
  need the **live/shared runtime** (a running server, a built binary, fixed ports,
  a shared DB — e.g. springrts `/work`). Serialized by the mutex.
- **`none`** — no git management (read-only or non-repo `command` steps).

**Branch:** `taskherd/<lane>`. **Base:** configurable; default default-branch tip.
**Staleness:** no auto-rebase; conflicts surface at land time.

**Land policy** (per-lane, both supported; default `manual-gate`):

- **`manual-gate`** *(default)* — on completion, drop a manual gate; you review the
  diff and `taskherd ack <lane>` to merge (or merge yourself).
- **`pr`** — push the branch + open a PR (gh/git) for review.
- **`leave`** — leave branch + worktree; fully manual.

**GC:** `taskherd gc` removes finished worktrees + `git worktree prune`; a pool is
reused across fires. Under `docker`/`ssh` runners the worktree is created host-side
and **bind-mounted / synced into** the runner env (§11).

---

## 8. Providers & sessions

A **provider** is a config template that renders an argv. Defaults ship in
`~/.taskherd/providers.json`; per-step `args` override anything (incl. the
**permission model** — a first-class, overridable arg).

```jsonc
{
  "claude": {
    "command": "claude",
    "promptArgs": ["-p", "{task}"],
    "modelArg":  ["--model", "{model}"],
    "sessionArgs": { "resume": ["--resume", "{id}"], "continue": ["-c"] },
    "permission": { "flag": ["--permission-mode", "{permissionMode}"],
                    "default": "bypassPermissions" },
    "defaultArgs": ["--add-dir", "/tmp"],
    "mcpArgs":   ["--mcp-config", "{repo}/.mcp.json", "--strict-mcp-config"],
    "maxTurnsArg": ["--max-turns", "{maxTurns}"],
    "costJson":  ["--output-format", "json"]         // parsed for §10 cost logging
  },
  "copilot": { "command": "copilot", "defaultArgs": ["--acp","--allow-all","--autopilot"], … },
  "codex":   { "command": "codex", "promptArgs": ["exec","{task}"],
               "defaultArgs": ["--sandbox","workspace-write","--json","-"], … }
}
```
*(The per-provider permission/flag table is the pattern borrowed from minions.)*

**Session modes** (ai): `fresh` (default, new context) · `resume <id>` · `continue`
— a lane can carry a persistent session across fires for accumulating context.

---

## 9. Profiles — per-project auth isolation

You run **multiple, separate accounts** (personal + work). A **profile** is a
named auth context selected per project/lane (`"profile": "work"`).

```json
// ~/.taskherd/profiles/work/profile.json
{ "provider": "claude",
  "env": { "CLAUDE_CONFIG_DIR": "~/.taskherd/profiles/work/claude" },
  "budget": { "usdPerDay": 10 } }
```

- **Mechanism:** the runner exports the profile's `env` per spawn. For Claude,
  `CLAUDE_CONFIG_DIR` points each account at its own logged-in config; or an
  `ANTHROPIC_API_KEY` selects an API account. Fully isolated per step.
- **Login once:** `taskherd auth login work` runs
  `CLAUDE_CONFIG_DIR=…/work/claude claude /login` so that account's token lands in
  the profile dir; scheduled runs reuse it.
- **macOS keychain caveat:** Claude Code may store the OAuth token in the
  per-user keychain (not per-config-dir), which can defeat file-level isolation.
  **Robust isolation paths:** an **API-key profile** (env var, fully isolated) or a
  **container/remote profile** (separate home/keychain — §11). Verified per-provider
  in M2; the CLI warns if a profile can't guarantee isolation.

---

## 10. Cost, billing & budget

Billing depends entirely on how the provider CLI is authenticated:

- **Subscription login (Claude Pro/Max)** → draws down **plan limits** (5-hour +
  weekly caps). An hourly Opus lane can throttle your *interactive* usage.
- **API key** → **metered usage tokens** ($ per token).

Therefore, **default-on**:

- **Budget caps** — `budget.usd` per run and/or per-day, per lane/project/profile.
  Exceeding it blocks the lane with a gate.
- **`--max-turns` + `timeout`** — bound a single run.
- **Per-run cost logging** — providers with a cost-JSON mode (`claude
  --output-format json`) have cost + tokens parsed into `history.jsonl`; `status`
  shows running totals.
- **Recommended pattern:** point the scheduler's profile at a **dedicated,
  spend-capped API key** so autonomous runs can't drain your Max plan or a budget.

---

## 11. Runners — local / docker / ssh

A **runner** implements `exec(argv, { cwd, env, pty })` somewhere:

- **`local`** *(v1)* — spawn on the host.
- **`docker:<container>`** — `docker exec` into a running container (or `docker
  run` with the worktree bind-mounted). Its own home/keychain ⇒ **strongest
  multi-account isolation**.
- **`ssh:<host>`** — run over SSH on a remote host.

```json
// ~/.taskherd/runners.json
{ "build-box": { "kind": "ssh", "host": "user@build.local", "cwd": "/srv/{repo}" },
  "sandbox":   { "kind": "docker", "image": "taskherder/agent:latest",
                 "mounts": ["{worktree}:/work"], "workdir": "/work" } }
```

**Honest complexity (v2):** the repo/worktree must exist *in the runner env*
(bind-mount the host worktree into the container; check out / rsync on the remote —
full remote-git is a later refinement), and any `.mcp.json` servers must run there
too (chrome-in-docker is heavy; fine for code lanes). Graphical streaming (§15
Layer 2) lives most naturally inside these containers.

---

## 12. Safety & guardrails (default-on)

- **Pause kill-switch** — `taskherd pause [<repo>]` / `.tasks/PAUSED` halts all
  lanes without touching cron; `taskherd resume`.
- **Isolation** — worktree by default; autonomous commits land on `taskherd/<lane>`,
  never the user's branch.
- **Land-gate** — `manual-gate` by default; a human merges.
- **Budget + max-turns + timeout** — §10.
- **Permission model per provider** — explicit, overridable; loud on first use.
- **No silent failures** — shader/exec/capability gaps log loudly, greppable
  (`FIDELITY-STANDIN:` style tags).

---

## 13. Observability & control seam (built in M1)

Every step runs through one executor path, regardless of type/runner:

- **pty** — the step runs under a pseudo-terminal, so curses/TUI apps work and
  output is a real terminal stream (not just piped text). Captured to
  `logs/<lane>-<ts>.log`.
- **events** — structured lines to `events.jsonl`: `run.start`, `output` (chunked,
  with a ring buffer for late attach), `gate.blocked`, `run.exit` (code, cost,
  tokens), `land.*`.
- **control channel** — a unix socket `run/<id>.sock` accepting: `input` (inject
  keystrokes — answer a prompt), `signal` (INT/TERM — interrupt/kill), `detach`.
- **history** — `history.jsonl` audit; `status` renders lanes + last result + cost
  totals + open gates.

The CLI already uses this (`taskherd attach <lane>` = a local xterm over the same
pty). The web console (§15) attaches the same way, remotely.

---

## 14. Notifications & approval bindings

Pluggable channels for gates, failures, and approvals:

- **`web`** — the console (§15) is the primary control surface (answer/interrupt).
- **`os`** — `osascript` (macOS) / `notify-send` (Linux): a "come look" ping.
- **`remote-control`** — bind a Claude step to a monitorable claude.ai mobile
  session (Claude-only, secondary).
- **`slack`** — *future* stub; the channel interface is designed so it slots in.

A `manual` step's `approve` picks the channel; the web console generalizes them
all (mobile-friendly), with `os` as the notifier.

---

## 15. Web console — `taskherd serve` (optional control plane)

A Node HTTP + WebSocket server over the file state + event stream. **Not** a
daemon the system depends on — the CLI/cron run without it.

**Serves:**
- **Status & live feedback** — lanes across all registered projects; live task
  output via **xterm.js** over WS (attached to the step's pty, §13).
- **Queue view/edit** — reorder, add, edit, remove steps; fork lanes.
- **Organise & create** — grouped by **project / container / host** (mirrors the
  runner axis).
- **Control** — answer gates / interrupt / pause, from desktop or **mobile**.
- **Worktree file/diff viewer** — *(future milestone)* browse a lane's branch diff.
- **Web SSH + graphical viewer** — *(future milestone)* pty over the web for a
  runner host; **Xpra** (per-app HTML5) / **noVNC·KasmVNC** (containerized desktop)
  for GUI tasks — Layer 2 above the pty default.

**Stack:** Node backend (built-in http + a small WS lib), a prebuilt SPA (Vite +
a light framework + xterm.js) shipped as static assets in the package. **Auth
required** (it can trigger tasks); remote/mobile via reverse proxy / SSH tunnel /
Tailscale. **No Electron** — web-first covers desktop + remote + mobile; an
optional thin menubar wrapper could come later.

**Terminal strategy:** **pty + xterm.js is the core, default** live view (covers
terminal + curses). Graphical streaming (Xpra / noVNC) is **opt-in, later**, for
GUI tasks — most naturally inside the docker runner.

---

## 16. MCP server — `taskherd-mcp`

Exposes the mutation/inspection surface to any Claude session (and the `/task`
skill): **`tasks_init` · `tasks_status` · `tasks_add` · `tasks_block` (gate) ·
`tasks_fork` · `tasks_ack` · `tasks_note` (§24)**. Deliberately **no `tasks_run`** — scheduling is
cron/serve's job; an agent must not spawn itself. Registered in the **user-global**
MCP config; targets the repo at its launch cwd.

---

## 17. The `/task` skill — the finalization loop

Extends the `work`-style milestone loop so each iteration **provisions the next
fire** (conditional on a `.tasks/` store / the `tasks_*` tools being present —
otherwise it just emits the handoff block and degrades gracefully):

- **Next up** → usually nothing (the lane's `default` runs `/work` next). Enqueue
  an explicit step only for a specific model/provider/prompt.
- **Open threads needing a human** (a design question, missing creds, a sign-off,
  an external action) → `tasks_block` a **manual gate** → *this* lane pauses,
  siblings continue.
- **Independent workstreams** discovered → `tasks_fork` a sibling lane.
- **Parallel-safe lane construction (§25)** — fork only independent, disjoint
  file scopes into isolated lanes; declare shared resources as `mutex` tags;
  overlapping scopes stay in one lane (serial by construction). Durable field
  notes go to `tasks_note`, never a copied working-memory file (§24).
- **Per-task allocation** — choose `provider` / `model` / `profile` / `runner` /
  `isolation` by task nature (architecture → opus/inplace; scoped mechanical →
  sonnet/worktree; a remote build → an ssh runner; work-repo → the `work` profile).
- Keep PLAN and the lane tree consistent — the tree is the *executable projection*
  of the plan's "Next up / Open threads".

---

## 18. CLI reference

```
taskherd init [repo]                        scaffold .tasks/ + global gitignore
taskherd run  [repo]                        pick + run the next step (cron/launchd entry)
taskherd status|tree [repo]                 lanes, cursors, gates, cost totals
taskherd add   [repo] <lane> [opts] "<task>"    append a step (--type --provider --model
                                                --profile --runner --isolation --file)
taskherd block [repo] <lane> --message "…" [--file f]   append a manual gate
taskherd fork  [repo] <lane> --from <parent> [opts]     new lane (branch)
taskherd ack   [repo] <lane>                clear a gate / approve a land → merge
taskherd attach[repo] <lane>                live pty (local xterm) of a running step
taskherd pause|resume [repo]                kill-switch
taskherd gc    [repo]                       remove finished worktrees, prune
taskherd history|cost [repo]                audit log / spend
taskherd auth  login|list|logout <profile>  manage per-account profiles
taskherd serve [--port N]                   web console (optional)
taskherd alias task|th                      install a short command alias if free
taskherd doctor                             check providers, runners, auth, MCP
```

---

## 19. Distribution & packaging

- **npm:** `taskherder` (unscoped, public — decided 2026-07-04, was
  `@spliff/taskherder`), bins `taskherd` (+ `taskherder`, `taskherd-mcp`);
  `task`/`th` are **opt-in** aliases (added by the user; a `taskherd alias` helper
  is intended but unbuilt) — avoids clobbering Taskwarrior / go-task, whose
  command is `task`.
- **GitHub:** `SpliFF/taskherder`, MIT.
- **Runtime deps:** minimal — Node built-ins for the core; a small WS lib + the
  MCP SDK only where needed (console, MCP server). ESM, `engines: node >=18`.
- **Install:** `npm i -g taskherder` or `npx taskherder …`.
  MCP registered user-globally; skill `/task` shipped as a bundled skill.
- **Platforms:** Linux + macOS. Windows optional/untested.

---

## 20. Attribution — patterns borrowed from `@yemi33/minions` (MIT)

Lifted as *patterns* (re-implemented lean), credited in `NOTICE`:

1. Worktree isolation + pool + GC (§7).
2. Per-provider permission/flag table (§8).
3. MCP "trust this server?" headless-prompt handling.
4. Cron scheduler + schedule-time template vars (§6, §8).
5. Preflight / timeout / watchdog / cooldown safety patterns (§12).

**Not adopted:** persistent daemon, web dashboard framework, 5-agent metaphor,
knowledge base, GitHub/ADO PR machinery.

---

## 21. Milestones

Each ships something runnable; each builds against this complete design.

- **M1 — Core.** File model, lanes (`command` + `manual`), scheduler + mutex,
  the **pty + events + control seam** (§13), `history`, `status`, CLI core, `init`,
  global gitignore, `pause`. *Exit:* schedule a shell-command lane with a manual
  gate; attach to it live; ack it.
- **M2 — AI + profiles.** Provider abstraction (Claude first), **profiles/auth
  isolation** (§9), session modes, **file-as-prompt**, budget + cost logging +
  timeout + max-turns (§10). *Exit:* an hourly `/work` lane under the `work`
  profile with a spend cap, cost in `history`.
- **M3 — Git isolation.** `worktree`/`inplace`/`none`, `taskherd/<lane>` branches,
  land `manual-gate`/`pr`/`leave`, worktree pool + `gc`. *Exit:* two lanes edit
  code in parallel worktrees; land via gate.
- **M4 — MCP + `/task` skill.** `tasks_*` tools, global registration, the
  finalization loop (§17). *Exit:* a `/work` run enqueues its own next step / gate.
- **M5 — Web console.** `taskherd serve`, SPA, live xterm streams, queue edit,
  gates/control, project registry (§15 core). *Exit:* answer a gate + interrupt a
  task from a phone.
- **M6 — More providers + runners.** Codex, Copilot; `docker` + `ssh` runners
  (§11). *Exit:* run a lane in a container under a separate account.
- **M7 — Graphical + advanced.** Xpra/noVNC streaming, web-SSH, worktree diff
  viewer (§15 Layer 2).
- **M8 — Publish.** npm `taskherder`, GitHub, docs, `NOTICE`.

---

## 22. Deferred / future

Cross-lane dependencies (`waitsFor`, shipped), per-lane priority/weight, the Slack
binding, full remote-git for the ssh runner, an Electron menubar wrapper, Windows
support.

---

## 23. Rules engine — the `when` precondition tree

Generalizes the auto-clearing gate (`waitsFor`, §22) into a **nestable boolean
rule tree** that decides whether a step may start this fire. A step's optional
`when` field is evaluated each tick exactly like `waitsFor`: **unmet ⇒ the step is
soft-skipped** (no gate, no `ack`, nothing persisted) and re-checked next fire,
becoming runnable the instant the world satisfies it. This is the **soft /
auto-clear** discipline — distinct from the one hard, ack-requiring `manual` gate
(§14), which is **not** folded into the tree.

**Shape.** One key per rule node — a leaf or a combinator:

```jsonc
"when": { "all": [                                  // all | any | not, nestable
  { "window": { "after": "09:00", "before": "17:00", "days": "Mon-Fri" } },
  { "not": { "dep": "build-lane:U2" } }
] }
```

- **Leaves:**
  - `window` — a **pure** time/date predicate. Fields, all optional and ANDed:
    `after`/`before` (`HH:MM` time-of-day; `after>before` = an overnight
    wraparound), `days` (weekday set — `"Mon-Fri"`, `"Sat,Sun"`, ranges wrap),
    `from`/`until` (absolute `YYYY-MM-DD` or datetime; a bare date is midnight in
    the window's tz; `until` exclusive), `tz` (`local` default | `utc`).
  - `dep` — a `waitsFor` reference (`"lane:id"` / `":id"` / `"lane"`); identical
    semantics. `waitsFor` **is** sugar for a top-level `all` of `dep` leaves.
  - `exit` (Phase 2) — the one **impure** leaf: run a probe command and compare
    its exit code. `run` (a `/bin/sh -c` string) **or** `argv` (array, no shell);
    matcher `equals` (int, default 0) | `in: [codes]` | `not: code`; optional
    `timeout` (default 30s), `cache` (TTL — reuse the last result across fires),
    `runner` (the §11 axis, tty-less), `env`. Runs in the repo root.
- **Combinators:** `all` / `any` / `not`, nestable.
- **Evaluation:** `evaluateWhen(rule, ctx) → {satisfied, unmet[]}` — pure given a
  clock + the lane set, the same shape as `evaluateWaits`, so every waiting /
  stall / status consumer extends for free. `evaluateGate(step, …)` ANDs `waitsFor`
  and `when` into the single precondition the scheduler consults.

**Rules.**
1. **Soft, fail-closed.** A malformed/unknown/aspirational rule throws at write
   time (§1) — never silently passes. An unsatisfiable window that has closed
   (`until` passed) keeps the step waiting; it never auto-runs.
2. **A `window` wait is a *scheduled* run, not a stall.** An off-hours cron fire
   that legitimately runs nothing must not read as a deadlock — only `dep`-style
   waits (which may never self-clear) count toward a stall / `NEEDS-ATTENTION`; a
   window or probe wait shows in `status` (a window with its **next-open ETA**).
3. **`manual` and `budget` stay separate** (the hard-gate and post-run cost
   disciplines); not subsumed.
4. **The `exit` probe carries a §12 safety envelope.** A probe is code the
   scheduler executes **speculatively, each fire, while the step is otherwise
   runnable** — so: it is **fail-closed** (spawn error / timeout / signal ⇒
   unsatisfied, loudly — never silently satisfied); its **timeout is mandatory**
   (default 30s, SIGTERM → SIGKILL group escalation); it **short-circuits by
   cost** (a probe runs only when the tree's outcome genuinely depends on it —
   free `window`/`dep` legs and an unmet `waitsFor` decide first, correct even
   under `any`/`not`); results are **memoized per fire** (two steps sharing a
   probe spec cost one execution) and **reused across fires** only within the
   rule's opt-in `cache` TTL; every real execution emits a **`when.probe`
   event** (code execution leaves a trail); `PAUSED` suppresses probes; only
   the read-write scheduler path executes them — **`status` never runs code to
   render**. Probes must be cheap, idempotent, read-only checks — a documented
   contract, not enforcement.

**Deferred to a later phase (loudly rejected until then):** the `file`/`http`/
`env` leaves (`http` is an SSRF surface). See `PLAN-rules.md`.

---

## 24. Worktree bootstrap — the seed manifest

A fresh worktree checks out **tracked files only** — the gitignored state real
work needs (`.env`, dependency dirs, working-memory files like `PLAN.md`) is
absent, so tests and agents fail in ways the checkout can't explain. The **seed
manifest** declares what a lane's tree needs; taskherd executes it when it
creates a pool worktree (the container phase's per-lane clones, §25, seed the
same way).

```jsonc
// .tasks/config.json (project level; lane-level `bootstrap` overrides per §5)
"bootstrap": {
  "link":     [".env", "certs/"],   // symlink → the main checkout: shared, live, read-mostly
  "copy":     ["PLAN*.md"],         // snapshot at seed time: divergeable, never synced back
  "generate": ["npm ci"]            // commands run once per fresh tree, cwd = the tree
}
```

**The verb encodes the sharing decision:**

- **`link`** — a symlink to the main checkout, for read-mostly config that must
  stay in sync (`.env`). A lane that *writes* through a link writes the shared
  file — that is the point, and the risk; use `copy` when divergence is fine.
- **`copy`** — a snapshot (globs allowed), taken with copy-on-write reflinks
  where the filesystem supports them (APFS `clonefile` via `cp -c`,
  `cp --reflink=auto` on XFS/btrfs) so even a dependency dir is cheap. A copy
  **diverges by design** and is never synced back — durable lane output belongs
  in lane notes (below), never in a copied file.
- **`generate`** — commands run in the fresh tree (dependency installs with
  native addons, codegen). Run serially, in order, after `link`/`copy`.

**Rules.**

1. **Fail loud (§1).** A `link`/`copy` source missing from the main checkout ⇒
   one loud warning (the file may legitimately not exist on this machine). A
   failed `generate` command ⇒ a **setup error**: the step parks on first
   failure (the M2 discipline) — never a silent half-seeded tree.
2. **Seed on creation.** The manifest runs when the pool worktree is created;
   `gc` + recreate re-seeds. (Hash-keyed re-generation — "re-run `npm ci` when
   `package-lock.json` changes" — is deferred.)
3. **`.tasks/` is never seeded.** The main repo's `.tasks/` is the single
   source of coordination truth, reached from any tree via `TASKHERD_REPO`
   (§16). A worktree carrying its own `.tasks/` would fork that state.
4. **The ignored-file advisory.** After seeding, top-level gitignored entries
   present in the main checkout but absent from the tree are listed in one loud
   warning pointing at the manifest — a missing `.env` becomes an actionable
   message instead of a mystery test failure. Advisory only; never blocks.

**Lane notes — the write path for shared working memory.** Gitignored
working-memory files (`PLAN.md`-style) are a semantic serialization point:
parallel lanes editing one shared plan clobber each other in ways git never
sees, and a worktree's copied snapshot silently loses its edits. So copies are
read-only by convention, and durable per-lane findings go to
**`.tasks/notes/<lane>.md`** via the MCP tool **`tasks_note`** (append-only;
also writable as a plain file). A human — or a designated serial lane —
integrates notes into the shared plan: the same discipline git applies to
branches. Parallel work, one merge point.

---

## 25. Parallel lanes — admission control

**The lane is the unit of parallelism.** Steps within a lane stay strictly
serial (the cursor); independent **lanes** may run concurrently when that is
provably safe. Off by default; when disabled (or `max ≤ 1`) the scheduler
behaves exactly as §6 describes today.

```jsonc
// .tasks/config.json
"parallel": { "max": 2 }        // absent ⇒ fully serial (today's behavior)

// lane file — optional
"parallel": false,              // this lane always takes the serial slot
"mutex": ["live-server"]        // lanes sharing a tag never run concurrently
```

**The master gate is isolation (§7).** Only a lane whose steps run isolated —
`worktree` isolation, or a `docker:`/`ssh:` runner (off-host) — is a parallel
candidate. `inplace`/`none` lanes are **exclusive**: they start only when
nothing else is running, and nothing is admitted while one runs (they share the
live checkout, ports, and databases — exactly what isolation can't prove
disjoint).

**Admission — the §6 mutex changes role.** From a whole-run lock to a brief
**admission lock**:

1. Acquire `.tasks/.lock`; read the **running set** from per-run manifests
   (`run/<lane>.json`, written at spawn: pid · isolation · runner · `mutex`
   tags), staleness-checked like the lock itself (mtime heartbeat + pid).
2. Compute runnable lanes exactly as today — gates, budgets, `waitsFor`/`when`
   (§23) first. **Admission never overrides a gate.**
3. In fair-pick order, admit the first candidate that is isolated, shares no
   `mutex` tag with the running set, respects `parallel:false` and the
   exclusivity rule, and fits under `max`.
4. Write the admitted manifest, **release the lock**, then supervise the step
   to completion (the one-shot process owns its pty, §13).

**Each fire still runs one step** — §6's grain is unchanged. What changes is
that a fire may admit *alongside* live runs instead of skipping; concurrency
arises from **overlapping one-shot fires** (cron cadence paces the ramp-up;
`serve` may tick faster).

**Rules.**

1. **Fail closed to serial.** If the running set can't be read, or a manifest
   is stale or ambiguous, **serialize** (skip admission this fire), loudly —
   never silently run concurrently (§1/§12).
2. **Resource conflicts isolation can't see are declared, not inferred.** Two
   worktree lanes can still fight over a port, one external DB, one
   rate-limited account. `mutex` tags are the escape hatch; undeclared shared
   resources are the lane author's responsibility — a documented contract
   (like §23's probe contract), not enforcement. The executor exports a
   deterministic per-lane **`TASKHERD_PORT_BASE`** so well-behaved test
   servers can pick disjoint ports by convention.
3. **Held-back is a soft wait.** A runnable lane blocked by admission shows in
   `status` with its blocker ("serialized: waiting on build-lane") — like a
   §23 window wait it never lands in NEEDS-ATTENTION.
4. **The overlap advisory.** Land conflicts still surface at land time (§7),
   but `status`/console warn when two live or runnable isolated lanes' branch
   diffs touch the same paths (`laneDiff` file lists) — steering scopes apart
   *before* the work is done. Advisory only; never blocks.
5. **Budgets multiply.** N parallel ai lanes burn caps N× faster. Per-lane
   budgets (§10) still enforce; a per-profile concurrency cap is deferred with
   the container phase.
6. **The `/task` skill navigates this at fork time (§17).** `tasks_status`
   exposes each lane's isolation / runner / `mutex` tags and live state so a
   forking agent can decide. The skill's contract: fork **independent,
   disjoint file scopes** into isolated lanes; declare shared resources as
   `mutex` tags; scopes that overlap stay in **one** lane — serial by
   construction, no analysis needed.

**Prerequisite:** §24 — parallel worktree lanes are only useful once their
trees can actually run the project.

**Deferred (loudly rejected until designed):** the full per-step `parallel`
rule tree (PLAN-parallel.md's original shape — the lane-level fields above
cover the decided scope); admit-N-per-fire; per-profile/per-host concurrency
caps; **container lanes** — a long-lived container per lane plus a `clone`
isolation value (a linked worktree's `.git` is a *file* holding a
host-absolute `gitdir:` path, so worktrees do not survive bind-mounting into
containers; the per-lane clone is the primitive that fixes it) — and the
**mcp-in-runner shim** (§16 tools inside a container) container lanes require.
