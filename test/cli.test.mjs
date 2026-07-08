// The CLI's global surface: -v/--version, -h/--help, the `help [command]` verb,
// a bare invocation, per-command `--help`, and the unknown-command error. These
// exercise the real binary end-to-end (spawned), so the dispatch wiring counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Run the CLI capturing stdout/stderr/exit without throwing on a non-zero exit.
async function run(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--version / -v print the package version and exit 0', async () => {
  for (const flag of ['--version', '-v']) {
    const r = await run(flag);
    assert.equal(r.code, 0, `${flag} should exit 0`);
    assert.ok(r.stdout.includes(pkg.version), `${flag} should print ${pkg.version}`);
  }
});

test('--help / -h / help / bare invocation all print the command list, exit 0', async () => {
  for (const args of [['--help'], ['-h'], ['help'], []]) {
    const r = await run(...args);
    const label = args.join(' ') || '(no args)';
    assert.equal(r.code, 0, `${label} should exit 0`);
    assert.match(r.stdout, /Usage: taskherd <command>/, `${label} should show the synopsis`);
    // A sampling of commands must be listed.
    for (const c of ['run', 'serve', 'status', 'doctor']) {
      assert.match(r.stdout, new RegExp(`\\b${c}\\b`), `${label} should list '${c}'`);
    }
  }
});

test('help <command> prints that command\'s usage', async () => {
  const r = await run('help', 'run');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /taskherd run/);
  assert.match(r.stdout, /--lane/, 'run help should mention its --lane flag');
});

test('<command> --help prints usage without executing the command', async () => {
  // `add` with no lane normally errors (exit 1); --help must short-circuit that.
  const r = await run('add', '--help');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /taskherd add/);
  assert.doesNotMatch(r.stderr, /usage/, 'it should not fall through to the arg-check error');
});

test('an unknown command errors to stderr and exits 1', async () => {
  const r = await run('frobnicate');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command 'frobnicate'/);
  assert.match(r.stderr, /taskherd help/, 'it should point at `taskherd help`');
});
