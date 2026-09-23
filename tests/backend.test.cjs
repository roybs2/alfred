'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

function backendHarness(extraEnv = {}, { seedUserData } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-state-'));
  if (seedUserData) seedUserData(userData);
  const handlers = new Map();
  const appHandlers = new Map();
  const terminalMocks = [];
  const readyWindow = {};
  let mainFrame;
  const sent = [];
  const webContents = {
    setWindowOpenHandler() {},
    on() {},
    send: (...args) => sent.push(args),
    session: { webRequest: { onHeadersReceived() {} } },
  };
  const app = {
    whenReady: () => Promise.resolve(),
    getPath: () => userData,
    setPath() {},
    on: (name, fn) => appHandlers.set(name, fn),
    quit() {},
  };
  const electron = {
    app,
    BrowserWindow: class {
      constructor() {
        this.webContents = webContents;
        webContents.mainFrame = mainFrame = {
          url: pathToFileURL(path.resolve(__dirname, '..', 'dist', 'index.html')).href,
        };
      }
      loadFile() {}
      loadURL() {}
      on(name, fn) {
        readyWindow[name] = fn;
      }
      isDestroyed() {
        return false;
      }
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  };
  const fakePty = {
    spawn: (executable, args, options) => {
      const terminal = {
        executable,
        args,
        options,
        killed: false,
        writes: [],
        onData(fn) {
          this.data = fn;
        },
        onExit(fn) {
          this.exit = fn;
        },
        write(data) {
          this.writes.push(data);
        },
        resize(cols, rows) {
          this.dimensions = [cols, rows];
        },
        kill() {
          this.killed = true;
        },
      };
      terminalMocks.push(terminal);
      return terminal;
    },
  };
  const nodeRequire = require;
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
  const context = {
    require: (name) =>
      name === 'electron' ? electron : name === 'node-pty' ? fakePty : nodeRequire(name),
    __dirname: path.join(__dirname, '..', 'desktop'),
    process: {
      ...process,
      argv: ['node', 'main.cjs'],
      // Point the userData migration at a directory that never exists by default, so tests never
      // read or copy the real developer's ~/Library/Application Support/agent-rooms state.
      env: {
        ...process.env,
        AGENT_ROOMS_TEST_OLD_USERDATA: path.join(os.tmpdir(), 'agent-rooms-no-old-userdata'),
        ...extraEnv,
      },
    },
    Buffer,
    URL,
    console,
  };
  vm.runInNewContext(source, context, { filename: 'desktop/main.cjs' });
  return {
    handlers,
    appHandlers,
    terminalMocks,
    readyWindow,
    sent,
    userData,
    event: () => ({ sender: webContents, senderFrame: mainFrame }),
    invoke: (channel, ...args) =>
      handlers.get(channel)({ sender: webContents, senderFrame: mainFrame }, ...args),
    wrongSender: (channel) => handlers.get(channel)({ sender: {}, senderFrame: mainFrame }),
    wrongFrame: (channel) =>
      handlers.get(channel)({ sender: webContents, senderFrame: { url: mainFrame.url } }),
  };
}

test('IPC rejects foreign senders and subframes', async () => {
  const h = backendHarness();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => h.wrongSender('rooms:detect-agents'), /Unauthorized/);
    assert.throws(() => h.wrongFrame('rooms:detect-agents'), /Unauthorized/);
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
  }
});

test('detection lists Cursor CLI alongside Claude and Codex, and cursor passes the PTY provider allowlist', async () => {
  const h = backendHarness();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const agents = h.invoke('rooms:detect-agents');
    assert.equal(agents.map((agent) => agent.id).join(','), 'shell,claude,codex,cursor');
    const cursor = agents.find((agent) => agent.id === 'cursor');
    assert.equal(cursor.name, 'Cursor CLI');
    assert.equal(cursor.available, !!cursor.path);
    if (cursor.path) assert.equal(path.basename(cursor.path), 'cursor-agent');
    else
      assert.throws(
        () => h.invoke('rooms:create-session', { provider: 'cursor', cwd: os.tmpdir() }),
        /cursor executable was not found/,
      );
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
  }
});

test('session validation rejects unknown providers and invalid working directories', async () => {
  const h = backendHarness();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(
      () => h.invoke('rooms:create-session', { provider: 'other', cwd: os.tmpdir() }),
      /provider/,
    );
    assert.throws(
      () => h.invoke('rooms:create-session', { id: '', provider: 'shell', cwd: os.tmpdir() }),
      /session id/,
    );
    assert.throws(() =>
      h.invoke('rooms:create-session', {
        provider: 'shell',
        cwd: path.join(os.tmpdir(), 'does-not-exist-agent-rooms'),
      }),
    );
    assert.equal(h.terminalMocks.length, 0);
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
  }
});

