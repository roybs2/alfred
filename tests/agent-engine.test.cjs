'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentEngine, BridgeBroker } = require('../desktop/agent-engine.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const calls = [];
  const events = [];
  const engine = new AgentEngine({
    runner: { run: (request) => {
      const pending = deferred();
      calls.push({ request, ...pending });
      return pending.promise;
    } },
    emit: (event) => events.push(event),
    timeoutMs: 2000,
  });
  const create = (roomId, name, provider = 'claude', cwd = '/a') => engine.createSession({ roomId, provider, cwd, name });
  return { engine, calls, events, create };
}
async function tick() { await new Promise((resolve) => setImmediate(resolve)); }
async function waitFor(check, label = 'condition', ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('managed tasks queue per session and preserve user text without replaying prior prompts', async () => {
  const { engine, calls, events, create } = setup();
  const agent = create('r', 'Writer');
  const first = engine.runTask({ sessionId: agent.id, text: 'First\nline' });
  const second = engine.runTask({ sessionId: agent.id, text: 'Second `exact`' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.text, 'First\nline');
  assert.equal(events.find((e) => e.type === 'task-started').text, 'First\nline');
  calls[0].resolve({ text: 'one', providerSessionId: 'provider-uuid' });
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].request.text, 'Second `exact`');
  assert.equal(calls[1].request.providerSessionId, 'provider-uuid');
  calls[1].resolve({ text: 'two', providerSessionId: 'provider-uuid' });
  await tick();
  assert.deepEqual(events.filter((e) => e.type === 'task-completed').map((e) => e.taskId), [first.taskId, second.taskId]);
  engine.stopAll();
});

test('room policy gates spawn, peer send is room-scoped, and context is passed verbatim with provenance', async () => {
  const { engine, calls, create } = setup();
  const a = create('r1', 'Conductor');
  const b = create('r1', 'Builder', 'codex');
  const elsewhere = create('r2', 'Remote', 'codex', '/b');
  engine.runTask({ sessionId: a.id, text: 'Lead' });
  await tick();
  const source = engine.sessions.get(a.id);
  await assert.rejects(engine.toolCall(source, 'room_send', { to: elsewhere.id, task: 'No' }), /Unknown destination/);
  await assert.rejects(engine.toolCall(source, 'room_spawn', { provider: 'codex', task: 'No' }), /disabled/);
  const result = engine.toolCall(source, 'room_send', { to: 'Builder', task: 'Exact\nTask', context: 'Exact\nContext' });
  await tick();
  assert.equal(calls.length, 2);
  assert.match(calls[1].request.text, new RegExp(a.id));
  assert(calls[1].request.text.includes('Task:\nExact\nTask\n\nContext:\nExact\nContext'));
  calls[1].resolve({ text: 'done', providerSessionId: 'child-uuid' });
  const response = await result;
  assert.equal(response.sessionId, b.id);
  assert.equal(response.sourceSessionId, a.id);
  assert.equal(response.text, 'done');
  calls[0].resolve({ text: 'lead done', providerSessionId: 'parent-uuid' });
  await tick();
  engine.stopAll();
});

test('spawn inherits the bound room directory and enforces max agents and depth', async () => {
  const { engine, calls, create } = setup();
  engine.setRoomPolicy({ roomId: 'r', allowSpawn: true, maxAgents: 2 });
  const a = create('r', 'Leader', 'claude', '/project');
  engine.runTask({ sessionId: a.id, text: 'Lead' });
  await tick();
  const spawned = engine.toolCall(engine.sessions.get(a.id), 'room_spawn', { provider: 'codex', task: 'Build', name: 'Build agent' });
  await tick();
  assert.equal(calls[1].request.cwd, '/project');
  await assert.rejects(engine.toolCall(engine.sessions.get(a.id), 'room_spawn', { provider: 'codex', task: 'More' }), /limit/);
  calls[1].resolve({ text: 'built', providerSessionId: 'child' });
  const response = await spawned;
  assert.equal(response.name, 'Build agent');
  assert.equal(engine.getRoomSessions('r').length, 2);
  calls[0].resolve({ text: 'done', providerSessionId: 'parent' });
  await tick();
  engine.stopAll();
});

