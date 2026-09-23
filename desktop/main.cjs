'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { AgentEngine, BridgeBroker } = require(path.join(__dirname, 'agent-engine.cjs'));
const { cliRunner } = require(path.join(__dirname, 'agent-runner.cjs'));

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_SESSIONS = 12;
// Persisted history bounds (per room). Session history is metadata only — never terminal output or
// agent transcripts. Activity history is short lifecycle/delegation/permission-denied labels only —
// never agent output or task text (see decisions.md). Oldest entries are dropped first.
const MAX_SESSION_HISTORY = 50;
const MAX_ACTIVITY_HISTORY = 200;
const MAX_HISTORY_TEXT = 300;
const MAX_HISTORY_NAME = 200;
const MAX_PROVIDER_SESSION_ID = 400;
const SESSION_FINAL_STATES = ['exited', 'stopped', 'failed', 'completed'];
const ACTIVITY_KINDS = ['system', 'user', 'warning'];
// Keyboard-shortcut settings (a top-level, non-per-room field: settings.shortcuts) — the exact
// action ids the renderer knows about (see SHORTCUT_ACTION_IDS in src/App.tsx). Bindings only,
// never anything else about "settings".
const SHORTCUT_ACTION_IDS = [
  'newRoom',
  'addSession',
  'closeSession',
  'nextSession',
  'prevSession',
  'focusSession1',
  'focusSession2',
  'focusSession3',
  'focusSession4',
  'focusSession5',
  'focusSession6',
  'focusSession7',
  'focusSession8',
  'focusSession9',
  'nextRoom',
  'prevRoom',
  'toggleFocusMode',
  'toggleActivityPanel',
  'openSettings',
  'focusTaskInput',
];
const MAX_COMBO_LENGTH = 40;
// e.g. "meta+shift+BracketRight" — zero or more of ctrl/alt/meta/shift, then one alphanumeric
// token (a KeyboardEvent.code fragment). Never anything else (no HTML, no arbitrary text).
const SHORTCUT_COMBO_PATTERN = /^(?:(?:ctrl|alt|meta|shift)\+)*[A-Za-z][A-Za-z0-9]*$/;
const sessions = new Map();
let mainWindow;
let pty;
const agentEngine = new AgentEngine({
  runner: cliRunner({
    executableFor: (provider) => detectAgents().find((agent) => agent.id === provider)?.path,
    environmentFor: childEnvironment,
  }),
  emit: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rooms:agent-event', event);
  },
});
agentEngine.setBridge(new BridgeBroker(agentEngine));
const isDev = process.argv.includes('--dev');
// Test-only hook so smoke tests can register synthetic managed sessions directly on the real
// engine (e.g. to exercise rooms:rename-agent-session) without launching a real provider process.
if (process.env.AGENT_ROOMS_TEST_MODE === '1') global.__ROOMS_TEST_AGENT_ENGINE__ = agentEngine;
if (process.env.AGENT_ROOMS_TEST_MODE === '1' && process.env.AGENT_ROOMS_TEST_DATA) {
  if (!path.isAbsolute(process.env.AGENT_ROOMS_TEST_DATA))
    throw new Error('AGENT_ROOMS_TEST_DATA must be an absolute path');
  app.setPath('userData', process.env.AGENT_ROOMS_TEST_DATA);
} else {
  migrateUserDataFromOldAppName();
}

// The app was previously named "agent-rooms" (package.json "name"), which Electron used to
// derive the default userData directory. Renaming to "Alfred" (via "productName") moves that
// directory, which would otherwise orphan any saved rooms/session state. If the new directory
// has no saved state yet and the old one does, copy project-state.json across so nothing is lost.
function oldUserDataDir() {
  // Test-only override so the migration path can be exercised without touching the real
  // per-user config directory.
  if (process.env.AGENT_ROOMS_TEST_OLD_USERDATA) return process.env.AGENT_ROOMS_TEST_OLD_USERDATA;
  const home = os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'agent-rooms');
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'agent-rooms');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agent-rooms');
}

function migrateUserDataFromOldAppName() {
  try {
    const newDir = app.getPath('userData');
    const newFile = path.join(newDir, 'project-state.json');
    if (fs.existsSync(newFile)) return;
    const oldDir = oldUserDataDir();
    if (path.resolve(oldDir) === path.resolve(newDir)) return;
    const oldFile = path.join(oldDir, 'project-state.json');
    if (!fs.existsSync(oldFile)) return;
    fs.mkdirSync(newDir, { recursive: true });
    fs.copyFileSync(oldFile, newFile);
  } catch {
    // Best-effort migration only; a failure here should never block app startup.
  }
}

