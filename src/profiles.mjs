// Profiles — per-project auth isolation (DESIGN.md §9). A profile is a named
// auth context (personal / work / an API-key cred). Its `env` map is exported
// per spawn so each account authenticates as itself (Claude: CLAUDE_CONFIG_DIR
// points at that account's login dir, or ANTHROPIC_API_KEY selects an API cred).
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileFile, profilesDir } from './paths.mjs';

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export async function loadProfile(name) {
  const file = profileFile(name);
  if (!existsSync(file)) {
    throw new Error(
      `taskherd: no profile ${JSON.stringify(name)} at ${file} — create it or run `
      + `\`taskherd auth login ${name}\` (DESIGN §9)`,
    );
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`taskherd: malformed profile JSON at ${file}: ${err.message}`);
  }
}

// The env a profile contributes to a spawn, with ~ expanded in values. Merge
// this over process.env at spawn time (later keys win).
export function profileEnv(profile) {
  const env = {};
  for (const [k, v] of Object.entries(profile?.env || {})) env[k] = expandHome(v);
  return env;
}

export function listProfiles() {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// DESIGN §9 macOS-keychain caveat: Claude Code may keep the OAuth token in the
// per-user login keychain (shared across config dirs), which defeats file-level
// isolation via CLAUDE_CONFIG_DIR. Surface warnings so `doctor` / first use can
// flag a profile that can't *guarantee* isolation. An ANTHROPIC_API_KEY profile
// (or a container/ssh runner — §11) is the robust path.
export function isolationWarnings(profile) {
  const warnings = [];
  const env = profile?.env || {};
  const hasApiKey = 'ANTHROPIC_API_KEY' in env;
  const hasConfigDir = 'CLAUDE_CONFIG_DIR' in env;
  if (!hasApiKey && !hasConfigDir) {
    warnings.push(
      'sets neither ANTHROPIC_API_KEY nor CLAUDE_CONFIG_DIR — it inherits the ambient '
      + 'login and does NOT isolate auth (DESIGN §9).',
    );
  } else if (process.platform === 'darwin' && hasConfigDir && !hasApiKey) {
    warnings.push(
      'on macOS a CLAUDE_CONFIG_DIR-only profile may still share the login keychain '
      + 'across accounts, defeating file-level isolation — prefer an ANTHROPIC_API_KEY '
      + 'profile or a container/ssh runner for a hard guarantee (DESIGN §9).',
    );
  }
  return warnings;
}