test('dependency cycles fail before queueing and stopping a source cancels its child work', async () => {
  const { engine, calls, events, create } = setup();
  const a = create('r', 'A');
  const b = create('r', 'B');
  engine.runTask({ sessionId: a.id, text: 'Lead' });
  await tick();
  const sent = engine.toolCall(engine.sessions.get(a.id), 'room_send', { to: b.id, task: 'Child' });
  await tick();
  await assert.rejects(engine.toolCall(engine.sessions.get(b.id), 'room_send', { to: a.id, task: 'Cycle' }), /cycle/);
  assert.equal(engine.sessions.get(a.id).queue.length, 0);
  engine.stopSession(a.id);
  await assert.rejects(sent, /Source task cancelled/);
  assert.equal(calls[1].request.signal.aborted, true);
  assert(events.some((e) => e.type === 'task-failed' && e.sessionId === b.id));
  engine.stopAll();
});

test('stopping a session cancels queued tasks and old capability tokens cannot authorize later tasks', async () => {
  const { engine, calls, create } = setup();
  const a = create('r', 'A');
  engine.runTask({ sessionId: a.id, text: 'one' });
  engine.runTask({ sessionId: a.id, text: 'two' });
  await tick();
  const oldToken = engine.sessions.get(a.id).token;
  assert.equal(engine.verifyToken(oldToken)?.id, a.id);
  engine.stopSession(a.id);
  assert.equal(calls[0].request.signal.aborted, true);
  assert.equal(engine.verifyToken(oldToken), null);
  assert.equal(engine.sessions.has(a.id), false);
  const replacement = create('r', 'New', 'claude', '/new');
  assert.equal(replacement.status, 'idle');
  engine.stopAll();
});

test('loopback bridge authenticates a live task and rejects wrong or stale tokens', async (t) => {
  const { engine, calls, create } = setup();
  const broker = new BridgeBroker(engine);
  engine.setBridge(broker);
  t.after(() => engine.stopAll());
  const a = create('r', 'A');
  const b = create('r', 'B');
  engine.runTask({ sessionId: a.id, text: 'Lead' });
  await tick();
  const token = engine.sessions.get(a.id).token;
  const { port } = await broker.start();
  const request = (credential, args) => fetch(`http://127.0.0.1:${port}/tool`, {
    method: 'POST', headers: { 'x-agent-rooms-token': credential, 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'room_send', args }),
  });
  assert.equal((await request('bad', { to: b.id, task: 'No' })).status, 403);
  const pending = request(token, { to: b.id, task: 'Okay' });
  await waitFor(() => calls.length === 2, 'delegated task');
  calls[1].resolve({ text: 'result', providerSessionId: 'child' });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.text, 'result');
  calls[0].resolve({ text: 'done', providerSessionId: 'parent' });
  await tick();
  assert.equal((await request(token, { to: b.id, task: 'Late' })).status, 403);
  engine.stopAll();
});

const http = require('node:http');
const { cliRunner } = require('../desktop/agent-runner.cjs');

test('closing the broker drops long-lived tool connections so the process can exit', async (t) => {
  const { engine, calls, create } = setup();
  const broker = new BridgeBroker(engine);
  engine.setBridge(broker);
  t.after(() => engine.stopAll());
  const a = create('r', 'A');
  const b = create('r', 'B');
  engine.runTask({ sessionId: a.id, text: 'Lead' });
  await waitFor(() => calls.length === 1, 'lead task');
  const { port } = await broker.start();
  const pending = fetch(`http://127.0.0.1:${port}/tool`, {
    method: 'POST', headers: { 'x-agent-rooms-token': engine.sessions.get(a.id).token, 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'room_send', args: { to: b.id, task: 'Never finishes' } }),
  }).then((r) => r.status, () => 'closed');
  await waitFor(() => calls.length === 2, 'child task');
  engine.stopAll();
  assert.equal(broker.server, null);
  assert.ok(['closed', 400].includes(await pending));
});

