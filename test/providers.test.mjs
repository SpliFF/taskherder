import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PROVIDERS, renderInvocation, parseCost, lastJsonObject, loadProviders, resolveProvider,
} from '../src/providers.mjs';

const claude = BUILTIN_PROVIDERS.claude;

test('renderInvocation: claude renders model, permission, max-turns, cost-json and prompt-last', () => {
  const inv = renderInvocation(claude, {
    task: 'do a thing', model: 'opus', maxTurns: 20, session: { mode: 'fresh' }, repo: '/nope',
  });
  assert.equal(inv.command, 'claude');
  assert.deepEqual(inv.args.slice(-2), ['-p', 'do a thing'], 'prompt is last');
  assert.ok(inv.args.includes('--model') && inv.args.includes('opus'));
  assert.ok(inv.args.includes('--max-turns') && inv.args.includes('20'));
  assert.deepEqual(
    inv.args.slice(inv.args.indexOf('--permission-mode'), inv.args.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'bypassPermissions'],
    'permission defaults to bypassPermissions when unset (DESIGN §8)',
  );
  // Streaming JSONL for a live transcript; the final result event still carries cost (§10, §22 monitor).
  assert.ok(inv.args.includes('--output-format') && inv.args.includes('stream-json'), 'stream-json cost mode on');
  assert.ok(inv.args.includes('--verbose') && inv.args.includes('--include-partial-messages'), 'streaming requires both flags in -p mode');
  assert.equal(inv.captureCost, true);
  assert.equal(inv.permissionMode, 'bypassPermissions');
});

test('renderInvocation: session resume threads the id; continue passes -c', () => {
  const resume = renderInvocation(claude, { task: 't', session: { mode: 'resume', id: 'S1' }, repo: '/nope' });
  assert.deepEqual(
    resume.args.slice(resume.args.indexOf('--resume'), resume.args.indexOf('--resume') + 2),
    ['--resume', 'S1'],
  );
  const cont = renderInvocation(claude, { task: 't', session: { mode: 'continue' }, repo: '/nope' });
  assert.ok(cont.args.includes('-c'));
});

test('renderInvocation: an arg group with an unresolved var is dropped, not emitted literally', () => {
  const inv = renderInvocation(claude, { task: 't', repo: '/nope' }); // no model
  assert.ok(!inv.args.includes('--model'), 'modelArg omitted when no model');
  assert.ok(!inv.args.some((a) => a.includes('{model}')), 'no literal placeholder leaks');
});

test('renderInvocation: an overriding permissionMode wins over the provider default', () => {
  const inv = renderInvocation(claude, { task: 't', permissionMode: 'acceptEdits', repo: '/nope' });
  assert.ok(inv.args.includes('acceptEdits'));
  assert.ok(!inv.args.includes('bypassPermissions'));
  assert.equal(inv.permissionMode, 'acceptEdits');
});

test('renderInvocation: built-in mcpArgs key off the executor-merged {mcpConfig}', () => {
  const without = renderInvocation(claude, { task: 't', repo: '/nope' });
  assert.ok(!without.args.includes('--mcp-config'), 'no --mcp-config without a merged config');
  const withMcp = renderInvocation(claude, { task: 't', repo: '/nope', mcpConfig: '/tmp/x/run/main.mcp.json' });
  assert.ok(withMcp.args.includes('--mcp-config') && withMcp.args.includes('--strict-mcp-config'));
  assert.ok(withMcp.args.includes('/tmp/x/run/main.mcp.json'), 'the merged file path is what gets passed');
});

test('renderInvocation: a user override referencing {repo}/.mcp.json keeps the §8 documented behavior', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'th-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const override = { ...claude, mcpArgs: ['--mcp-config', '{repo}/.mcp.json', '--strict-mcp-config'] };
  const without = renderInvocation(override, { task: 't', repo: dir, mcpConfig: '/tmp/merged.json' });
  assert.ok(!without.args.includes('--mcp-config'), 'no --mcp-config while {repo}/.mcp.json is missing');
  await writeFile(path.join(dir, '.mcp.json'), '{}');
  const withMcp = renderInvocation(override, { task: 't', repo: dir, mcpConfig: '/tmp/merged.json' });
  assert.ok(withMcp.args.includes(`${dir}/.mcp.json`), 'the repo file is passed, not the merged one');
});

