'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

function backendHarness() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-state-'));
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
    process: { ...process, argv: ['node', 'main.cjs'] },
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