test('a token is re-verified after the request body is read', async (t) => {
  const { engine, calls, create } = setup();
  const broker = new BridgeBroker(engine);
  engine.setBridge(broker);
  t.after(() => engine.stopAll());
  const a = create('r', 'A');
  const b = create('r', 'B');
  engine.runTask({ sessionId: a.id, text: 'one' });
  engine.runTask({ sessionId: a.id, text: 'two' });
  await waitFor(() => calls.length === 1, 'first task');
  const { port } = await broker.start();
  const staleToken = engine.sessions.get(a.id).token;
  const body = JSON.stringify({ tool: 'room_send', args: { to: b.id, task: 'Late' } });
  let headersSent;
  const headersFlushed = new Promise((resolve) => { headersSent = resolve; });
  const status = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/tool', method: 'POST',
      headers: { 'x-agent-rooms-token': staleToken, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.flushHeaders();
    req.write(body.slice(0, 5));
    setTimeout(() => headersSent(req), 50);
  });
  const req = await headersFlushed;
  // Task one finishes and task two starts while the request body is still in flight.
  calls[0].resolve({ text: 'done', providerSessionId: 'p' });
  await waitFor(() => calls.length === 2, 'second task');
  req.end(body.slice(5));
  assert.equal(await status, 403);
  assert.equal(calls.length, 2);
});

test('a task stopped while the broker is starting never reaches the runner', async () => {
  const { engine, calls, create } = setup();
  let release;
  engine.setBridge({ start: () => new Promise((resolve) => { release = () => resolve({ port: 1 }); }), close() {} });
  const a = create('r', 'A');
  const { taskId } = engine.runTask({ sessionId: a.id, text: 'one' });
  await waitFor(() => release, 'bridge start');
  const task = engine.sessions.get(a.id).active;
  assert.equal(task.id, taskId);
  engine.stopSession(a.id);
  release();
  await assert.rejects(task.promise, /stopped/);
  await tick();
  assert.equal(calls.length, 0);
});

test('parallel sends to the same target keep the dependency edge until all finish', async () => {
  const { engine, calls, create } = setup();
  const a = create('r', 'A');
  const b = create('r', 'B');
  engine.runTask({ sessionId: a.id, text: 'Lead' });
  await tick();
  const source = engine.sessions.get(a.id);
  const first = engine.toolCall(source, 'room_send', { to: b.id, task: 'one' });
  const second = engine.toolCall(source, 'room_send', { to: b.id, task: 'two' });
  await tick();
  calls[1].resolve({ text: 'one done', providerSessionId: 'b' });
  await first;
  await waitFor(() => calls.length === 3, 'second child task');
  await assert.rejects(engine.toolCall(engine.sessions.get(b.id), 'room_send', { to: a.id, task: 'Cycle' }), /cycle/);
  calls[2].resolve({ text: 'two done', providerSessionId: 'b' });
  await second;
  assert.equal(engine.waits.size, 0);
  engine.stopAll();
});

function fakeSpawn(record) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGTERM')); };
    record.push({ executable, args, options, child });
    return child;
  };
}
const bridgeInfo = { port: 5000, token: 't', sessionId: 'aaaa-bbbb', roomId: 'r', peers: [] };

test('runner does not spawn a provider for an already-cancelled task', async () => {
  const spawned = [];
  const runner = cliRunner({ executableFor: () => '/bin/codex', spawnProcess: fakeSpawn(spawned) });
  const controller = new AbortController();
  controller.abort(new Error('gone'));
  await assert.rejects(runner.run({ provider: 'codex', cwd: '/a', text: 'x', signal: controller.signal, bridge: bridgeInfo, onOutput() {} }), /gone/);
  assert.equal(spawned.length, 0);
});

