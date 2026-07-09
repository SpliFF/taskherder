// Runners — the fourth axis (DESIGN.md §11): *where* a step's process executes.
// A runner takes the inner invocation the provider rendered ({ file, args } + the
// profile's auth env) and a working directory, and returns the OUTER argv the
// executor actually spawns under its (always-local) pty. `local` is a
// pass-through; `docker`/`ssh` wrap the argv so the same pty seam (§13) streams
// a container/remote process transparently. The pty stays host-side — only what
// it runs changes.
//
// Honest complexity (DESIGN §11, flagged loudly, never silently): for non-local
// runners the worktree/repo must already exist *in the runner env* (a docker
// bind-mount, or a pre-synced remote checkout — full remote-git is a later
// refinement), and the taskherd-mcp servers can't run there (host node + host
// bin/mcp.mjs paths are absent), so an ai step's tasks_* finalization tools are
// unavailable inside the runner. Both are surfaced as warnings by wrapForRunner.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runnersFile } from './paths.mjs';

// Named runner defs from ~/.taskherd/runners.json (DESIGN §11). Empty when the
// file is absent — inline `docker:`/`ssh:` shorthands need no file.
export async function loadRunners() {
  const file = runnersFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`taskherd: malformed runners.json at ${file}: ${err.message}`);
  }
}

// Resolve a runner axis value to a normalized def { kind, ... }. Accepts:
//   null / 'local'        → { kind: 'local' }
//   'docker:<container>'  → exec into a running container
//   'ssh:<host>'          → run over ssh on a host
//   '<name>'              → a def from runners.json (kind docker|ssh)
// An unknown name / kind is a loud setup error (the lane parks), never a silent
// fall-through to local — a step asking for isolation it didn't get is exactly
// the silent-guardrail failure DESIGN §1/§12 forbid.
// A runner target (ssh host, docker container/image) is placed as a bare,
// leading-position argv element for `ssh`/`docker`. A value beginning with `-`
// would be parsed by those tools as an OPTION — e.g. `ssh:-oProxyCommand=<cmd>`
// makes ssh run <cmd> through /bin/sh to "connect", i.e. arbitrary host RCE
// outside any container. Reject a leading dash and any whitespace/control chars
// (never a legitimate host/container name) so a runner value can't inject flags.
function assertRunnerTarget(kind, field, target) {
  if (typeof target !== 'string' || target === '') {
    throw new Error(`taskherd: ${kind} runner needs a non-empty ${field} (DESIGN §11)`);
  }
  if (target.startsWith('-') || /\s/.test(target)) {
    throw new Error(
      `taskherd: invalid ${kind} ${field} ${JSON.stringify(target)} — must not start with '-' `
      + 'or contain whitespace (prevents argv option-injection into the runner) (DESIGN §11/§12)',
    );
  }
  return target;
}

export async function resolveRunner(value) {
  if (!value || value === 'local') return { kind: 'local' };

  const colon = value.indexOf(':');
  if (colon !== -1) {
    const kind = value.slice(0, colon);
    const target = value.slice(colon + 1);
    if (kind === 'docker') {
      assertRunnerTarget('docker', 'container', target);
      return { kind: 'docker', container: target, name: value };
    }
    if (kind === 'ssh') {
      assertRunnerTarget('ssh', 'host', target);
      return { kind: 'ssh', host: target, name: value };
    }
    throw new Error(
      `taskherd: unknown runner kind ${JSON.stringify(kind)} in ${JSON.stringify(value)} `
      + '(inline forms: docker:<container> | ssh:<host>) (DESIGN §11)',
    );
  }

  const runners = await loadRunners();
  const def = runners[value];
  if (!def) {
    const known = Object.keys(runners).join(', ') || '(none)';
    throw new Error(
      `taskherd: unknown runner ${JSON.stringify(value)} — use 'local', 'docker:<container>', `
      + `'ssh:<host>', or a name from ~/.taskherd/runners.json (known: ${known}) (DESIGN §11)`,
    );
  }
  if (def.kind !== 'docker' && def.kind !== 'ssh') {
    throw new Error(`taskherd: runner ${JSON.stringify(value)} needs "kind": "docker" | "ssh" in runners.json (got ${JSON.stringify(def.kind)})`);
  }
  // Named runners come from the operator's runners.json, but validate their
  // targets too — the same argv-option-injection guard, defense in depth.
  if (def.kind === 'ssh') assertRunnerTarget('ssh', 'host', def.host);
  if (def.kind === 'docker') {
    if (def.container != null) assertRunnerTarget('docker', 'container', def.container);
    if (def.image != null) assertRunnerTarget('docker', 'image', def.image);
  }
  return { name: value, ...def };
}