function findExecutable(names, extraPaths = []) {
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraPaths];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of extensions) {
        const candidate = path.resolve(dir, name + ext);
        try {
          if (
            fs.statSync(candidate).isFile() &&
            (process.platform === 'win32' ||
              fs.accessSync(candidate, fs.constants.X_OK) === undefined)
          )
            return candidate;
        } catch {}
      }
    }
  }
  return null;
}

function detectAgents() {
  const home = os.homedir();
  const locations =
    process.platform === 'darwin'
      ? [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
      : process.platform === 'win32'
        ? [path.join(home, 'AppData', 'Local', 'Programs')]
        : [path.join(home, '.local', 'bin'), '/usr/local/bin'];
  const shellNames =
    process.platform === 'win32' ? ['pwsh', 'powershell', 'cmd'] : ['zsh', 'bash', 'sh'];
  const shellPath = findExecutable(
    shellNames,
    process.platform === 'win32' ? [] : ['/bin', '/usr/bin'],
  );
  const claudePath = findExecutable(['claude'], locations);
  const codexPath = findExecutable(['codex'], locations);
  // Cursor's installer also creates a generic `agent` alias; only the unambiguous `cursor-agent` name is trusted.
  const cursorPath = findExecutable(['cursor-agent'], locations);
  return [
    { id: 'shell', name: 'Shell', available: !!shellPath, path: shellPath },
    { id: 'claude', name: 'Claude Code', available: !!claudePath, path: claudePath },
    { id: 'codex', name: 'Codex', available: !!codexPath, path: codexPath },
    { id: 'cursor', name: 'Cursor CLI', available: !!cursorPath, path: cursorPath },
  ];
}

function childEnvironment(agentPath) {
  const home = os.homedir();
  const common =
    process.platform === 'darwin'
      ? [
          path.join(home, '.local', 'bin'),
          path.join(home, '.npm-global', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ]
      : process.platform === 'win32'
        ? []
        : [
            path.join(home, '.local', 'bin'),
            path.join(home, '.npm-global', 'bin'),
            '/usr/local/bin',
          ];
  const dirs = [
    path.dirname(agentPath),
    ...common,
    ...(process.env.PATH || '').split(path.delimiter),
  ];
  return {
    ...process.env,
    PATH: [...new Set(dirs.filter(Boolean))].join(path.delimiter),
    TERM: 'xterm-256color',
  };
}

function validSender(event) {
  const frame = event.senderFrame;
  if (!frame || !mainWindow || event.sender !== mainWindow.webContents) return false;
  if (frame !== mainWindow.webContents.mainFrame) return false;
  try {
    const u = new URL(frame.url);
    if (u.protocol === 'file:')
      return (
        path.resolve(decodeURIComponent(u.pathname)) ===
        path.resolve(path.join(__dirname, '..', 'dist', 'index.html'))
      );
    return isDev && u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === '5173';
  } catch {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!validSender(event)) throw new Error('Unauthorized IPC sender');
    return fn(...args);
  });
}

function stringArg(value, label, max = 4096) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0'))
    throw new TypeError(`Invalid ${label}`);
  return value;
}
function dimensions(value, label) {
  if (!Number.isInteger(value) || value < 2 || value > 500) throw new TypeError(`Invalid ${label}`);
  return value;
}
function getSession(id) {
  const item = sessions.get(stringArg(id, 'session id', 80));
  if (!item) throw new Error('Unknown terminal session');
  return item;
}
function ensurePty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

