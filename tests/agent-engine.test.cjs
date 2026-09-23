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

test('claude runner separates text segments split by a tool call with a paragraph break (live demo: "back.Always")', async () => {
  const spawned = [];
  const output = [];
  const runner = cliRunner({ executableFor: () => '/bin/claude', spawnProcess: fakeSpawn(spawned) });
  const run = runner.run({ provider: 'claude', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput: (t) => output.push(t) });
  const ev = (event) => ({ type: 'stream_event', session_id: 's', event });
  spawned[0].child.stdout.end([
    { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'agent_rooms_aaaa_bbbb', status: 'connected' }] },
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Asking' } }),
    ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' Cursor.' } }),
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'room_send' } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Cursor says: hi' } }),
    { type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'Cursor says: hi' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  spawned[0].child.emit('close', 0, null);
  await run;
  assert.equal(output.join(''), 'Asking Cursor.\n\nCursor says: hi');
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

// Live Cursor CLI 2026.09.18-9a7762b stream-json shapes (see doc/adapters.md, Cursor live verification).
const cursorLive = (sid) => [
  { type: 'system', subtype: 'init', apiKeySource: 'login', cwd: '/a', session_id: sid, model: 'Auto', permissionMode: 'default' },
  { type: 'user', message: { role: 'user', content: [] }, session_id: sid },
  { type: 'thinking', subtype: 'delta', text: 'hmm', session_id: sid, timestamp_ms: 1 },
  { type: 'thinking', subtype: 'completed', session_id: sid, timestamp_ms: 2 },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Calling' }] }, session_id: sid, timestamp_ms: 3 },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' tool.' }] }, session_id: sid, timestamp_ms: 4 },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Calling tool.' }] }, session_id: sid, model_call_id: 'm1', timestamp_ms: 5 },
  { type: 'tool_call', subtype: 'started', call_id: 'c1', session_id: sid, tool_call: { mcpToolCall: { args: { name: 'plugin-agent-rooms-agent_rooms-room_send', args: { to: 'Nobody', task: 'secret task text' }, toolName: 'room_send' } } } },
  { type: 'tool_call', subtype: 'completed', call_id: 'c1', session_id: sid, tool_call: { mcpToolCall: { result: { rejected: { reason: 'User rejected MCP: plugin-agent-rooms-agent_rooms-room_send', isReadonly: false } } } } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] }, session_id: sid, timestamp_ms: 6 },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] }, session_id: sid },
  { type: 'result', subtype: 'success', duration_ms: 7295, is_error: false, result: 'Calling tool.DONE', session_id: sid, request_id: 'r' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';

test('cursor runner uses print stream-json, a temporary plugin for the bridge, and never trust/force/approve-all flags', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-test-'));
  try {
    const spawned = [];
    const runner = cliRunner({ executableFor: () => '/bin/cursor-agent', spawnProcess: fakeSpawn(spawned), bridgeExecutable: '/bin/node', tempRoot });
    const text = '--force starts like a flag\nand spans lines';
    const first = runner.run({ provider: 'cursor', cwd: '/a', text, bridge: bridgeInfo, onOutput() {}, roomTools: { preapprove: true, allowSpawn: false } });
    const { args, options, child } = spawned[0];
    assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--plugin-dir']);
    assert.deepEqual(args.slice(-2), ['--', text], 'prompt is a single argv element after --');
    assert.equal(options.shell, false);
    assert(!args.slice(0, -1).some((a) => /^(-f|--force|--yolo|--approve-mcps|--trust|--auto-review|--sandbox)$/.test(a)));
    assert(!args.includes('--resume'));
    const pluginDir = args[args.indexOf('--plugin-dir') + 1];
    assert(pluginDir.startsWith(tempRoot) && path.basename(pluginDir) === 'agent-rooms');
    assert.equal(JSON.parse(fs.readFileSync(path.join(pluginDir, '.cursor-plugin', 'plugin.json'), 'utf8')).name, 'agent-rooms');
    const server = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp.json'), 'utf8')).mcpServers.agent_rooms;
    assert.equal(server.command, '/bin/node');
    assert.match(server.args[0], /room-mcp-bridge\.mjs$/);
    assert.equal(server.env.AGENT_ROOMS_BRIDGE_TOKEN, 't');
    assert.equal(server.env.AGENT_ROOMS_TOOLS, 'room_send', 'room_spawn hidden unless the room allows it');
    assert.equal(fs.statSync(path.join(pluginDir, 'mcp.json')).mode & 0o077, 0, 'plugin config is owner-only');
    child.stdout.end(cursorLive('chat-1'));
    child.emit('close', 0, null);
    assert.deepEqual(await first, { text: 'Calling tool.DONE', providerSessionId: 'chat-1' });
    assert.equal(fs.existsSync(pluginDir), false, 'plugin dir with the bridge token is removed on exit');
    assert.deepEqual(fs.readdirSync(tempRoot), []);

    const second = runner.run({ provider: 'cursor', cwd: '/a', text: 'Hi', providerSessionId: 'chat-1', bridge: bridgeInfo, onOutput() {} });
    const resumeArgs = spawned[1].args;
    assert.equal(resumeArgs[resumeArgs.indexOf('--resume') + 1], 'chat-1');
    assert(resumeArgs.indexOf('--resume') < resumeArgs.indexOf('--'));
    assert.equal(path.basename(resumeArgs[resumeArgs.indexOf('--plugin-dir') + 1]), 'agent-rooms', 'stable tool names across resumes');
    spawned[1].child.stdout.end(cursorLive('chat-1'));
    spawned[1].child.emit('close', 0, null);
    assert.equal((await second).providerSessionId, 'chat-1');
  } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
});