test('codex resume places options before the session id and reads the prompt from stdin', async () => {
  const spawned = [];
  const runner = cliRunner({ executableFor: () => '/bin/codex', spawnProcess: fakeSpawn(spawned) });
  const run = runner.run({ provider: 'codex', cwd: '/a', text: 'Hi', providerSessionId: 'thread-1', bridge: bridgeInfo, onOutput() {} });
  const { args, child } = spawned[0];
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', '--json']);
  assert.deepEqual(args.slice(-2), ['thread-1', '-']);
  assert(args.includes('mcp_servers.agent_rooms_aaaa_bbbb.tool_timeout_sec=1800'));
  assert(!args.some((a) => /dangerously|bypass/.test(a)));
  child.stdout.end('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n{"type":"turn.completed"}\n');
  child.emit('close', 0, null);
  assert.deepEqual(await run, { text: 'ok', providerSessionId: 'thread-1' });
});

test('claude runner fails when the room bridge is not connected at init', async () => {
  const spawned = [];
  const runner = cliRunner({ executableFor: () => '/bin/claude', spawnProcess: fakeSpawn(spawned) });
  const run = runner.run({ provider: 'claude', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput() {} });
  const { args, child } = spawned[0];
  assert(!args.some((a) => /dangerously|bypass/.test(a)));
  child.stdout.end([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'agent_rooms_aaaa_bbbb', status: 'failed' }] }),
    JSON.stringify({ type: 'result', session_id: 's', result: 'text' }),
  ].join('\n') + '\n');
  child.emit('close', 0, null);
  await assert.rejects(run, /bridge failed/);
});

test('claude runner stops the provider at init when the room bridge is failed or missing (live 2.1.280 init shape)', async () => {
  for (const servers of [[{ name: 'agent_rooms_aaaa_bbbb', status: 'failed', source: 'dynamic' }], []]) {
    const spawned = [];
    const runner = cliRunner({ executableFor: () => '/bin/claude', spawnProcess: fakeSpawn(spawned) });
    const run = runner.run({ provider: 'claude', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput() {} });
    let killed = false;
    spawned[0].child.kill = () => { killed = true; };
    spawned[0].child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'default', mcp_servers: servers }) + '\n');
    await assert.rejects(run, /bridge failed to initialize/);
    assert.equal(killed, true, 'provider must be killed before a model turn is billed');
  }
});

test('claude runner accepts the live init shape and captures session id and final result', async () => {
  const spawned = [];
  const output = [];
  const runner = cliRunner({ executableFor: () => '/bin/claude', spawnProcess: fakeSpawn(spawned) });
  const run = runner.run({ provider: 'claude', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput: (t) => output.push(t) });
  const { child } = spawned[0];
  child.stdout.end([
    { type: 'system', subtype: 'hook_started', session_id: 'sess-1' },
    { type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'agent_rooms_aaaa_bbbb', status: 'connected', source: 'dynamic' }] },
    { type: 'stream_event', session_id: 'sess-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } } },
    { type: 'rate_limit_event', session_id: 'sess-1' },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'OK', permission_denials: [] },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  child.emit('close', 0, null);
  assert.deepEqual(await run, { text: 'OK', providerSessionId: 'sess-1' });
  assert.deepEqual(output, ['OK']);
});

