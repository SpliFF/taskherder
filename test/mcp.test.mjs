// M4 — taskherd-mcp (DESIGN §16) + fork + the executor seams that make the
// /task finalization loop (§17) work from inside a scheduled, worktree-isolated
// run: repo resolution, the merged --mcp-config, TASKHERD_REPO/LANE env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { makeRepo, makeGitRepo, gitIn } from './helpers.mjs';
import { forkLane, addStep, loadLane, saveLane, newLane } from '../src/tasks.mjs';
import { resolveTargetRepo } from '../src/mcp.mjs';
import { writeMcpConfig, runStep } from '../src/executor.mjs';
import { laneFile } from '../src/paths.mjs';

const MCP_BIN = fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url));

test('forkLane: creates a new lane with parent set; refuses duplicates, missing parents, bad names', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'main', { type: 'command', task: 'true' });

  const lane = await forkLane(repo, 'side', 'main', { stepOpts: { type: 'ai', task: 'seed', provider: 'claude' } });
  assert.equal(lane.parent, 'main');
  assert.equal(lane.steps.length, 1);
  const onDisk = await loadLane(repo, 'side');
  assert.equal(onDisk.parent, 'main');

  await assert.rejects(() => forkLane(repo, 'side', 'main'), /already exists/);
  await assert.rejects(() => forkLane(repo, 'other', 'nope'), /does not exist/);
  await assert.rejects(() => forkLane(repo, '../evil', 'main'), /invalid lane name/);
  assert.ok(!existsSync(path.join(repo, '.tasks', '..', 'evil.json')));
});

test('forkLane: asDefault seeds a recurring default instead of a queue step', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  await addStep(repo, 'main', { type: 'command', task: 'true' });
  const lane = await forkLane(repo, 'recurring', 'main', {
    stepOpts: { type: 'ai', task: '/work', provider: 'claude' },
    laneOpts: { asDefault: true },
  });
  assert.equal(lane.steps.length, 0);
  assert.equal(lane.onEmpty, 'default');
  assert.equal(lane.default.task, '/work');
  assert.equal(lane.default.status, undefined, 'transient status must not ride into the default');
});

test('resolveTargetRepo: TASKHERD_REPO env wins; walk-up finds .tasks/; a bad env path throws', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const sub = path.join(repo, 'a', 'b');
  await mkdir(sub, { recursive: true });

  assert.equal(await resolveTargetRepo({ cwd: sub, env: {} }), path.resolve(repo));
  assert.equal(await resolveTargetRepo({ cwd: '/', env: { TASKHERD_REPO: repo } }), path.resolve(repo));
  await assert.rejects(() => resolveTargetRepo({ cwd: '/', env: { TASKHERD_REPO: '/no/such/dir' } }), /not a directory/);

  const empty = await mkdtemp(path.join(os.tmpdir(), 'th-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal(await resolveTargetRepo({ cwd: empty, env: {} }), null);
});

test('resolveTargetRepo: a linked git worktree resolves to the MAIN checkout holding .tasks/', async (t) => {
  const { repo, home, cleanup } = await makeGitRepo();
  t.after(cleanup);
  const wt = path.join(home, 'wt-lane');
  await gitIn(repo, 'worktree', 'add', wt, '-b', 'taskherd/wt-lane');
  const resolved = await resolveTargetRepo({ cwd: wt, env: {} });
  assert.equal(await realpath(resolved), await realpath(repo));
});

test('writeMcpConfig: merges the tree\'s .mcp.json with the taskherd entry; the tree\'s own taskherd wins; malformed throws', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'th-wt-'));
  t.after(() => rm(workdir, { recursive: true, force: true }));

  // No tree .mcp.json: just the taskherd entry, env targeting the MAIN repo.
  const lane = newLane('main');
  const file = await writeMcpConfig(repo, lane, workdir);
  assert.equal(file, path.join(repo, '.tasks', 'run', 'main.mcp.json'));
  const cfg = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(cfg.mcpServers.taskherd, 'taskherd server present');
  assert.equal(cfg.mcpServers.taskherd.env.TASKHERD_REPO, path.resolve(repo));
  assert.equal(cfg.mcpServers.taskherd.env.TASKHERD_LANE, 'main');
  assert.ok(cfg.mcpServers.taskherd.args[0].endsWith('bin/mcp.mjs'));

  // Tree servers ride along; a tree-defined `taskherd` is kept (deliberate pin).
  await writeFile(path.join(workdir, '.mcp.json'), JSON.stringify({
    mcpServers: { chrome: { command: 'chrome-mcp' }, taskherd: { command: 'pinned' } },
  }));
  const cfg2 = JSON.parse(await readFile(await writeMcpConfig(repo, lane, workdir), 'utf8'));
  assert.equal(cfg2.mcpServers.chrome.command, 'chrome-mcp');
  assert.equal(cfg2.mcpServers.taskherd.command, 'pinned');

  await writeFile(path.join(workdir, '.mcp.json'), 'not json');
  await assert.rejects(() => writeMcpConfig(repo, lane, workdir), /malformed/);
});