test('cursor runner streams only text deltas, reports rejected tools as denials, and maps trust and error results', async () => {
  const spawned = [];
  const output = [];
  const denials = [];
  const runner = cliRunner({ executableFor: () => '/bin/cursor-agent', spawnProcess: fakeSpawn(spawned) });
  const run = runner.run({ provider: 'cursor', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput: (t) => output.push(t), onPermissionDenied: (t) => denials.push(t) });
  spawned[0].child.stdout.end(cursorLive('chat-2'));
  spawned[0].child.emit('close', 0, null);
  await run;
  assert.deepEqual(output, ['Calling', ' tool.', '\n\nDONE'], 'no duplicate flush or final message; a paragraph break separates the pre-tool and post-tool segments');
  assert.equal(denials.length, 1);
  assert.equal(denials[0], 'room_send: User rejected MCP: plugin-agent-rooms-agent_rooms-room_send');
  assert(!denials[0].includes('secret task text'), 'denials never include tool input');

  const quiet = [];
  const short = runner.run({ provider: 'cursor', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput: (t) => quiet.push(t) });
  spawned[1].child.stdout.end([
    { type: 'system', subtype: 'init', session_id: 'c3' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] }, session_id: 'c3' },
    { type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 'c3' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  spawned[1].child.emit('close', 0, null);
  assert.deepEqual(await short, { text: 'OK', providerSessionId: 'c3' });
  assert.deepEqual(quiet, ['OK'], 'final result is shown when no deltas streamed');

  const trust = runner.run({ provider: 'cursor', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput() {} });
  spawned[2].child.stderr.write('\n⚠ Workspace Trust Required\n\n  Pass --trust, --yolo, or -f if you trust this directory\n');
  await new Promise((resolve) => setImmediate(resolve));
  spawned[2].child.stdout.end();
  spawned[2].child.emit('close', 1, null);
  await assert.rejects(trust, /has not trusted this folder.*Cursor terminal session/);

  const failed = runner.run({ provider: 'cursor', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput() {} });
  spawned[3].child.stdout.end(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Usage limit', session_id: 'c4' }) + '\n');
  spawned[3].child.emit('close', 1, null);
  await assert.rejects(failed, /Usage limit/);
});

test('claude permission denials are reported once per tool use with name and reason only (live 2.1.280 shape)', async () => {
  const spawned = [];
  const denials = [];
  const runner = cliRunner({ executableFor: () => '/bin/claude', spawnProcess: fakeSpawn(spawned) });
  const run = runner.run({ provider: 'claude', cwd: '/a', text: 'Hi', bridge: bridgeInfo, onOutput() {}, onPermissionDenied: (t) => denials.push(t) });
  const tool = 'mcp__agent_rooms_aaaa_bbbb__room_send';
  spawned[0].child.stdout.end([
    { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'agent_rooms_aaaa_bbbb', status: 'connected' }] },
    { type: 'system', subtype: 'permission_denied', tool_name: tool, tool_use_id: 'toolu_1', message: `Claude requested permissions to use ${tool}, but you haven't granted it yet.`, session_id: 's' },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'done',
      permission_denials: [{ tool_name: tool, tool_use_id: 'toolu_1', tool_input: { task: 'secret' } }, { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'secret' } }] },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  spawned[0].child.emit('close', 0, null);
  await run;
  assert.deepEqual(denials, [
    `${tool}: Claude requested permissions to use ${tool}, but you haven't granted it yet.`,
    'Bash: permission denied',
  ]);
  assert(!denials.some((d) => d.includes('secret')));
});

test('engine emits permission-denied events for the running task only, bounded in size', async () => {
  const { engine, calls, events, create } = setup();
  const a = create('r', 'A', 'cursor');
  assert.equal(engine.sessions.get(a.id).provider, 'cursor');
  const { taskId } = engine.runTask({ sessionId: a.id, text: 'go' });
  await tick();
  calls[0].request.onPermissionDenied('room_send: ' + 'x'.repeat(1000));
  calls[0].request.onPermissionDenied('');
  const denial = events.filter((e) => e.type === 'permission-denied');
  assert.equal(denial.length, 1);
  assert.deepEqual({ ...denial[0], text: undefined }, { type: 'permission-denied', sessionId: a.id, roomId: 'r', taskId, text: undefined });
  assert(denial[0].text.startsWith('room_send: x') && denial[0].text.length <= 300);
  calls[0].resolve({ text: 'ok', providerSessionId: 'p' });
  await tick();
  calls[0].request.onPermissionDenied('late: after completion');
  assert.equal(events.filter((e) => e.type === 'permission-denied').length, 1);
  engine.stopAll();
});