test('codex runner reports the inner API error message and a required bridge startup failure', async () => {
  const spawned = [];
  const runner = cliRunner({ executableFor: () => '/bin/codex', spawnProcess: fakeSpawn(spawned) });
  const first = runner.run({ provider: 'codex', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput() {} });
  const wrapped = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Model needs newer CLI' } });
  spawned[0].child.stdout.end([
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'non-fatal warning' } },
    { type: 'turn.started' },
    { type: 'error', message: wrapped },
    { type: 'turn.failed', error: { message: wrapped } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  spawned[0].child.emit('close', 1, null);
  await assert.rejects(first, (error) => error.message === 'Model needs newer CLI');

  const second = runner.run({ provider: 'codex', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput() {} });
  spawned[1].child.stderr.write('Error: thread/start failed: required MCP servers failed to initialize: agent_rooms_aaaa_bbbb: handshaking with MCP server failed\n');
  await new Promise((resolve) => setImmediate(resolve));
  spawned[1].child.stdout.end();
  spawned[1].child.emit('close', 1, null);
  await assert.rejects(second, /Room MCP bridge failed to initialize/);
});

test('room tool pre-approval is off by default and, when enabled, names only this bridge’s room tools', () => {
  const argsFor = (provider, roomTools) => {
    const spawned = [];
    const runner = cliRunner({ executableFor: () => `/bin/${provider}`, spawnProcess: fakeSpawn(spawned) });
    runner.run({ provider, cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput() {}, roomTools }).catch(() => {});
    return spawned[0].args;
  };
  const forbidden = (args) => assert(!args.some((a) => /dangerously|bypass|yolo|skip-permissions|approval_policy|sandbox_mode|permission-mode/.test(a)));

  const claudeDefault = argsFor('claude', undefined);
  forbidden(claudeDefault);
  assert(!claudeDefault.includes('--allowedTools'));
  const claudeSend = argsFor('claude', { preapprove: true, allowSpawn: false });
  forbidden(claudeSend);
  assert.equal(claudeSend[claudeSend.indexOf('--allowedTools') + 1], 'mcp__agent_rooms_aaaa_bbbb__room_send');
  const claudeSpawn = argsFor('claude', { preapprove: true, allowSpawn: true });
  assert.equal(claudeSpawn[claudeSpawn.indexOf('--allowedTools') + 1],
    'mcp__agent_rooms_aaaa_bbbb__room_send,mcp__agent_rooms_aaaa_bbbb__room_spawn');
  assert(!claudeSpawn.some((a) => /mcp__\*|mcp__agent_rooms_aaaa_bbbb__\*|^\*$/.test(a)), 'no wildcard allow rules');

  const codexDefault = argsFor('codex', { preapprove: false, allowSpawn: false });
  forbidden(codexDefault);
  assert(codexDefault.includes('mcp_servers.agent_rooms_aaaa_bbbb.enabled_tools=["room_send"]'));
  assert(!codexDefault.some((a) => a.includes('approval_mode')));
  const codexSpawn = argsFor('codex', { preapprove: true, allowSpawn: true });
  forbidden(codexSpawn);
  assert(codexSpawn.includes('mcp_servers.agent_rooms_aaaa_bbbb.enabled_tools=["room_send","room_spawn"]'));
  assert.deepEqual(codexSpawn.filter((a) => a.includes('approval_mode')), [
    'mcp_servers.agent_rooms_aaaa_bbbb.tools.room_send.approval_mode="approve"',
    'mcp_servers.agent_rooms_aaaa_bbbb.tools.room_spawn.approval_mode="approve"',
  ]);
  assert(!codexSpawn.some((a) => /default_tools_approval_mode/.test(a)), 'no server-wide or global approval override');
});

test('room policy passes pre-approval to the runner only when the owner enables it', async () => {
  const { engine, calls, create } = setup();
  assert.throws(() => engine.setRoomPolicy({ roomId: 'r', allowSpawn: false, maxAgents: 4, preapproveRoomTools: 'yes' }), /Invalid room policy/);
  const a = create('r', 'A');
  engine.runTask({ sessionId: a.id, text: 'one' });
  await tick();
  assert.deepEqual(calls[0].request.roomTools, { allowSpawn: false, preapprove: false });
  calls[0].resolve({ text: 'ok', providerSessionId: 'p' });
  await tick();
  engine.setRoomPolicy({ roomId: 'r', allowSpawn: true, maxAgents: 4, preapproveRoomTools: true });
  engine.runTask({ sessionId: a.id, text: 'two' });
  await waitFor(() => calls.length === 2, 'second task');
  assert.deepEqual(calls[1].request.roomTools, { allowSpawn: true, preapprove: true });
  calls[1].resolve({ text: 'ok', providerSessionId: 'p' });
  await tick();
  engine.stopAll();
});