// --- Persisted history sanitization (defense in depth) ---
// The renderer decides what state shape to save; these two fields, when present on a saved room,
// are validated and bounded here regardless of what the renderer sends, so a renderer bug can
// never smuggle transcript/task text into durable storage or grow history without bound.
function safeHistoryText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}
function safeHistoryNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
function sanitizeSessionHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const allowed = ['id', 'name', 'provider', 'kind', 'createdAt', 'endedAt', 'finalState', 'providerSessionId'];
  if (Object.keys(entry).some((key) => !allowed.includes(key))) return null;
  const { id, name, provider, kind, createdAt, endedAt, finalState, providerSessionId } = entry;
  if (!safeHistoryText(id, 80) || !safeHistoryText(name, MAX_HISTORY_NAME) || !safeHistoryText(provider, 40))
    return null;
  if (kind !== 'terminal' && kind !== 'managed') return null;
  if (!safeHistoryNumber(createdAt) || !safeHistoryNumber(endedAt)) return null;
  if (!SESSION_FINAL_STATES.includes(finalState)) return null;
  if (providerSessionId !== undefined && !safeHistoryText(providerSessionId, MAX_PROVIDER_SESSION_ID))
    return null;
  const out = { id, name, provider, kind, createdAt, endedAt, finalState };
  if (providerSessionId !== undefined) out.providerSessionId = providerSessionId;
  return out;
}
function sanitizeActivityHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const allowed = ['id', 'text', 'time', 'kind'];
  if (Object.keys(entry).some((key) => !allowed.includes(key))) return null;
  const { id, text, time, kind } = entry;
  if (!safeHistoryText(id, 80) || !safeHistoryText(text, MAX_HISTORY_TEXT)) return null;
  if (!safeHistoryNumber(time)) return null;
  if (!ACTIVITY_KINDS.includes(kind)) return null;
  return { id, text, time, kind };
}
function sanitizeRoomHistory(room) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) return room;
  const out = { ...room };
  if ('sessionHistory' in out)
    out.sessionHistory = Array.isArray(out.sessionHistory)
      ? out.sessionHistory.map(sanitizeSessionHistoryEntry).filter(Boolean).slice(-MAX_SESSION_HISTORY)
      : [];
  if ('activityHistory' in out)
    out.activityHistory = Array.isArray(out.activityHistory)
      ? out.activityHistory.map(sanitizeActivityHistoryEntry).filter(Boolean).slice(-MAX_ACTIVITY_HISTORY)
      : [];
  return out;
}

// A global app setting (not per-room): only known shortcut action ids, and only combo strings
// shaped like SHORTCUT_COMBO_PATTERN — everything else (unknown keys, non-string values,
// oversized strings) is dropped rather than persisted, regardless of what the renderer sends.
function sanitizeShortcuts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const id of SHORTCUT_ACTION_IDS) {
    const combo = value[id];
    if (
      typeof combo === 'string' &&
      combo.length > 0 &&
      combo.length <= MAX_COMBO_LENGTH &&
      SHORTCUT_COMBO_PATTERN.test(combo)
    )
      out[id] = combo;
  }
  return out;
}
function sanitizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { shortcuts: sanitizeShortcuts(value.shortcuts) };
}

