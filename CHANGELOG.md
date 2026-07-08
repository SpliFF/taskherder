# Changelog

All notable changes to **taskherder** are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/); versioning is
[SemVer](https://semver.org/). Pre-1.0: minor versions may include breaking
changes.

## Unreleased

### Added
- **`when` rule engine — scheduled preconditions on a step (DESIGN §23).** A step
  can carry an optional **`when`** boolean rule tree that gates when it may run,
  evaluated every fire exactly like `waitsFor`: if the rule is unmet the step
  **soft-skips** (no gate, no ack) and re-checks next fire, self-clearing the
  instant the rule holds. Leaves: **`window`** (a time/date predicate — any of
  `after`/`before` `HH:MM` incl. overnight wraparound, `days` weekday sets like
  `"Mon-Fri"`, `from`/`until` absolute date bounds, `tz` `local`|`utc`) and
  **`dep`** (identical to a `waitsFor` reference). Combinators **`all`**/**`any`**/
  **`not`**, nestable. A `window` wait is a *scheduled* run, not a stall — `status`
  shows the **next-open ETA** (`waiting on: window (opens Thu … 09:00)`), and the
  scheduler never flags an off-hours lane as stalled/deadlocked. Surfaced across
  every client: `taskherd add`/`fork` gained `--after`/`--before`/`--days`/
  `--from`/`--until`/`--tz` (build one window) + raw `--when '<json>'` (full tree,
  ANDed with the flags); MCP `tasks_add`/`tasks_fork` accept a `when` object; the
  serve `add` API accepts `when`; and the **web console** shows a per-step `⏰`
  schedule chip plus the window ETA in the waiting banner. **Fail-closed:** the
  not-yet-implemented `exit`/`file`/`http`/`env` leaves and any malformed rule are
  refused **loudly at add time** (CLI exit 1, MCP `isError`, API 400) — never a
  silent skip.

## 0.1.5 — 2026-07-09

### Changed
- **Live AI transcripts in the console.** AI (Claude) steps now run in
  `--output-format stream-json` (with `--verbose --include-partial-messages`)
  instead of the buffered `--output-format json`. Previously an attached run
  showed nothing until it finished, then a single JSON blob; now the console's
  monitor pane renders a **live transcript** — assistant text as it streams, tool
  calls, rate-limit/retry notices, and a final `[done · N turns · $cost]` line.
  Cost/§10 accounting is unchanged: the final `type:"result"` event still carries
  `total_cost_usd`/`usage`/`session_id`, which the existing parser reads.
  Command/plain steps still stream byte-for-byte. (The raw pty log and the CLI
  `taskherd attach` now carry stream-json JSONL; a rendered log/CLI viewer is a
  follow-up.)

## 0.1.4 — 2026-07-08

### Added
- **Cross-lane task dependencies (`waitsFor`)** — DESIGN §22, previously deferred.
  A step can carry a stable **`id`** label and a **`waitsFor`** list of references;
  it will not run until every reference is satisfied. Reference forms:
  `"lane:id"` (a specific step in another lane), `":id"` (a step in the same lane),
  or `"lane"` (that lane's whole queue drained). A reference is satisfied when its
  target step is `done`. The wait is **soft and auto-clearing** — no manual gate,
  no ack: the lane simply holds each fire and resumes the instant the prerequisite
  lands. This replaces hand-holding a manual interlock gate ("don't ack until the
  other lane reaches X"). Surfaced everywhere: `taskherd add --id <label>
  --waits-for <lane:id>` (repeatable), MCP `tasks_add`/`tasks_fork` (`id` +
  `waitsFor`), and `taskherd status` (a `waiting` lane shows `waiting on: …`).
  **Safety:** a stall (lanes waiting while nothing can run) is surfaced loudly in
  `NEEDS-ATTENTION.md` + stderr + a `waitsFor.stalled` event, and a true
  dependency cycle is reported as a `waitsFor.deadlock` — never a silent hang.
  **Web console:** a waiting lane shows a cyan `⧗ WAITING on …` banner (no ACK —
  it self-clears), a `waiting` status dot, and per-step `#id` / `⧗ waits` chips;
  a stall or deadlock raises a live toast.
- **Step insert position.** `taskherd add` / `block`, MCP `tasks_add` / `tasks_block`,
  and the serve `add` action take an `at` directive — `next` (interpose ahead of
  the step already waiting at the cursor, so it fires on the very next fire),
  `end` (append — the default), or an explicit index. The insert point can never
  fall inside the frozen region (a step that already ran, or the live step whose
  result the executor writes back by index); an out-of-range `at` fails loudly.

### Changed
- **`block` now defaults to `at:"next"`.** A manual gate is meant to STOP the
  lane where it is raised, so it now interposes ahead of any pending cursor step
  instead of appending behind the whole queue (which let that step fire first —
  the reported bug). Pass `at:"end"` for the old append-at-tail behavior.

## 0.1.3 — 2026-07-08

### Added
- **`taskherd --version` / `-v`** prints the version.
- **Help.** `taskherd --help` / `-h`, the `taskherd help [command]` verb, and a
  bare `taskherd` print a command list with one-line summaries (or one command's
  usage); `taskherd <command> --help` shows that command's usage without running
  it. An unknown command now errors with a pointer to `taskherd help`. One shared
  table drives the command list, the per-command help, and each command's
  "called wrong" usage string, so the three can never drift.

## 0.1.2 — 2026-07-08

### Added
- **Manual per-lane runs.** `taskherd run --lane <name>` (`-l`) fires ONE step of
  a specific lane on demand instead of the fair-picked one — for iterating on a
  lane without waiting for the next cron fire. Every guardrail (pause, the
  per-repo mutex, gate/budget/retry-park) is identical to a normal fire; only the
  pick is narrowed. When the lane has nothing to run it reports why
  (blocked / idle / missing) with an `ack` hint, never a silent no-op.
- **`taskherd run --force` (`-f`)** overrides a `PAUSE` for a single manual run
  (the §12 kill-switch itself is left in place); the override is logged loudly.
- **Web console: a per-lane RUN button.** Fires the lane's next step in the serve
  process (DESIGN §3) and streams it live like a cron fire — the response never
  blocks on a long step. A paused herd offers a force-run confirm.

### Fixed
- **Web console: a failed step now surfaces its error.** A step that crashes,
  times out, or hits a provider limit (e.g. a Fable/Claude 429) parks the lane
  with a **red error banner at the top of the lane** carrying the actual message
  (distilled from the run's output), visually distinct from an intentional amber
  gate. Previously a failure rendered identically to a manual gate and the error
  text was never shown — only "exit N, see log".

## 0.1.1 — 2026-07-05

### Fixed
- **Web console: the bottom panel was always visible.** The terminal/diff/gfx
  panels were toggled via the `hidden` attribute, but a `.panel { display: flex }`
  rule overrode the user-agent `[hidden]` style — so a panel (the graphical pane,
  an empty ~78vh black iframe) rendered on load, covered the lanes, and couldn't
  be closed. Panels are now genuinely hidden until opened.
- **Web console: the lanes were clipped and the panel wasn't resizable.** Reworked
  the layout as a flex app-shell — the lanes area scrolls on its own and the bottom
  panel is a **resizable** pane (drag its top edge) instead of a fixed overlay that
  sat on top of the content.
- **Web console: lanes now flow to fill the window** (wrapping flex, ~340–460px per
  lane) instead of a centered 1080px column — more lanes per row on wide monitors,
  each kept to a legible width.
- **CLI `status` printed `undefined`** as a lane's state before its first run (now
  shows `idle`).

### Added
- **Web console: tooltips on every button.** The glyph step-tools (↑ ↓ ✎ ✕) and
  all action buttons (ACK, ATTACH, INTERRUPT, DIFF, FORK, ADD, PAUSE/RESUME, and
  the panel INT/TERM/CLOSE) now carry a `title` explaining what they do.

## 0.1.0 — 2026-07-04

First public release. Every milestone in [DESIGN.md](DESIGN.md) §21 is built and
the test suite (119 tests, `npm test`) is green.

### Added
- **Scheduler** — a cron/launchd one-shot that runs a single step per fire from
  the least-recently-run lane; mutex with a heartbeated lock, fair pick, manual
  gates, retry-once-then-park, atomic lane writes.
- **Executor / pty seam** — every step runs under a pty with output capture, an
  events stream, a control socket (input/signal/resize), timeouts with
  SIGTERM→SIGKILL escalation, and late-attach replay.
- **Step model** — five orthogonal axes: `type` (`command` / `ai` / `manual`) ×
  `provider` × `profile` × `runner` × `isolation`.
- **AI providers** — built-in `claude`, `codex`, `copilot` templates
  (`~/.taskherd/providers.json` overrides), session modes (fresh/resume/
  continue), cost/token capture.
- **Auth profiles** — per-spawn env isolation for separate accounts
  (`taskherd auth`), with a macOS-keychain caveat surfaced as a warning.
- **Budgets** — cumulative / per-day / per-run spend caps that gate a lane
  (`taskherd cost`).
- **Git isolation** — `worktree` (default for code lanes) / `inplace` / `none`;
  `taskherd/<lane>` branches, a reused worktree pool, land policies
  (`manual-gate` / `pr` / `leave`), and `taskherd gc`.
- **MCP + `/task` skill** — `taskherd-mcp` exposes `tasks_init/status/add/block/
  fork/ack` (no `tasks_run`); `taskherd install` registers it user-globally and
  links the bundled `/task` finalization-loop skill. Scheduled `ai` steps get the
  tools via a per-run merged `--mcp-config`.
- **Web console** — `taskherd serve`: token-gated HTTP+WS control plane + a
  no-build SPA (xterm.js) with live terminals, queue editing, gate/interrupt
  control, worktree **diff** review, OS notify-on-gate. Loopback by default.
- **Runners** — `local` / `docker:<ctr>` / `ssh:<host>` / named
  `~/.taskherd/runners.json` entries; the runner wraps the inner argv around the
  same local pty (docker `exec`/`run`, ssh). Secret-safe auth forwarding.
- **Diff viewer** — `taskherd diff <lane>` + the console DIFF panel: three-dot
  `base...branch` unified diff, numstat, ahead/dirty/truncation flags.
- **Web-SSH** — a serve-owned interactive pty into a runner, opt-in behind
  `serve --allow-shell` (default off), capped, audit-logged, killed-on-disconnect.
- **Graphical streaming** — a runner-declared Xpra/noVNC endpoint reverse-proxied
  under a capability path and embedded in the console, opt-in behind
  `serve --allow-gfx` (default off).
- **CLI** — `init · run · status · add · block · fork · ack · diff · attach ·
  pause · resume · gc · history · cost · auth · serve · install · doctor`.

### Security

Hardened after a pre-release review:
- The web console binds loopback by default and token-gates every API/WS route
  (192-bit CSPRNG token, timing-safe compare, 0600 storage). Static assets are a
  fixed allowlist with no path→filesystem mapping.
- `--allow-shell` (web-SSH) and `--allow-gfx` (graphical streaming) are **opt-in,
  off by default**; both are capped, audit-logged, and killed on disconnect.
- The `--allow-gfx` reverse proxy is served from a **separate origin (port)** than
  the console, so a proxied in-runner GUI's JavaScript cannot read the console
  token; the proxy is pinned to operator-declared `graphical.url` origins (no SSRF).
- Runner targets, lane names, and git `base`/revision args are validated to reject
  argv **option-injection** (a leading `-`) and path traversal at every entry point
  (CLI, MCP, and the console API).
- Responses carry `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a
  `frame-ancestors 'none'` CSP, and `Referrer-Policy: no-referrer`.

Note: **isolation is git-state isolation, not a filesystem sandbox** — only a
`docker`/`ssh` runner is a true containment boundary (see README → Safety).

### Known limitations (honest — not live-verified this release)
- `codex` / `copilot` provider templates are argv-verified only (neither CLI was
  installed to test against); cost logging is claude-shaped, so they leave cost
  `null` rather than a false `$0`.
- The `ssh` runner does not sync the worktree to the remote (the remote `cwd`
  must pre-exist), and ssh web-shell is argv-verified only.
- The web console's SPA panels are data-path-verified (real server + WS) but not
  yet exercised by clicking in a browser.
- The `pr` land policy and macOS keychain vs. `CLAUDE_CONFIG_DIR` isolation are
  designed and covered on their failure paths but not verified against a live
  remote / dual-account login.
- Windows is untested.

### Notes
- Requires Node **>=18**; Linux + macOS. `node-pty` is a native dependency (may
  build from source where no prebuilt binary is available).
- Package renamed from `@spliff/taskherder` to the unscoped `taskherder` before
  first publish.
