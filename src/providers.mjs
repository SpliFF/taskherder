// Provider abstraction (DESIGN.md §8). A provider is a config template that
// renders an argv; the executor (§13) wraps that argv in a pty. The built-in
// `claude` template ships here (M2 is Claude-first); `~/.taskherd/providers.json`
// overrides/extends it, and per-step `args` override anything — including the
// permission model, which is a first-class, overridable arg (§8, §12).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { providersFile } from './paths.mjs';

// DESIGN §8 flag table. Claude is the reference (M2, fully live-verified);
// codex + copilot land in M6. An unknown provider errors loudly rather than
// silently doing nothing (DESIGN §1). `leadArgs` (codex) render a subcommand
// immediately after the command, before any flags — for CLIs shaped
// `cmd <subcommand> [flags] <prompt>` rather than claude's `cmd [flags] -p`.
//
// NOT-LIVE-VERIFIED (codex, copilot): neither CLI is installed on the dev
// machine, so these templates are best-effort from DESIGN §8 + each tool's
// public non-interactive interface, exercised only at the argv-rendering level
// (test/providers.test.mjs). Override any flag in ~/.taskherd/providers.json if
// your installed version differs — that's the §8 escape hatch. Two honest gaps:
//   • Cost logging (§10) is claude-shaped (`total_cost_usd` in one result
//     object). codex/copilot emit different/ no cost JSON, so `costJson` is
//     unset — cost stays null (honest, not a silent $0) until a provider-
//     specific parser lands.
//   • DESIGN §8's copilot example uses `--acp` (an Agent Client Protocol stdio
//     SERVER — it needs a protocol client, not a prompt, so it does NOT fit the
//     one-shot pty seam). We use copilot's non-interactive `-p` shape instead;
//     wiring a real ACP client is a later milestone.
export const BUILTIN_PROVIDERS = {
  claude: {
    command: 'claude',
    promptArgs: ['-p', '{task}'],
    modelArg: ['--model', '{model}'],
    sessionArgs: { resume: ['--resume', '{id}'], continue: ['-c'] },
    permission: { flag: ['--permission-mode', '{permissionMode}'], default: 'bypassPermissions' },
    defaultArgs: ['--add-dir', '/tmp'],
    // {mcpConfig} is the executor-generated merged config (the tree's own
    // .mcp.json servers + the taskherd-mcp entry, §16) — NOT the raw
    // {repo}/.mcp.json: --strict-mcp-config would otherwise hide the tasks_*
    // tools from every scheduled run. A user override may still reference
    // {repo} the documented §8 way; both vars are supplied at render time.
    mcpArgs: ['--mcp-config', '{mcpConfig}', '--strict-mcp-config'],
    maxTurnsArg: ['--max-turns', '{maxTurns}'],
    costJson: ['--output-format', 'json'], // parsed for §10 cost logging
  },
  codex: {
    // `codex exec [flags] "<prompt>"` — the `exec` subcommand must lead, so it
    // is a leadArg (not a promptArg, which renders last). Autonomy is granted by
    // --sandbox, not a --permission-mode flag; --model is honored when set.
    command: 'codex',
    leadArgs: ['exec'],
    modelArg: ['--model', '{model}'],
    sessionArgs: { resume: ['resume', '{id}'] }, // `codex exec resume <id>` continues a session
    defaultArgs: ['--sandbox', 'workspace-write'],
    promptArgs: ['{task}'], // positional prompt, last
  },
  copilot: {
    // GitHub Copilot CLI non-interactive: `copilot -p "<prompt>" --allow-all-tools`.
    // (NOT DESIGN §8's `--acp` server form — see the header note.)
    command: 'copilot',
    promptArgs: ['-p', '{task}'],
    modelArg: ['--model', '{model}'],
    defaultArgs: ['--allow-all-tools'],
  },
};

export async function loadProviders() {
  const merged = {};
  for (const [name, def] of Object.entries(BUILTIN_PROVIDERS)) merged[name] = { ...def };
  const file = providersFile();
  if (existsSync(file)) {
    let user;
    try {
      user = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`taskherd: malformed providers.json at ${file}: ${err.message}`);
    }
    for (const [name, def] of Object.entries(user)) {
      merged[name] = { ...(merged[name] || {}), ...def }; // per-key override of the built-in
    }
  }
  return merged;
}

export async function resolveProvider(name) {
  const providers = await loadProviders();
  const provider = providers[name];
  if (!provider) {
    throw new Error(
      `taskherd: unknown provider ${JSON.stringify(name)} (known: ${Object.keys(providers).join(', ')}). `
      + 'Add it to ~/.taskherd/providers.json (DESIGN §8).',
    );
  }
  return provider;
}