test('runStep: exports TASKHERD_REPO/TASKHERD_LANE into the step\'s environment', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);
  const lane = newLane('envlane');
  const step = { type: 'command', run: 'echo "lane=$TASKHERD_LANE repo=$TASKHERD_REPO"', status: 'pending' };
  const result = await runStep(repo, lane, step, 0, { isolation: 'none', timeout: '30s' });
  assert.equal(result.status, 'done');
  const log = await readFile(result.logPath, 'utf8');
  assert.match(log, /lane=envlane/);
  assert.ok(log.includes(`repo=${path.resolve(repo)}`));
});

// End-to-end over the real stdio protocol: the same wire a claude session uses.
test('taskherd-mcp: §16 tool surface round-trip (no tasks_run)', async (t) => {
  const { repo, home, cleanup } = await makeRepo();
  t.after(cleanup);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    cwd: repo,
    env: { ...process.env, TASKHERD_HOME: home, TASKHERD_LANE: 'self' },
  });
  const client = new Client({ name: 'taskherd-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['tasks_ack', 'tasks_add', 'tasks_block', 'tasks_fork', 'tasks_init', 'tasks_status']);
  assert.ok(!names.includes('tasks_run'), 'deliberately no tasks_run — an agent must not spawn itself');

  // add: creates the lane + a recurring default.
  const add = await client.callTool({
    name: 'tasks_add',
    arguments: { lane: 'web', type: 'ai', task: '/work', provider: 'claude', asDefault: true },
  });
  assert.match(add.content[0].text, /set lane 'web' default/);
  const web = await loadLane(repo, 'web');
  assert.equal(web.default.task, '/work');
  assert.equal(web.onEmpty, 'default');

  // Seed the current lane with a pending step so block has something to jump.
  await client.callTool({ name: 'tasks_add', arguments: { lane: 'self', task: 'echo pending' } });

  // block: no lane given → TASKHERD_LANE from the server's env. Defaults to
  // `at:"next"`, so the gate interposes AHEAD of the pending step (§15) — the
  // reported bug was that it appended and let the pending step fire first.
  const block = await client.callTool({ name: 'tasks_block', arguments: { message: 'need a human decision' } });
  assert.match(block.content[0].text, /gated lane 'self'/);
  const self = await loadLane(repo, 'self');
  assert.equal(self.steps[0].type, 'manual', 'gate lands ahead of the pending step, not at the tail');
  assert.equal(self.steps[0].message, 'need a human decision');
  assert.equal(self.steps[1].run, 'echo pending', 'the pre-existing step is pushed back behind the gate');

  // tasks_add carries the cross-lane dependency fields end-to-end (§22): an agent
  // declares `id` on a prerequisite and `waitsFor` on the dependent step.
  await client.callTool({ name: 'tasks_add', arguments: { lane: 'grammar', type: 'command', task: 'echo u2', id: 'U2' } });
  await client.callTool({ name: 'tasks_add', arguments: { lane: 'web', type: 'ai', task: 'strict mode', provider: 'claude', waitsFor: ['grammar:U2'] } });
  const grammar = await loadLane(repo, 'grammar');
  assert.equal(grammar.steps[0].id, 'U2');
  const webLane = await loadLane(repo, 'web');
  assert.deepEqual(webLane.steps.at(-1).waitsFor, ['grammar:U2']);

  // tasks_add also carries a `when` rule tree end-to-end (§23): an agent can
  // schedule a step to a time/date window, stored raw for hand-editing.
  await client.callTool({
    name: 'tasks_add',
    arguments: {
      lane: 'nightly', type: 'command', task: 'echo build',
      when: { window: { after: '09:00', before: '17:00', days: 'Mon-Fri' } },
    },
  });
  const nightly = await loadLane(repo, 'nightly');
  assert.deepEqual(nightly.steps.at(-1).when, { window: { after: '09:00', before: '17:00', days: 'Mon-Fri' } });

  // The §23 Phase-2 `exit` probe leaf is agent-authorable too (an agent can
  // already enqueue arbitrary `command` steps, so a probe grants no new
  // privilege) — stored raw, validated at add time.
  await client.callTool({
    name: 'tasks_add',
    arguments: { lane: 'nightly', type: 'command', task: 'echo deploy', when: { exit: { run: './scripts/ready.sh', equals: 0 } } },
  });
  assert.deepEqual((await loadLane(repo, 'nightly')).steps.at(-1).when, { exit: { run: './scripts/ready.sh', equals: 0 } });

  // An unimplemented leaf is refused LOUDLY at add time, not silently skipped
  // (DESIGN §1/§23) — surfaced to the agent as isError text.
  const badWhen = await client.callTool({
    name: 'tasks_add',
    arguments: { lane: 'nightly', type: 'command', task: 'echo x', when: { http: { url: 'http://x/health' } } },
  });
  assert.equal(badWhen.isError, true);
  assert.match(badWhen.content[0].text, /not implemented yet/);
  assert.equal((await loadLane(repo, 'nightly')).steps.length, 2, 'the refused step is not persisted');

  // fork: sibling lane with parent + seed step.
  const fork = await client.callTool({
    name: 'tasks_fork',
    arguments: { name: 'web-experiment', from: 'web', type: 'ai', task: 'try the new layout', provider: 'claude' },
  });
  assert.match(fork.content[0].text, /forked lane 'web-experiment' from 'web'/);
  const forked = await loadLane(repo, 'web-experiment');
  assert.equal(forked.parent, 'web');
  assert.equal(forked.steps.length, 1);

  // status: renders every lane just like the CLI.
  const status = await client.callTool({ name: 'tasks_status', arguments: {} });
  for (const name of ['web', 'self', 'web-experiment']) {
    assert.ok(status.content[0].text.includes(name), `status mentions ${name}`);
  }

  // ack: clears a blocked gate through the same ackLane the CLI uses.
  const gated = await loadLane(repo, 'self');
  gated.steps[0].status = 'blocked';
  gated.status = 'blocked';
  await saveLane(repo, gated);
  const ack = await client.callTool({ name: 'tasks_ack', arguments: { lane: 'self' } });
  assert.match(ack.content[0].text, /acked manual gate on 'self'/);
  assert.equal((await loadLane(repo, 'self')).cursor, 1);

  // Errors surface as isError text, not protocol faults.
  const bad = await client.callTool({ name: 'tasks_add', arguments: { lane: '../evil', task: 'x' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /invalid lane name/);
  assert.ok(!existsSync(laneFile(repo, 'evil')));
});