test('renderInvocation: a template needing a task but given none throws loudly', () => {
  assert.throws(() => renderInvocation(claude, { repo: '/nope' }), /no `task`\/`file`/);
});

test('renderInvocation: codex leads with the `exec` subcommand, prompt positional-last (M6)', () => {
  const inv = renderInvocation(BUILTIN_PROVIDERS.codex, { task: 'do it', model: 'gpt-5', repo: '/nope' });
  assert.equal(inv.command, 'codex');
  assert.equal(inv.args[0], 'exec', 'the subcommand leads, before any flags');
  assert.equal(inv.args[inv.args.length - 1], 'do it', 'the prompt is the trailing positional');
  assert.ok(inv.args.includes('--model') && inv.args.includes('gpt-5'));
  assert.ok(inv.args.includes('--sandbox') && inv.args.includes('workspace-write'));
  assert.ok(!inv.args.includes('--permission-mode'), 'codex autonomy is --sandbox, not --permission-mode');
  assert.equal(inv.captureCost, false, 'no codex-shaped cost JSON yet — cost stays null, not a silent $0');
});

test('renderInvocation: copilot uses the non-interactive -p prompt (not the §8 --acp server form) (M6)', () => {
  const inv = renderInvocation(BUILTIN_PROVIDERS.copilot, { task: 'ship it', repo: '/nope' });
  assert.equal(inv.command, 'copilot');
  assert.deepEqual(inv.args.slice(-2), ['-p', 'ship it'], 'prompt via -p, last');
  assert.ok(inv.args.includes('--allow-all-tools'));
  assert.ok(!inv.args.includes('--acp'), '--acp is a protocol server, not a one-shot prompt runner');
  assert.equal(inv.captureCost, false);
});

test('lastJsonObject: extracts the last top-level (nested) object after leading noise', () => {
  const text = 'starting run...\nfetched 3 items\n{"a":1,"b":{"c":2}}\n';
  assert.deepEqual(lastJsonObject(text), { a: 1, b: { c: 2 } });
  assert.equal(lastJsonObject('no json here'), null);
  // A brace inside a string is not a structural brace.
  assert.deepEqual(lastJsonObject('{"msg":"a } b { c"}'), { msg: 'a } b { c' });
});

test('parseCost: pulls usd, tokens and session id from a claude result object', () => {
  const text = `noise\n${JSON.stringify({ total_cost_usd: 0.0123, session_id: 'sess-9', usage: { input_tokens: 100, output_tokens: 50 } })}\n`;
  const cost = parseCost(text);
  assert.equal(cost.usd, 0.0123);
  assert.equal(cost.sessionId, 'sess-9');
  assert.equal(cost.inputTokens, 100);
  assert.equal(cost.outputTokens, 50);
});

test('parseCost: reads cost from the final result event of a stream-json run (§10/§22)', () => {
  // claude --output-format stream-json emits a JSONL stream; the FINAL event is
  // type:"result" with the cost — parseCost must find it past all the deltas.
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'opus' }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.42, session_id: 'sess-str', usage: { input_tokens: 7, output_tokens: 3 } }),
  ].join('\n') + '\n';
  const cost = parseCost(stream);
  assert.equal(cost.usd, 0.42);
  assert.equal(cost.sessionId, 'sess-str');
  assert.equal(cost.inputTokens, 7);
});

test('parseCost: unrecognisable output returns null (caller logs a stand-in)', () => {
  assert.equal(parseCost('just some terminal spew, no json'), null);
  assert.equal(parseCost('{"unrelated": true}'), null);
});

test('loadProviders: ~/.taskherd/providers.json overrides the built-in per key', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'th-home-'));
  const prev = process.env.TASKHERD_HOME;
  process.env.TASKHERD_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.TASKHERD_HOME;
    else process.env.TASKHERD_HOME = prev;
    return rm(home, { recursive: true, force: true });
  });
  await writeFile(path.join(home, 'providers.json'), JSON.stringify({ claude: { command: '/custom/claude' } }));
  const providers = await loadProviders();
  assert.equal(providers.claude.command, '/custom/claude', 'user command overrides');
  assert.deepEqual(providers.claude.promptArgs, ['-p', '{task}'], 'un-overridden keys keep the built-in value');
  await assert.rejects(() => resolveProvider('nope'), /unknown provider/);
});