test('engine accepts cursor sessions and room_spawn of cursor agents; default names use the provider label', async () => {
  const { engine, calls, create } = setup();
  engine.setRoomPolicy({ roomId: 'r', allowSpawn: true, maxAgents: 4 });
  const unnamed = engine.createSession({ roomId: 'r', provider: 'cursor', cwd: '/a' });
  assert.match(unnamed.name, /^Cursor [0-9a-f]{8}$/);
  assert.throws(() => create('r', 'X', 'gemini'), /Invalid provider/);
  const lead = create('r', 'Lead');
  engine.runTask({ sessionId: lead.id, text: 'lead' });
  await tick();
  const pending = engine.toolCall(engine.sessions.get(lead.id), 'room_spawn', { provider: 'cursor', task: 'hi', name: 'Helper' });
  await waitFor(() => calls.length === 2, 'spawned cursor task');
  assert.equal(engine.getRoomSessions('r').find((s) => s.name === 'Helper').provider, 'cursor');
  calls[1].resolve({ text: 'hi back', providerSessionId: 'c' });
  assert.equal((await pending).text, 'hi back');
  await assert.rejects(engine.toolCall(engine.sessions.get(lead.id), 'room_spawn', { provider: 'gemini', task: 'x' }), /Invalid provider/);
  calls[0].resolve({ text: 'ok', providerSessionId: 'p' });
  await tick();
  engine.stopAll();
});

test('room bridge registers only the tools the runner enables', async () => {
  const path = require('node:path');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const listFor = async (tools) => {
    const env = { AGENT_ROOMS_BRIDGE_PORT: '9', AGENT_ROOMS_BRIDGE_TOKEN: 'x', AGENT_ROOMS_PEERS: '[]', PATH: process.env.PATH };
    if (tools !== undefined) env.AGENT_ROOMS_TOOLS = tools;
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'desktop', 'room-mcp-bridge.mjs')], env });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    try { return (await client.listTools()).tools.map((t) => t.name).sort(); } finally { await client.close(); }
  };
  assert.deepEqual(await listFor('room_send'), ['room_send']);
  assert.deepEqual(await listFor('room_send,room_spawn'), ['room_send', 'room_spawn']);
  assert.deepEqual(await listFor(undefined), ['room_send', 'room_spawn']);
});

test('renameSession validates input, enforces per-room case-insensitive uniqueness, and emits session-renamed', async () => {
  const { engine, events, create } = setup();
  const a = create('r', 'Writer');
  const b = create('r', 'Reviewer');
  const other = create('other-room', 'Writer');

  assert.throws(() => engine.renameSession(a.id, ''), /Invalid agent name/);
  assert.throws(() => engine.renameSession(a.id, 'x'.repeat(81)), /Invalid agent name/);
  assert.throws(() => engine.renameSession(a.id, 'bad\0name'), /Invalid agent name/);
  assert.throws(() => engine.renameSession('missing-id', 'New Name'), /Unknown managed agent session/);

  // Same room, case-insensitive collision is rejected.
  assert.throws(() => engine.renameSession(a.id, 'reviewer'), /already uses that name/);
  // A same-named session in a different room is not a collision.
  assert.doesNotThrow(() => engine.renameSession(a.id, 'Writer'));

  const result = engine.renameSession(a.id, 'Lead Writer');
  assert.deepEqual(result, { id: a.id, name: 'Lead Writer' });
  assert.equal(engine.sessions.get(a.id).name, 'Lead Writer');
  assert.equal(engine.sessions.get(other.id).name, 'Writer');
  const event = events.findLast((e) => e.type === 'session-renamed');
  assert.deepEqual(event, { type: 'session-renamed', sessionId: a.id, roomId: 'r', name: 'Lead Writer' });

  // Trims surrounding whitespace.
  engine.renameSession(b.id, '  Senior Reviewer  ');
  assert.equal(engine.sessions.get(b.id).name, 'Senior Reviewer');
});

test('room_send resolves a managed session by its current name after a rename, not the name captured at task start', async () => {
  const { engine, calls, create } = setup();
  const a = create('r', 'Source');
  const target = create('r', 'OldName');
  engine.runTask({ sessionId: a.id, text: 'Lead' });
  await tick();
  const source = engine.sessions.get(a.id);

  engine.renameSession(target.id, 'NewName');

  const call = engine.toolCall(source, 'room_send', { to: 'NewName', task: 'do it' });
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve({ text: 'done', providerSessionId: 'p2' });
  await call;

  await assert.rejects(
    engine.toolCall(source, 'room_send', { to: 'OldName', task: 'x' }),
    /Unknown destination/,
  );
  engine.stopAll();
});