// Substitute {var} placeholders in one arg group. If ANY referenced var is
// unresolved, the whole group is skipped (returns null) — a template like
// `["--model", "{model}"]` with no model simply drops rather than emitting a
// literal "{model}" onto the command line.
function renderArgs(template, vars) {
  const out = [];
  for (const arg of template) {
    let missing = false;
    const rendered = arg.replace(/\{(\w+)\}/g, (m, key) => {
      if (vars[key] == null || vars[key] === '') { missing = true; return m; }
      return String(vars[key]);
    });
    if (missing) return null;
    out.push(rendered);
  }
  return out;
}

// Renders the full argv for one ai step. Session modes (§8): fresh (default) /
// resume <id> / continue. Returns { command, args, permissionMode, captureCost }.
export function renderInvocation(provider, {
  task, model, permissionMode, maxTurns, session, repo, mcpConfig, mcp = true,
} = {}) {
  const args = [];

  // A leading subcommand (codex `exec`) renders first, before any flags/prompt —
  // some CLIs are `cmd <subcommand> [flags] <prompt>` rather than claude's flag-
  // first shape. Literal (no template vars), so it never drops.
  if (provider.leadArgs) args.push(...provider.leadArgs);

  const mode = session?.mode || 'fresh';
  if (mode === 'resume' && session?.id && provider.sessionArgs?.resume) {
    const r = renderArgs(provider.sessionArgs.resume, { id: session.id });
    if (r) args.push(...r);
  } else if (mode === 'continue' && provider.sessionArgs?.continue) {
    args.push(...provider.sessionArgs.continue);
  }

  if (model && provider.modelArg) {
    const r = renderArgs(provider.modelArg, { model });
    if (r) args.push(...r);
  }

  const pm = permissionMode || provider.permission?.default || null;
  if (pm && provider.permission?.flag) {
    const r = renderArgs(provider.permission.flag, { permissionMode: pm });
    if (r) args.push(...r);
  }

  if (maxTurns != null && provider.maxTurnsArg) {
    const r = renderArgs(provider.maxTurnsArg, { maxTurns });
    if (r) args.push(...r);
  }

  // MCP config: the built-in template references {mcpConfig} (the executor's
  // merged file); a user override may reference {repo}/.mcp.json per the §8
  // example — only rendered when that file actually exists, since passing
  // --mcp-config at a missing path would make the provider CLI error. Either
  // way renderArgs drops the whole group when its var is unresolved.
  if (mcp && provider.mcpArgs) {
    const wantsRepoFile = provider.mcpArgs.some((a) => a.includes('{repo}'));
    if (!wantsRepoFile || (repo && existsSync(path.join(repo, '.mcp.json')))) {
      const r = renderArgs(provider.mcpArgs, { repo, mcpConfig });
      if (r) args.push(...r);
    }
  }

  if (provider.costJson) args.push(...provider.costJson);
  if (provider.defaultArgs) args.push(...provider.defaultArgs);

  // The prompt goes last (claude's `-p "{task}"`). A template that needs a task
  // but has none is a hard error, not a silently-empty prompt.
  if (provider.promptArgs) {
    if (!task && provider.promptArgs.some((a) => a.includes('{task}'))) {
      throw new Error('taskherd: ai step has no `task`/`file` prompt to run (DESIGN §5)');
    }
    const r = renderArgs(provider.promptArgs, { task });
    if (r) args.push(...r);
  }

  return { command: provider.command, args, permissionMode: pm, captureCost: !!provider.costJson };
}

// Finds the last complete top-level `{...}` JSON object in `text`. Providers in
// cost-JSON mode (claude --output-format json) print a single result object; a
// pty may prepend stray bytes, so we scan for the last balanced object rather
// than JSON.parse-ing the whole capture.
export function lastJsonObject(text) {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  let last = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth += 1; } else if (c === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) { last = text.slice(start, i + 1); start = -1; }
      }
    }
  }
  if (last == null) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

// Parses a provider's cost-JSON result into { usd, inputTokens, outputTokens,
// sessionId } (DESIGN §10). Claude's shape: total_cost_usd, session_id,
// usage.{input,output}_tokens. Returns null if there's no recognisable result
// object (caller logs a FIDELITY-STANDIN so a missing cost is never silent).
export function parseCost(text) {
  const obj = lastJsonObject(text || '');
  if (!obj || typeof obj !== 'object') return null;
  const usd = obj.total_cost_usd ?? obj.cost_usd ?? null;
  const usage = obj.usage || {};
  const inputTokens = usage.input_tokens ?? null;
  const outputTokens = usage.output_tokens ?? null;
  const sessionId = obj.session_id ?? obj.sessionId ?? null;
  if (usd == null && sessionId == null && inputTokens == null) return null;
  return {
    usd: typeof usd === 'number' ? usd : null,
    inputTokens,
    outputTokens,
    sessionId,
  };
}