test('terminal input validation and session lifecycle are handled in main', async (t) => {
  const h = backendHarness();
  t.after(() => fs.rmSync(h.userData, { recursive: true, force: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const agents = h.invoke('rooms:detect-agents');
  if (!agents.find((agent) => agent.id === 'shell')?.available)
    return t.skip('No shell executable available on this host');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-backend-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await h.invoke('rooms:create-session', {
    id: 'test-session',
    provider: 'shell',
    cwd,
  });
  assert.equal(result.id, 'test-session');
  assert.throws(
    () => h.invoke('rooms:write-session', { id: result.id, data: 'x'.repeat(256 * 1024 + 1) }),
    /input/,
  );
  h.invoke('rooms:write-session', { id: result.id, data: 'echo ok\n' });
  assert.deepEqual(h.terminalMocks[0].writes, ['echo ok\n']);
  h.invoke('rooms:close-session', result.id);
  assert.equal(h.terminalMocks[0].killed, true);
});

test('session cap and stale exits cannot affect a replacement session', async (t) => {
  const h = backendHarness();
  t.after(() => fs.rmSync(h.userData, { recursive: true, force: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const agents = h.invoke('rooms:detect-agents');
  if (!agents.find((agent) => agent.id === 'shell')?.available)
    return t.skip('No shell executable available on this host');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-sessions-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const first = await h.invoke('rooms:create-session', { id: 'reused', provider: 'shell', cwd });
  h.invoke('rooms:close-session', first.id);
  await h.invoke('rooms:create-session', { id: 'reused', provider: 'shell', cwd });
  const before = h.sent.filter(([channel]) => channel === 'rooms:exit').length;
  h.terminalMocks[0].exit({ exitCode: 0 });
  assert.equal(h.sent.filter(([channel]) => channel === 'rooms:exit').length, before);
  h.terminalMocks[1].exit({ exitCode: 0 });
  assert.equal(h.sent.filter(([channel]) => channel === 'rooms:exit').length, before + 1);

  const ids = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
  for (const id of ids) await h.invoke('rooms:create-session', { id, provider: 'shell', cwd });
  assert.throws(
    () => h.invoke('rooms:create-session', { id: 'overflow', provider: 'shell', cwd }),
    /Maximum/,
  );
});

test('project state round-trips and rejects values above the storage bound', async () => {
  const h = backendHarness();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const state = { project: 'example', rooms: [{ id: 'a' }] };
    h.invoke('rooms:save-state', state);
    assert.equal(JSON.stringify(h.invoke('rooms:load-state')), JSON.stringify(state));
    assert.throws(() => h.invoke('rooms:save-state', { text: 'x'.repeat(1024 * 1024) }), /1 MB/);
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
  }
});

test('persisted session/activity history round-trips valid entries and enforces bounds', async () => {
  const h = backendHarness();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const sessionHistory = Array.from({ length: 60 }, (_, i) => ({
      id: 's' + i,
      name: 'Session ' + i,
      provider: 'claude',
      kind: i % 2 === 0 ? 'managed' : 'terminal',
      createdAt: 1000 + i,
      endedAt: 2000 + i,
      finalState: 'exited',
      ...(i % 2 === 0 ? { providerSessionId: 'prov-session-' + i } : {}),
    }));
    const activityHistory = Array.from({ length: 250 }, (_, i) => ({
      id: 'a' + i,
      text: 'Activity label ' + i,
      time: 3000 + i,
      kind: 'system',
    }));
    const state = { rooms: [{ id: 'room-1', name: 'Room 1', cwd: '/tmp', sessionHistory, activityHistory }] };
    h.invoke('rooms:save-state', state);
    const loaded = h.invoke('rooms:load-state');
    const room = loaded.rooms[0];
    // Oldest dropped first: bounded arrays keep the most recently appended entries.
    assert.equal(room.sessionHistory.length, 50);
    assert.equal(room.sessionHistory[0].id, 's10');
    assert.equal(room.sessionHistory.at(-1).id, 's59');
    // Odd ids never had a providerSessionId to begin with.
    assert.equal(room.sessionHistory.find((e) => e.id === 's11').providerSessionId, undefined);
    assert.equal(room.sessionHistory.find((e) => e.id === 's58').providerSessionId, 'prov-session-58');
    assert.equal(room.activityHistory.length, 200);
    assert.equal(room.activityHistory[0].id, 'a50');
    assert.equal(room.activityHistory.at(-1).id, 'a249');
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
  }
});

test('persisted history strips entries that carry transcript/task text or unknown fields', async () => {
  const h = backendHarness();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const state = {
      rooms: [
        {
          id: 'room-1',
          sessionHistory: [
            // Valid entry.
            {
              id: 'ok',
              name: 'Fine',
              provider: 'codex',
              kind: 'managed',
              createdAt: 1,
              endedAt: 2,
              finalState: 'stopped',
            },
            // A smuggled transcript-like field must drop the whole entry.
            {
              id: 'bad',
              name: 'Bad',
              provider: 'codex',
              kind: 'managed',
              createdAt: 1,
              endedAt: 2,
              finalState: 'stopped',
              transcript: ['secret agent output'],
            },
            // Unknown final state must drop the entry.
            {
              id: 'bad2',
              name: 'Bad2',
              provider: 'codex',
              kind: 'managed',
              createdAt: 1,
              endedAt: 2,
              finalState: 'running',
            },
          ],
          activityHistory: [
            { id: 'ok', text: 'Session started.', time: 1, kind: 'system' },
            // Task-text-length activity text must drop the entry (activity labels are short).
            { id: 'bad', text: 'x'.repeat(301), time: 1, kind: 'system' },
            // Unknown kind must drop the entry.
            { id: 'bad2', text: 'Fine text', time: 1, kind: 'transcript' },
          ],
        },
      ],
    };
    h.invoke('rooms:save-state', state);
    const room = h.invoke('rooms:load-state').rooms[0];
    // Compared via JSON (rather than assert.deepEqual) because the loaded array comes back
    // from a separate vm realm inside this test harness; only its serialized shape matters.
    assert.equal(JSON.stringify(room.sessionHistory.map((e) => e.id)), JSON.stringify(['ok']));
    assert.equal(JSON.stringify(room.activityHistory.map((e) => e.id)), JSON.stringify(['ok']));
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
  }
});

test('save-state writes atomically (temp file renamed, no partial file left on disk)', async () => {
  const h = backendHarness();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    h.invoke('rooms:save-state', { rooms: [{ id: 'a' }] });
    const files = fs.readdirSync(h.userData);
    assert.deepEqual(files, ['project-state.json']);
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
  }
});

test('engine createSession accepts an opaque providerSessionId for resume and validates it', async () => {
  const { AgentEngine } = require(path.join(__dirname, '..', 'desktop', 'agent-engine.cjs'));
  const engine = new AgentEngine({ runner: { run: async () => ({}) }, emit: () => {} });
  engine.setRoomPolicy({ roomId: 'r1', allowSpawn: false, maxAgents: 4, preapproveRoomTools: false });
  const session = engine.createSession({
    roomId: 'r1',
    provider: 'claude',
    cwd: '/tmp',
    providerSessionId: 'abc-123-session',
  });
  assert.equal(session.providerSessionId, 'abc-123-session');
  assert.equal(engine.sessions.get(session.id).providerSessionId, 'abc-123-session');
  assert.throws(
    () =>
      engine.createSession({
        roomId: 'r1',
        provider: 'claude',
        cwd: '/tmp',
        providerSessionId: 'bad\nid',
      }),
    /provider session id/,
  );
  assert.throws(
    () =>
      engine.createSession({
        roomId: 'r1',
        provider: 'claude',
        cwd: '/tmp',
        providerSessionId: '',
      }),
    /provider session id/,
  );
});

test('renaming to Alfred migrates saved rooms from the old agent-rooms userData directory', async () => {
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-old-userdata-'));
  const state = { project: 'preserved', rooms: [{ id: 'kept' }] };
  fs.writeFileSync(path.join(oldDir, 'project-state.json'), JSON.stringify(state));
  const h = backendHarness({ AGENT_ROOMS_TEST_OLD_USERDATA: oldDir });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(h.invoke('rooms:load-state')), JSON.stringify(state));
    // The old file is left in place (copy, not move) and the new directory now owns its own copy.
    assert.ok(fs.existsSync(path.join(oldDir, 'project-state.json')));
    assert.ok(fs.existsSync(path.join(h.userData, 'project-state.json')));
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
    fs.rmSync(oldDir, { recursive: true, force: true });
  }
});

test('userData migration is skipped when the new directory already has saved state', async () => {
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-old-userdata-'));
  fs.writeFileSync(
    path.join(oldDir, 'project-state.json'),
    JSON.stringify({ project: 'old-should-not-win' }),
  );
  const newState = { project: 'already-here' };
  const h = backendHarness(
    { AGENT_ROOMS_TEST_OLD_USERDATA: oldDir },
    {
      seedUserData: (userData) => {
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(path.join(userData, 'project-state.json'), JSON.stringify(newState));
      },
    },
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(h.invoke('rooms:load-state')), JSON.stringify(newState));
  } finally {
    fs.rmSync(h.userData, { recursive: true, force: true });
    fs.rmSync(oldDir, { recursive: true, force: true });
  }
});