// POSIX single-quote escaping for a remote (ssh) command string. Wraps in single
// quotes and escapes embedded single quotes the '\'' way, so an argv element
// survives the remote shell's word-splitting verbatim.
export function shquote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// {worktree}/{repo}/{lane} template substitution for mounts and remote cwds.
function renderTemplate(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

// Wraps the inner invocation for the resolved runner. Returns the concrete spawn
// spec the executor hands to node-pty:
//   { file, args, env, cwd, warnings }
// where `env`/`cwd` are for the LOCAL pty child (the docker/ssh client, or the
// step itself under `local`). `extraEnv` is the profile's auth-env delta (§9):
//   - local  → merged onto process.env for the child (current behavior);
//   - docker → forwarded by NAME (`-e KEY`) so the *value* travels via the local
//              docker client's env, never onto the argv (which lands in
//              events.jsonl / the pty log — a secret there would leak);
//   - ssh    → NOT forwarded (the remote host authenticates as itself, §11); a
//              set profile env with an ssh runner warns rather than silently
//              dropping auth the user expected to cross.
// `baseEnv` (default process.env) are the ambient vars for TASKHERD_* injection
// on local; callers thread the same TASKHERD_REPO/LANE in that they set today.
// `tty:false` drops the docker `-t` / ssh `-tt` allocation for a caller with no
// pty behind it (the §23 `exit` probe runs under plain spawn — docker refuses
// `-t` when stdin isn't a terminal).
export function wrapForRunner(runner, {
  file, args, extraEnv = {}, cwd, worktree, repo, laneName, isAi = false, taskherdEnv = {}, tty = true,
} = {}) {
  const warnings = [];
  const extraKeys = Object.keys(extraEnv);

  // The §11 mcp-in-runner gap: a scheduled ai step under a non-local runner can't
  // reach the host-registered taskherd-mcp (host node + bin/mcp.mjs aren't in the
  // container/remote), so its tasks_* finalization tools (§16/§17) are absent.
  if (isAi && runner.kind !== 'local') {
    warnings.push(
      `FIDELITY-STANDIN: ai step on runner '${runner.name || runner.kind}' cannot reach taskherd-mcp `
      + '(host node/bin/mcp.mjs absent in the runner env) — the tasks_* finalization tools are '
      + 'unavailable inside the runner; the agent runs but cannot enqueue its own next step (DESIGN §11).',
    );
  }

  if (runner.kind === 'local') {
    return {
      file,
      args,
      cwd,
      env: { ...process.env, ...extraEnv, ...taskherdEnv },
      warnings,
    };
  }

  if (runner.kind === 'docker') {
    const dargs = [];
    let ttyEnv = { ...process.env, ...extraEnv }; // -e KEY reads values from here
    if (runner.container) {
      // Exec into a running, user-managed container. The worktree mapping is the
      // user's responsibility; use runner.workdir if given, else the container's.
      dargs.push('exec', '-i');
      if (tty) dargs.push('-t');
      if (runner.workdir) dargs.push('-w', runner.workdir);
      for (const k of extraKeys) dargs.push('-e', k);
      dargs.push(runner.container);
    } else if (runner.image) {
      // Ephemeral container with the worktree bind-mounted in. --rm so it doesn't
      // pile up; each fire is a fresh, isolated home/keychain (§11's strongest
      // multi-account isolation).
      dargs.push('run', '--rm', '-i');
      if (tty) dargs.push('-t');
      const mounts = runner.mounts && runner.mounts.length
        ? runner.mounts
        : (worktree ? [`{worktree}:${runner.workdir || '/work'}`] : []);
      for (const m of mounts) dargs.push('-v', renderTemplate(m, { worktree, repo, lane: laneName }));
      if (runner.workdir) dargs.push('-w', runner.workdir);
      for (const k of extraKeys) dargs.push('-e', k);
      if (runner.dockerArgs) dargs.push(...runner.dockerArgs);
      dargs.push(runner.image);
    } else {
      throw new Error(`taskherd: docker runner ${JSON.stringify(runner.name || 'docker')} needs a "container" or an "image" (DESIGN §11)`);
    }
    dargs.push(file, ...args);
    return {
      file: 'docker', args: dargs, cwd: repo, env: ttyEnv, warnings,
    };
  }

  if (runner.kind === 'ssh') {
    if (!runner.host) throw new Error(`taskherd: ssh runner ${JSON.stringify(runner.name || 'ssh')} needs a "host" (DESIGN §11)`);
    if (extraKeys.length) {
      warnings.push(
        `taskherd: profile env (${extraKeys.join(', ')}) is NOT forwarded over the ssh runner — `
        + 'the remote host authenticates as itself (its own home/keychain, DESIGN §11).',
      );
    }
    // Full remote-git is a later refinement (§11): the remote checkout must
    // already exist. `cwd` (runners.json, {repo}/{lane} templated) picks the
    // remote working dir; without one we cd nowhere and run in the login dir.
    const remoteCwd = runner.cwd ? renderTemplate(runner.cwd, { repo, lane: laneName, worktree }) : null;
    if (!remoteCwd) {
      warnings.push(
        `taskherd: ssh runner '${runner.name || runner.host}' has no "cwd" — running in the remote login `
        + 'dir; the host worktree is NOT synced to the remote (full remote-git is a later refinement, DESIGN §11).',
      );
    }
    const remoteParts = [];
    if (remoteCwd) remoteParts.push(`cd ${shquote(remoteCwd)} &&`);
    remoteParts.push('exec', shquote(file), ...args.map(shquote));
    const sargs = [];
    if (runner.sshArgs) sargs.push(...runner.sshArgs);
    if (tty) sargs.push('-tt'); // forces a remote pty (curses/TUI, §13); omitted for pty-less probes
    sargs.push(runner.host, remoteParts.join(' '));
    return {
      file: 'ssh', args: sargs, cwd: repo, env: { ...process.env }, warnings,
    };
  }

  throw new Error(`taskherd: unsupported runner kind ${JSON.stringify(runner.kind)} (local | docker | ssh) (DESIGN §11)`);
}

// The interactive-shell spawn spec for the web-SSH console feature (DESIGN §15
// Layer 2 — "pty over the web for a runner host"). Unlike wrapForRunner, which
// wraps a *specific step command*, this opens a bare shell under the resolved
// runner and reuses the SAME argv-wrapping seam, so `local` / `docker` / `ssh`
// all reach the serve-owned local pty identically. No auth env crosses — a web
// shell is the operator's own session, so the runner host authenticates as
// itself (§11), never a profile secret on the argv. Returns wrapForRunner's
// spawn spec plus a human `label` for the audit log. `cwd` is the shell's
// working dir (the project repo, for local; the docker/ssh client cwd otherwise).
export function shellInvocation(runner, { cwd, shell } = {}) {
  const sh = shell
    || (runner.kind === 'local' ? (process.env.SHELL || '/bin/sh') : (runner.shell || '/bin/sh'));
  const spec = wrapForRunner(runner, {
    file: sh, args: [], cwd, worktree: cwd, repo: cwd, laneName: 'shell', isAi: false,
  });
  return { ...spec, label: runner.name || runner.kind };
}

// ── graphical streaming (DESIGN §15 Layer 2, §11) ──────────────────────────
// A runner may declare a graphical server running *inside* it — an Xpra per-app
// HTML5 endpoint, or a noVNC/KasmVNC containerized-desktop endpoint (DESIGN §11:
// "graphical streaming lives most naturally inside these containers"). Shape in
// ~/.taskherd/runners.json:
//   "graphical": { "kind": "xpra" | "novnc" | "kasmvnc",
//                  "url":  "http://127.0.0.1:8080/",  // the server's HTTP(S) base,
//                                                      // reachable from the serve host
//                                                      // (e.g. a docker -p published port)
//                  "path": "vnc.html" }               // initial HTML5 client page (optional)
// The console reverse-proxies this base under an unguessable capability path and
// embeds the HTML5 client in an iframe (src/serve.mjs). The client's own assets
// and its protocol WebSocket are loaded relative to that /gfx/<session>/ prefix,
// so they flow back through the same proxy transparently.
const GRAPHICAL_KINDS = new Set(['xpra', 'novnc', 'kasmvnc']);
// Where each HTML5 client's entry page lives by default (overridable per runner).
// Xpra serves its client at the server root; noVNC/KasmVNC at vnc.html.
const DEFAULT_CLIENT_PATH = { xpra: '', novnc: 'vnc.html', kasmvnc: 'vnc.html' };

// Resolve a runner's declared graphical endpoint to a normalized descriptor, or
// null when it declares none. A null return is NOT an error — but the caller MUST
// surface it as a loud FIDELITY-STANDIN (never a silent blank frame), since a
// graphical stream needs an Xpra/noVNC server the operator stood up in the runner
// (DESIGN §1/§12: no silent capability gaps). A malformed `graphical` block IS a
// loud throw (misconfiguration must fail loud, not degrade silently).
export function graphicalEndpoint(runner) {
  const g = runner && runner.graphical;
  if (!g) return null;
  const who = JSON.stringify(runner.name || runner.kind || 'runner');
  const kind = g.kind || 'xpra';
  if (!GRAPHICAL_KINDS.has(kind)) {
    throw new Error(`taskherd: runner ${who} graphical.kind ${JSON.stringify(kind)} — use xpra | novnc | kasmvnc (DESIGN §15)`);
  }
  if (!g.url || typeof g.url !== 'string') {
    throw new Error(`taskherd: runner ${who} graphical needs a "url" — the in-runner ${kind} server's HTTP(S) base reachable from the serve host (DESIGN §15)`);
  }
  let http;
  try {
    http = new URL(g.url);
  } catch {
    throw new Error(`taskherd: runner ${who} graphical.url ${JSON.stringify(g.url)} is not a valid URL`);
  }
  if (http.protocol !== 'http:' && http.protocol !== 'https:') {
    throw new Error(`taskherd: runner ${who} graphical.url must be http(s):// (got ${JSON.stringify(http.protocol)})`);
  }
  const clientPath = (g.path != null ? String(g.path) : DEFAULT_CLIENT_PATH[kind]).replace(/^\/+/, '');
  return {
    kind,
    name: runner.name || runner.kind || 'runner',
    // A trailing slash so `new URL(remainder, httpBase)` resolves *under* the base
    // (and origin-checks keep the proxy from being aimed at another host).
    httpBase: http.href.endsWith('/') ? http.href : `${http.href}/`,
    origin: http.origin,
    wsScheme: http.protocol === 'https:' ? 'wss:' : 'ws:',
    clientPath,
  };
}
