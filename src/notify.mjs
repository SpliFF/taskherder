// The §14 `os` notification channel: a "come look" ping when a lane blocks on
// a gate (a manual step, a parked failure, a budget cap, a land gate). Fired
// from the gate.blocked event emission — that event marks the pending→blocked
// transition, so the ping is naturally once-per-gate (DESIGN §6 step 2).
//
// Config key `notify` (project config.json → user config.json): "os" (default)
// or "none". TASKHERD_NOTIFY_CMD overrides the platform command with
// `<cmd> <title> <body>` — the escape hatch for custom channels (ntfy, a
// script) and the test seam.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadProjectConfig, loadUserConfig } from './config.mjs';

// Pure argv builder, unit-testable without spawning anything.
export function notifyArgv(platform, title, body, overrideCmd = null) {
  if (overrideCmd) return [overrideCmd, title, body];
  if (platform === 'darwin') {
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return ['osascript', '-e', `display notification "${esc(body)}" with title "${esc(title)}"`];
  }
  return ['notify-send', title, body];
}

async function notifyEnabled(repo) {
  const [projectConfig, userConfig] = await Promise.all([loadProjectConfig(repo), loadUserConfig()]);
  return (projectConfig.notify ?? userConfig.notify ?? 'os') !== 'none';
}

// Fire-and-forget: the ping must never block or fail a run. A notifier that
// can't spawn logs one loud line and moves on (the gate itself is still
// visible in status / NEEDS-ATTENTION.md / the console).
export async function notifyGateBlocked(repo, event) {
  try {
    if (!(await notifyEnabled(repo))) return;
    const title = `taskherd — ${path.basename(path.resolve(repo))}/${event.lane}`;
    const body = event.reason || 'lane blocked';
    const [cmd, ...args] = notifyArgv(process.platform, title, body, process.env.TASKHERD_NOTIFY_CMD || null);
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      console.error(`taskherd: gate notification failed (${cmd}: ${err.message}) — set notify:"none" to silence`);
    });
    child.unref();
  } catch (err) {
    console.error(`taskherd: gate notification failed: ${err.message}`);
  }
}