handle('rooms:detect-agents', () => detectAgents());
handle('rooms:choose-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});
handle('rooms:create-session', ({ id, provider, cwd, cols = 100, rows = 30 } = {}) => {
  if (!['shell', 'claude', 'codex', 'cursor'].includes(provider)) throw new TypeError('Invalid provider');
  if (id !== undefined) stringArg(id, 'session id', 80);
  if (sessions.size >= MAX_SESSIONS)
    throw new Error(`Maximum of ${MAX_SESSIONS} terminal sessions reached`);
  const workingDirectory = path.resolve(stringArg(cwd, 'working directory'));
  if (!fs.statSync(workingDirectory).isDirectory())
    throw new TypeError('Working directory must be a directory');
  const agent = detectAgents().find((item) => item.id === provider);
  if (!agent?.available || !agent.path) throw new Error(`${provider} executable was not found`);
  const sessionId = id || crypto.randomUUID();
  if (sessions.has(sessionId)) throw new Error('Session id already exists');
  const terminal = ensurePty().spawn(agent.path, [], {
    name: 'xterm-256color',
    cols: dimensions(cols, 'columns'),
    rows: dimensions(rows, 'rows'),
    cwd: workingDirectory,
    env: childEnvironment(agent.path),
  });
  const item = { terminal, subscriptions: [] };
  sessions.set(sessionId, item);
  terminal.onData((data) => {
    if (sessions.get(sessionId) === item && mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('rooms:output', { id: sessionId, data });
  });
  terminal.onExit(({ exitCode }) => {
    if (sessions.get(sessionId) !== item) return;
    sessions.delete(sessionId);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('rooms:exit', { id: sessionId, exitCode });
  });
  return { id: sessionId };
});
handle('rooms:write-session', ({ id, data } = {}) => {
  if (typeof data !== 'string' || data.length > 256 * 1024)
    throw new TypeError('Invalid terminal input');
  getSession(id).terminal.write(data);
});
handle('rooms:resize-session', ({ id, cols, rows } = {}) =>
  getSession(id).terminal.resize(dimensions(cols, 'columns'), dimensions(rows, 'rows')),
);
handle('rooms:close-session', (id) => {
  const item = sessions.get(stringArg(id, 'session id', 80));
  if (item) {
    sessions.delete(id);
    item.terminal.kill();
  }
});
handle('rooms:create-agent-session', ({ roomId, provider, cwd, name, providerSessionId } = {}) => {
  const workingDirectory = fs.realpathSync(path.resolve(stringArg(cwd, 'working directory')));
  if (!fs.statSync(workingDirectory).isDirectory())
    throw new TypeError('Working directory must be a directory');
  const agent = detectAgents().find((item) => item.id === provider);
  if (!agent?.available || !agent.path) throw new Error(`${provider} executable was not found`);
  return agentEngine.createSession({ roomId, provider, cwd: workingDirectory, name, providerSessionId });
});
handle('rooms:run-agent-task', (options) => agentEngine.runTask(options || {}));
handle('rooms:stop-agent-session', (id) => agentEngine.stopSession(id));
handle('rooms:rename-agent-session', ({ id, name } = {}) => agentEngine.renameSession(id, name));
handle('rooms:set-room-policy', (options) => agentEngine.setRoomPolicy(options || {}));
handle('rooms:load-state', () => {
  const file = path.join(app.getPath('userData'), 'project-state.json');
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_STATE_BYTES) throw new Error('Saved project state exceeds size limit');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Invalid saved project state');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
});
handle('rooms:save-state', (state) => {
  if (!state || typeof state !== 'object' || Array.isArray(state))
    throw new TypeError('State must be an object');
  let sanitized = state;
  if (Array.isArray(state.rooms)) sanitized = { ...sanitized, rooms: state.rooms.map(sanitizeRoomHistory) };
  if ('settings' in state) sanitized = { ...sanitized, settings: sanitizeSettings(state.settings) };
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES)
    throw new RangeError('Project state exceeds 1 MB');
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'project-state.json');
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, serialized, { mode: 0o600 });
  fs.renameSync(temporary, file);
});

// A custom, minimal application menu — kept only for what the OS/native menu must always own
// (Quit, Hide, Minimize, Undo/Redo, Cut/Copy/Paste, Select All: the "never hijack" combos in
// doc/tasks.md). Deliberately has no Close/"Cmd+W" item: closing the focused session is a
// renderer keyboard shortcut (see src/App.tsx), and Electron's own default menu (used whenever
// no application menu is set) *does* bind Cmd+W to closing the window, which would silently
// double-handle — and conflict with — that shortcut. Building this template instead of calling
// Menu.setApplicationMenu(null) also keeps standard editing shortcuts working in text fields.
function buildApplicationMenuTemplate() {
  const isMac = process.platform === 'darwin';
  return [
    ...(isMac
      ? [
          {
            label: app.name || 'Alfred',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        // No "Close"/Cmd+W item here on purpose — see comment above.
      ],
    },
  ];
}
if (Menu && typeof Menu.buildFromTemplate === 'function')
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate()));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const scriptPolicy = isDev ? "'self' 'unsafe-inline'" : "'self'";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
        ],
      },
    });
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let permitted = false;
    try {
      const u = new URL(url);
      permitted =
        (u.protocol === 'file:' &&
          path.resolve(decodeURIComponent(u.pathname)) ===
            path.resolve(path.join(__dirname, '..', 'dist', 'index.html'))) ||
        (isDev && u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === '5173');
    } catch {}
    if (!permitted) event.preventDefault();
  });
  if (isDev) mainWindow.loadURL('http://127.0.0.1:5173');
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    agentEngine.stopAll();
    for (const [id, { terminal }] of sessions) {
      sessions.delete(id);
      try {
        terminal.kill();
      } catch {}
    }
  });
}

app.whenReady().then(createWindow);
app.on('before-quit', () => {
  agentEngine.stopAll();
  for (const { terminal } of sessions.values()) {
    try {
      terminal.kill();
    } catch {}
  }
  sessions.clear();
});
app.on('window-all-closed', () => app.quit());
