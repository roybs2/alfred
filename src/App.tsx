import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Agent = { id: string; name: string; available: boolean; path: string };
// Known providers get a real label/icon; any other provider string the engine
// sends (a future one) still renders — see providerLabel/providerMark below.
type KnownAgentProvider = 'claude' | 'codex' | 'cursor';
type AgentProvider = KnownAgentProvider | (string & {});
type Provider = 'shell' | KnownAgentProvider | (string & {});
type TerminalSession = {
  id: string;
  kind: 'terminal';
  provider: Provider;
  name: string;
  status: 'running' | 'exited';
  exitCode?: number;
  createdAt: number;
};
// Usage the provider itself reported for a task, never estimated locally.
// Every field is optional and only ever set from a real `usage` payload on a
// task-completed event.
type Usage = { costUsd?: number; inputTokens?: number; outputTokens?: number };
type ManagedSession = {
  id: string;
  kind: 'managed';
  provider: AgentProvider;
  name: string;
  status: 'idle' | 'running' | 'failed' | 'stopped';
  transcript: {
    id: string;
    taskId?: string;
    role: 'user' | 'agent' | 'system' | 'task' | 'warning' | 'delegation' | 'usage';
    text: string;
    // Delegation entries only: the live target session id, so the line can always be
    // rendered with current names (session.name for the source, this id for the target)
    // instead of the names frozen into `text` when the delegation event fired.
    targetSessionId?: string;
  }[];
  // Running sum of every task-completed usage this session has reported, field by
  // field (a field stays unset until the provider actually reports it once).
  usageTotal?: Usage;
  createdAt: number;
  // The provider's own opaque session/thread id (Claude session_id, Codex thread_id, Cursor
  // session id), captured once the provider reports it on a task-completed event, or carried
  // over immediately when this session was itself created via Resume. Never a credential — only
  // ever used to ask the provider CLI to resume this same conversation. See doc/decisions.md.
  providerSessionId?: string;
};
type Session = TerminalSession | ManagedSession;
// Persisted, ended-session metadata only (see doc/decisions.md) — never terminal output or an
// agent transcript. finalState never includes 'running'/'idle': a session only earns a history
// entry once it is truly not live in this process (closed, or gone after a restart).
type SessionFinalState = 'exited' | 'stopped' | 'failed' | 'completed';
type SessionHistoryEntry = {
  id: string;
  name: string;
  provider: Provider;
  kind: Session['kind'];
  createdAt: number;
  endedAt: number;
  finalState: SessionFinalState;
  providerSessionId?: string;
};
// Pane layout is UI metadata only (which never includes transcripts): how many
// columns the session panes are split into, and the relative width of each one.
type ColumnCount = 1 | 2 | 3;
type Room = {
  id: string;
  name: string;
  cwd: string;
  sessions: Session[];
  createdAt: number;
  allowSpawn: boolean;
  maxAgents: number;
  preapproveRoomTools: boolean;
  columns: ColumnCount | 'auto';
  // Relative widths (fr units), one per column, only meaningful when columns !== 'auto'.
  columnWeights: number[];
};
// Bounds mirrored from desktop/main.cjs (also enforced there, defensively, at the save-state
// IPC boundary): oldest entries dropped first.
const MAX_SESSION_HISTORY = 50;
const MAX_ACTIVITY_HISTORY = 200;
const SESSION_FINAL_STATES: SessionFinalState[] = ['exited', 'stopped', 'failed', 'completed'];
function parseSessionHistory(raw: unknown): SessionHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is Record<string, unknown> =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as any).id === 'string' &&
        typeof (e as any).name === 'string' &&
        typeof (e as any).provider === 'string' &&
        ((e as any).kind === 'terminal' || (e as any).kind === 'managed') &&
        typeof (e as any).createdAt === 'number' &&
        typeof (e as any).endedAt === 'number' &&
        SESSION_FINAL_STATES.includes((e as any).finalState),
    )
    .map((e) => ({
      id: e.id as string,
      name: e.name as string,
      provider: e.provider as Provider,
      kind: e.kind as Session['kind'],
      createdAt: e.createdAt as number,
      endedAt: e.endedAt as number,
      finalState: e.finalState as SessionFinalState,
      ...(typeof e.providerSessionId === 'string' ? { providerSessionId: e.providerSessionId } : {}),
    }))
    .slice(-MAX_SESSION_HISTORY);
}
function parseActivityHistory(raw: unknown): ActivityItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is Record<string, unknown> =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as any).id === 'string' &&
        typeof (e as any).text === 'string' &&
        typeof (e as any).time === 'number' &&
        ((e as any).kind === 'system' || (e as any).kind === 'user' || (e as any).kind === 'warning'),
    )
    .map((e) => ({
      id: e.id as string,
      text: e.text as string,
      time: e.time as number,
      kind: e.kind as ActivityItem['kind'],
    }))
    .slice(-MAX_ACTIVITY_HISTORY);
}
// --- Keyboard shortcuts: configurable in the Settings view, mac-first combos only. Bindings
// are persisted as top-level settings.shortcuts (sibling of rooms) — validated/bounded again in
// desktop/main.cjs at the save-state IPC boundary (sanitizeShortcuts there), never trusted from
// the renderer alone. Only the combo strings are ever stored; nothing else about "settings". ---
type ShortcutActionId =
  | 'newRoom'
  | 'addSession'
  | 'closeSession'
  | 'nextSession'
  | 'prevSession'
  | 'focusSession1'
  | 'focusSession2'
  | 'focusSession3'
  | 'focusSession4'
  | 'focusSession5'
  | 'focusSession6'
  | 'focusSession7'
  | 'focusSession8'
  | 'focusSession9'
  | 'nextRoom'
  | 'prevRoom'
  | 'toggleFocusMode'
  | 'toggleActivityPanel'
  | 'openSettings'
  | 'focusTaskInput';
const SHORTCUT_ACTION_IDS: ShortcutActionId[] = [
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
const SHORTCUT_LABELS: Record<ShortcutActionId, string> = {
  newRoom: 'New room',
  addSession: 'Add session',
  closeSession: 'Close focused session',
  nextSession: 'Next session',
  prevSession: 'Previous session',
  focusSession1: 'Focus session 1',
  focusSession2: 'Focus session 2',
  focusSession3: 'Focus session 3',
  focusSession4: 'Focus session 4',
  focusSession5: 'Focus session 5',
  focusSession6: 'Focus session 6',
  focusSession7: 'Focus session 7',
  focusSession8: 'Focus session 8',
  focusSession9: 'Focus session 9',
  nextRoom: 'Next room',
  prevRoom: 'Previous room',
  toggleFocusMode: 'Toggle focus mode',
  toggleActivityPanel: 'Toggle Room Activity panel',
  openSettings: 'Open settings',
  focusTaskInput: 'Focus task input of managed pane',
};
// Codes (KeyboardEvent.code, never .key) so a Shift-transformed symbol (Shift+] -> "}") can
// never desync a binding from what the user actually pressed.
const DEFAULT_SHORTCUTS: Record<ShortcutActionId, string> = {
  newRoom: 'meta+KeyN',
  addSession: 'meta+KeyT',
  closeSession: 'meta+KeyW',
  nextSession: 'meta+shift+BracketRight',
  prevSession: 'meta+shift+BracketLeft',
  focusSession1: 'meta+Digit1',
  focusSession2: 'meta+Digit2',
  focusSession3: 'meta+Digit3',
  focusSession4: 'meta+Digit4',
  focusSession5: 'meta+Digit5',
  focusSession6: 'meta+Digit6',
  focusSession7: 'meta+Digit7',
  focusSession8: 'meta+Digit8',
  focusSession9: 'meta+Digit9',
  nextRoom: 'meta+alt+ArrowDown',
  prevRoom: 'meta+alt+ArrowUp',
  toggleFocusMode: 'meta+shift+KeyF',
  toggleActivityPanel: 'meta+shift+KeyA',
  openSettings: 'meta+Comma',
  focusTaskInput: 'meta+KeyL',
};
// Combos that must always reach the OS/native app menu (Quit, Hide, Minimize) or standard text
// editing (Undo/Redo, Cut/Copy/Paste, Select All) — never bindable to an app action, and never
// swallowed, in a terminal or anywhere else in the app.
const RESERVED_COMBOS = new Set([
  'meta+KeyC',
  'meta+KeyV',
  'meta+KeyA',
  'meta+KeyZ',
  'meta+shift+KeyZ',
  'meta+KeyQ',
  'meta+KeyH',
  'meta+KeyM',
]);
const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
]);
function comboFromEvent(e: KeyboardEvent): string {
  if (MODIFIER_CODES.has(e.code)) return '';
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.metaKey) parts.push('meta');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.code);
  return parts.join('+');
}
const KEY_CODE_LABELS: Record<string, string> = {
  BracketRight: ']',
  BracketLeft: '[',
  Comma: ',',
  ArrowUp: '↑',
  ArrowDown: '↓',
};
function comboLabel(combo: string): string {
  if (!combo) return '(none)';
  const parts = combo.split('+');
  const key = parts.pop() || '';
  const order: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
  const mods = ['ctrl', 'alt', 'shift', 'meta'].filter((m) => parts.includes(m)).map((m) => order[m]);
  const keyLabel =
    KEY_CODE_LABELS[key] ||
    (key.startsWith('Key') ? key.slice(3) : key.startsWith('Digit') ? key.slice(5) : key);
  return mods.join('') + keyLabel;
}
// A custom binding must always include ⌘ (Meta) — that is what guarantees it can never be
// confused with plain terminal input or a Ctrl-combo the shell owns — and must never be one of
// the reserved system combos above.
function isValidCustomCombo(combo: string): boolean {
  return !!combo && combo.split('+').includes('meta') && !RESERVED_COMBOS.has(combo);
}
function parseShortcuts(raw: unknown): Record<ShortcutActionId, string> {
  const out = { ...DEFAULT_SHORTCUTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    for (const id of SHORTCUT_ACTION_IDS) {
      const combo = (raw as Record<string, unknown>)[id];
      if (typeof combo === 'string' && isValidCustomCombo(combo)) out[id] = combo;
    }
  return out;
}
type AgentEvent = {
  type:
    | 'session-created'
    | 'task-started'
    | 'output'
    | 'task-completed'
    | 'task-failed'
    | 'session-stopped'
    | 'session-renamed'
    | 'delegation'
    | 'permission-denied';
  sessionId: string;
  roomId: string;
  taskId?: string;
  text?: string;
  name?: string;
  targetSessionId?: string;
  targetTaskId?: string;
  // Only ever present when the provider itself reported it on task-completed.
  usage?: Usage;
  // Only ever present on task-completed: the provider's own opaque session/thread id.
  providerSessionId?: string;
  session?: {
    id: string;
    roomId: string;
    provider: AgentProvider;
    name: string;
    status: ManagedSession['status'];
    providerSessionId?: string;
  };
};
type ActivityItem = {
  id: string;
  text: string;
  time: number;
  kind: 'system' | 'user' | 'warning';
  streamKey?: string;
};
// A delegation event only proves that a source task handed work to a target
// session/task. The live state of that child task comes from whatever
// task-started/task-completed/task-failed events later arrive for it — never
// invented here.
type DelegationRecord = {
  id: string;
  roomId: string;
  sourceSessionId: string;
  sourceTaskId?: string;
  targetSessionId: string;
  targetTaskId?: string;
  text: string;
  time: number;
};
type TaskState = 'started' | 'completed' | 'failed';
type Bridge = {
  detectAgents(): Promise<Agent[]>;
  chooseDirectory(): Promise<string | null>;
  createSession(input: {
    id: string;
    provider: Provider;
    cwd: string;
    cols: number;
    rows: number;
  }): Promise<{ id: string }>;
  writeSession(input: { id: string; data: string }): Promise<void>;
  resizeSession(input: { id: string; cols: number; rows: number }): Promise<void>;
  closeSession(id: string): Promise<void>;
  onOutput(cb: (event: { id: string; data: string }) => void): () => void;
  onExit(cb: (event: { id: string; exitCode: number }) => void): () => void;
  createAgentSession(input: {
    roomId: string;
    provider: AgentProvider;
    cwd: string;
    name?: string;
    // An opaque provider session/thread id from a previous run, to resume it (see decisions.md).
    providerSessionId?: string;
  }): Promise<{
    id: string;
    roomId: string;
    provider: AgentProvider;
    name: string;
    status: ManagedSession['status'];
    providerSessionId?: string;
  }>;
  runAgentTask(input: { sessionId: string; text: string }): Promise<{ taskId: string }>;
  stopAgentSession(id: string): Promise<void>;
  renameAgentSession(input: { id: string; name: string }): Promise<{ id: string; name: string }>;
  setRoomPolicy(input: {
    roomId: string;
    allowSpawn: boolean;
    maxAgents: number;
    preapproveRoomTools: boolean;
  }): Promise<unknown>;
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;
  loadState(): Promise<unknown>;
  saveState(state: unknown): Promise<void>;
};
declare global {
  interface Window {
    rooms?: Bridge;
  }
}
// Label/icon for every provider the app currently knows how to launch, plus
// ones the engine may report without a launcher yet (e.g. Cursor).
const providerInfo: Record<string, { label: string; mark: string }> = {
  shell: { label: 'Terminal', mark: '>_' },
  claude: { label: 'Claude Code', mark: '✳' },
  codex: { label: 'Codex', mark: '◈' },
  cursor: { label: 'Cursor', mark: '▣' },
};
const providers: { id: Provider; label: string; detail: string; mark: string }[] = [
  { id: 'shell', label: providerInfo.shell.label, detail: 'Start a shell session', mark: providerInfo.shell.mark },
  {
    id: 'claude',
    label: providerInfo.claude.label,
    detail: 'Launch Claude in this folder',
    mark: providerInfo.claude.mark,
  },
  {
    id: 'codex',
    label: providerInfo.codex.label,
    detail: 'Launch Codex in this folder',
    mark: providerInfo.codex.mark,
  },
  {
    id: 'cursor',
    label: providerInfo.cursor.label,
    detail: 'Launch Cursor in this folder',
    mark: providerInfo.cursor.mark,
  },
];
// Never assume only two providers exist: fall back to a generic label/icon
// for anything the engine reports that isn't in providerInfo yet.
const providerLabel = (id: Provider) => providerInfo[id]?.label || String(id);
const providerMark = (id: Provider) => providerInfo[id]?.mark || '◈';
const sessionName = (sessions: Session[], provider: Provider, kind: Session['kind']) => {
  const base =
    provider === 'shell'
      ? 'Terminal'
      : providerLabel(provider) + (kind === 'managed' ? ' agent' : ' terminal');
  const count =
    1 +
    Math.max(
      0,
      ...sessions
        .filter((s) => s.provider === provider && s.kind === kind)
        .map((s) => Number(s.name.startsWith(base + ' ') ? s.name.slice(base.length + 1) : 0) || 0),
    );
  return `${base} ${count}`;
};
const makeId = () => crypto.randomUUID();
// --- Usage formatting: never estimates, only formats what the provider reported. ---
function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) < 1000) return String(Math.round(n));
  const k = n / 1000;
  return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'k';
}
function formatCost(usd: number): string {
  return Number.isFinite(usd) ? '$' + usd.toFixed(2) : '';
}
function formatUsage(usage?: Usage): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd))
    parts.push(formatCost(usage.costUsd));
  const tokenParts: string[] = [];
  if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens))
    tokenParts.push(formatTokens(usage.inputTokens) + ' in');
  if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens))
    tokenParts.push(formatTokens(usage.outputTokens) + ' out');
  if (tokenParts.length) parts.push(tokenParts.join(' / '));
  return parts.join(' · ');
}
function accumulateUsage(prev: Usage | undefined, incoming: Usage): Usage {
  const add = (a: number | undefined, b: number | undefined) =>
    b === undefined ? a : (a || 0) + b;
  return {
    costUsd: add(prev?.costUsd, incoming.costUsd),
    inputTokens: add(prev?.inputTokens, incoming.inputTokens),
    outputTokens: add(prev?.outputTokens, incoming.outputTokens),
  };
}
// --- Pane column layout: pure UI metadata, computed from session order. ---
function equalColumnWeights(columns: ColumnCount): number[] {
  return Array.from({ length: columns }, () => 100 / columns);
}
function isValidColumnWeights(weights: unknown, columns: ColumnCount): weights is number[] {
  return (
    Array.isArray(weights) &&
    weights.length === columns &&
    weights.every((w) => typeof w === 'number' && Number.isFinite(w) && w > 0)
  );
}
// A pane's header (icon + name + MANAGED AGENT badge + usage badge + status +
// close button) needs a real minimum width to stay legible; below this a
// column must never be requested, in drag math or in the effective column
// count used for rendering (see maxFittingColumns), so panes can never
// overlap or clip each other's status/close controls.
const MIN_PANE_COLUMN_PX = 260;
const COLUMN_HANDLE_PX = 6;
// `columns`/`effectiveColumns` below are always 1, 2 or 3 in practice (never
// more than ColumnCount), but are typed as plain numbers since a degraded
// render can use fewer than the room's configured column count.
function buildColumnTemplate(weights: number[], columns: number): string {
  const parts: string[] = [];
  for (let i = 0; i < columns; i++) {
    // minmax(0, …fr): without the explicit 0 minimum, a grid track's default
    // min size is "auto" (its content's min-content size), which would let a
    // wide pane (long transcript text, a fitted terminal) silently override
    // the weight-based split. Content that doesn't fit scrolls within the pane.
    parts.push('minmax(0, ' + Math.max(weights[i] ?? 100 / columns, 0.5).toFixed(2) + 'fr)');
    if (i < columns - 1) parts.push(COLUMN_HANDLE_PX + 'px');
  }
  return parts.join(' ');
}
// Assigns each session a (column, row) slot, round-robin in creation order, so
// the grid position never depends on which room is currently selected.
function computePaneGrid(sessions: Session[], columns: number) {
  const rowCounts = new Array(columns).fill(0);
  const map = new Map<string, { col: number; row: number }>();
  sessions.forEach((s, i) => {
    const col = i % columns;
    rowCounts[col] += 1;
    map.set(s.id, { col, row: rowCounts[col] });
  });
  return map;
}
// The number of columns that can actually fit MIN_PANE_COLUMN_PX each at the
// given container width, capped at the room's configured column count. This
// is what actually gets rendered — the room's `columns` setting is only ever
// a ceiling, never a promise, so a narrow window degrades to fewer columns
// instead of ever overlapping panes.
// Auto layout: the CSS auto-fit grid alone leaves an orphan row (4 panes at a
// width that fits 3 render as 3 + 1 with a large empty area). Pick the number
// of columns that fits (same 290px minimum and 13px gap as .terminal-stack),
// then balance rows so every row is as full as possible: 4 -> 2x2, 5 -> 3+2.
const AUTO_PANE_MIN_PX = 290;
const AUTO_PANE_GAP_PX = 13;
export function balancedAutoColumns(containerWidth: number, panes: number): number {
  if (containerWidth <= 0 || panes <= 0) return 0;
  const fit = Math.max(1, Math.floor((containerWidth + AUTO_PANE_GAP_PX) / (AUTO_PANE_MIN_PX + AUTO_PANE_GAP_PX)));
  const cols = Math.min(fit, panes);
  return Math.ceil(panes / Math.ceil(panes / cols));
}
function maxFittingColumns(containerWidth: number, columns: number): number {
  if (containerWidth <= 0) return columns;
  for (let n = columns; n > 1; n--) {
    const handles = (n - 1) * COLUMN_HANDLE_PX;
    if (containerWidth - handles >= n * MIN_PANE_COLUMN_PX) return n;
  }
  return 1;
}
// --- Minimal, safe Markdown for agent transcript text only. Renders straight to
// React elements (never dangerouslySetInnerHTML), so arbitrary text such as
// "<script>" or "<img onerror=...>" is always inert plain text. Links are shown
// as plain (non-clickable, non-navigating) text with the URL only in a tooltip. ---
type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] };
// One level of nesting: an item indented deeper than its list's first item (for
// example "   - **Problem:** …" under "5. **Finding**") belongs to the previous
// item as a sub-list, instead of becoming a sibling that inherits the parent's
// numbering.
type MdListItem = { text: string; sub?: { ordered: boolean; start: number; items: string[] } };
const mdListLine = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
const mdListStart = (marker: string) => (/^\d/.test(marker) ? parseInt(marker, 10) : 1);
function parseMarkdownBlocks(text: string): MdBlock[] {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: MdBlock[] = [];
  let paraBuffer: string[] = [];
  const flushPara = () => {
    if (paraBuffer.length) {
      blocks.push({ type: 'paragraph', text: paraBuffer.join('\n') });
      paraBuffer = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      // Unterminated fence (mid-stream): render what has arrived so far as code
      // rather than losing it or breaking the parse.
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    const listItem = line.match(mdListLine);
    if (listItem) {
      flushPara();
      const indent = listItem[1].length;
      const ordered = /\d/.test(listItem[2]);
      const items: MdListItem[] = [{ text: listItem[3] }];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(mdListLine);
        if (!m) break;
        const itemOrdered = /\d/.test(m[2]);
        if (m[1].length > indent) {
          const parent = items[items.length - 1];
          if (!parent.sub) parent.sub = { ordered: itemOrdered, start: mdListStart(m[2]), items: [] };
          parent.sub.items.push(m[3]);
        } else if (itemOrdered === ordered) items.push({ text: m[3] });
        else break;
        i++;
      }
      // `start` keeps numbering right when a model separates "5." and "6." with blank
      // lines or nested bullets (each run is its own list).
      blocks.push({ type: 'list', ordered, start: mdListStart(listItem[2]), items });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }
    paraBuffer.push(line);
    i++;
  }
  flushPara();
  return blocks;
}
const mdInlineRegex =
  // Underscore emphasis only at word boundaries (as in CommonMark): identifiers such as
  // room_send or snake_case_name must never turn into italics.
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])|\*([^*\n]+)\*|(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;
function renderMarkdownInline(text: string, keyPrefix: string) {
  const nodes: (string | JSX.Element)[] = [];
  mdInlineRegex.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = mdInlineRegex.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = keyPrefix + '-' + idx++;
    if (match[1] !== undefined) nodes.push(<code className="md-code" key={key}>{match[1]}</code>);
    else if (match[2] !== undefined || match[3] !== undefined)
      nodes.push(<strong key={key}>{match[2] ?? match[3]}</strong>);
    else if (match[4] !== undefined || match[5] !== undefined)
      nodes.push(<em key={key}>{match[4] ?? match[5]}</em>);
    else if (match[6] !== undefined)
      // No <a>: never navigates the app window. The URL is only ever visible as text.
      nodes.push(
        <span className="md-link" title={match[7]} key={key}>
          {match[6]}
        </span>,
      );
    last = mdInlineRegex.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
const mdHeadingTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
function MarkdownText({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="md">
      {blocks.map((block, i) => {
        const key = 'b' + i;
        if (block.type === 'heading') {
          const Tag = mdHeadingTags[Math.min(5, Math.max(0, block.level - 1))];
          return (
            <Tag className="md-heading" key={key}>
              {renderMarkdownInline(block.text, key)}
            </Tag>
          );
        }
        if (block.type === 'code')
          return (
            <pre className="md-pre" key={key}>
              <code>{block.text}</code>
            </pre>
          );
        if (block.type === 'list') {
          const items = block.items.map((item, j) => {
            const itemKey = key + '-' + j;
            const subItems = item.sub?.items.map((sub, k) => (
              <li key={itemKey + '-' + k}>{renderMarkdownInline(sub, itemKey + '-' + k)}</li>
            ));
            return (
              <li key={itemKey}>
                {renderMarkdownInline(item.text, itemKey)}
                {item.sub &&
                  (item.sub.ordered ? (
                    <ol className="md-list md-sublist" start={item.sub.start}>
                      {subItems}
                    </ol>
                  ) : (
                    <ul className="md-list md-sublist">{subItems}</ul>
                  ))}
              </li>
            );
          });
          return block.ordered ? (
            <ol className="md-list" key={key} start={block.start}>
              {items}
            </ol>
          ) : (
            <ul className="md-list" key={key}>
              {items}
            </ul>
          );
        }
        return (
          <p className="md-p" key={key}>
            {renderMarkdownInline(block.text, key)}
          </p>
        );
      })}
    </div>
  );
}
const pathName = (p: string) => p.split('/').filter(Boolean).pop() || p || 'New room';
const terminalRegistry = new Map<string, Terminal>();
const outputBuffers = new Map<string, string[]>();
const appendTranscript = (
  session: ManagedSession,
  role: 'user' | 'agent' | 'system' | 'task' | 'warning' | 'delegation' | 'usage',
  text: string,
  taskId?: string,
  targetSessionId?: string,
): ManagedSession => {
  const previous = session.transcript.at(-1);
  if (role === 'agent' && previous?.role === 'agent' && previous.taskId === taskId) {
    return {
      ...session,
      transcript: [
        ...session.transcript.slice(0, -1),
        { ...previous, text: (previous.text + text).slice(-200000) },
      ],
    };
  }
  // A new agent entry (e.g. output resuming after a warning) must not open with
  // the runner's segment-break whitespace; that only belongs inside an entry.
  if (role === 'agent') {
    text = text.replace(/^\s+/, '');
    if (!text) return session;
  }
  return {
    ...session,
    transcript: [
      ...session.transcript,
      { id: makeId(), taskId, role, text, targetSessionId },
    ].slice(-200),
  };
};

function TerminalPane({
  session,
  onClose,
  closeConfirming,
  renaming,
  nameDraft,
  renameError,
  onStartRename,
  onNameDraftChange,
  onCommitRename,
  onCancelRename,
  onBlurRename,
}: {
  session: TerminalSession;
  onClose: () => void;
  closeConfirming: boolean;
  renaming: boolean;
  nameDraft: string;
  renameError: string;
  onStartRename: () => void;
  onNameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onBlurRename: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const status = useRef(session.status);
  status.current = session.status;
  const bridge = window.rooms;
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      theme: {
        background: '#111116',
        foreground: '#e5e1ed',
        cursor: '#b39bff',
        selectionBackground: '#554279',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    terminalRegistry.set(session.id, term);
    const resize = () => {
      try {
        if (!host.current?.clientWidth || !host.current.clientHeight) return;
        fit.fit();
        if (term.cols >= 2 && term.rows >= 2 && status.current === 'running')
          void bridge
            ?.resizeSession({ id: session.id, cols: term.cols, rows: term.rows })
            .catch(() => {});
      } catch {
        /* hidden pane */
      }
    };
    for (const chunk of outputBuffers.get(session.id) || []) term.write(chunk);
    outputBuffers.delete(session.id);
    const timer = window.setTimeout(resize, 50);
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const input = term.onData((data) => {
      if (status.current === 'running')
        void bridge?.writeSession({ id: session.id, data }).catch(() => {});
    });
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminalRegistry.delete(session.id);
    };
  }, [session.id]);
  useEffect(() => {
    if (session.status === 'exited')
      terminalRegistry
        .get(session.id)
        ?.write(
          '\r\n\x1b[90m[process exited' +
            (session.exitCode === undefined ? '' : ' with code ' + session.exitCode) +
            ']\x1b[0m\r\n',
        );
  }, [session.status, session.exitCode]);
  return (
    <section className="terminal-card">
      <header className="terminal-head">
        <span className={'provider-mark ' + session.provider}>{providerMark(session.provider)}</span>
        {renaming ? (
          <span className="pane-name-wrap">
            <input
              autoFocus
              aria-label={'Rename ' + session.name}
              className="pane-name-input"
              value={nameDraft}
              maxLength={80}
              onChange={(e) => onNameDraftChange(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onCommitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onCancelRename();
                }
              }}
              onBlur={onBlurRename}
            />
            {renameError && <span className="rename-error">{renameError}</span>}
          </span>
        ) : (
          <b className="pane-name" title="Double-click to rename" onDoubleClick={onStartRename}>
            {session.name}
          </b>
        )}
        <span className={'run-state ' + session.status}>
          <i />
          {session.status}
        </span>
        <button
          className={'icon-button close-pane' + (closeConfirming ? ' confirm-close' : '')}
          title={closeConfirming ? 'Running — click again to close' : 'Close session'}
          aria-label={closeConfirming ? 'Confirm close running session' : 'Close session'}
          onClick={onClose}
        >
          {closeConfirming ? '⚠' : '×'}
        </button>
      </header>
      <div className="terminal-host" ref={host} />
      {!bridge && (
        <div className="terminal-preview-note">Preview · terminal connection unavailable</div>
      )}
    </section>
  );
}

function ManagedPane({
  session,
  onClose,
  closeConfirming,
  onRun,
  renaming,
  nameDraft,
  renameError,
  onStartRename,
  onNameDraftChange,
  onCommitRename,
  onCancelRename,
  onBlurRename,
  resolveSessionName,
}: {
  session: ManagedSession;
  onClose: () => void;
  closeConfirming: boolean;
  onRun: (text: string) => Promise<void>;
  renaming: boolean;
  nameDraft: string;
  renameError: string;
  onStartRename: () => void;
  onNameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onBlurRename: () => void;
  // Live current-name lookup by session id, so a delegation line always reads
  // with names as they are now, not as they were when the delegation fired.
  resolveSessionName: (id: string) => string;
}) {
  const [task, setTask] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [session.transcript]);
  async function submit() {
    const text = task.trim();
    if (!text || session.status === 'running' || session.status === 'stopped' || submitting) return;
    setSubmitting(true);
    try {
      await onRun(text);
      setTask('');
    } catch {
      /* parent displays error */
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="terminal-card managed-card">
      <header className="terminal-head">
        <span className={'provider-mark ' + session.provider}>
          {providerMark(session.provider)}
        </span>
        {renaming ? (
          <span className="pane-name-wrap">
            <input
              autoFocus
              aria-label={'Rename ' + session.name}
              className="pane-name-input"
              value={nameDraft}
              maxLength={80}
              onChange={(e) => onNameDraftChange(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onCommitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onCancelRename();
                }
              }}
              onBlur={onBlurRename}
            />
            {renameError && <span className="rename-error">{renameError}</span>}
          </span>
        ) : (
          <b className="pane-name" title="Double-click to rename" onDoubleClick={onStartRename}>
            {session.name}
          </b>
        )}
        <span className="mode-tag">MANAGED AGENT</span>
        {formatUsage(session.usageTotal) && (
          <span
            className="usage-total-badge"
            title={
              'Session total (reported by ' +
              providerLabel(session.provider) +
              '): ' +
              formatUsage(session.usageTotal)
            }
          >
            Σ
          </span>
        )}
        <span className={'run-state ' + session.status}>
          <i />
          {session.status}
        </span>
        <button
          className={'icon-button close-pane' + (closeConfirming ? ' confirm-close' : '')}
          title={
            closeConfirming
              ? 'Running — click again to stop'
              : session.status === 'stopped'
                ? 'Remove agent session'
                : 'Stop agent session'
          }
          aria-label={
            closeConfirming
              ? 'Confirm stop running agent session'
              : session.status === 'stopped'
                ? 'Remove agent session'
                : 'Stop agent session'
          }
          onClick={onClose}
        >
          {closeConfirming ? '⚠' : '×'}
        </button>
      </header>
      <div className="managed-transcript" ref={scroll} aria-label={session.name + ' transcript'}>
        {session.transcript.length ? (
          session.transcript.map((entry) => (
            <div className={'transcript-entry ' + entry.role} key={entry.id}>
              <span>
                {entry.role === 'user'
                  ? 'YOU'
                  : entry.role === 'agent'
                    ? session.name.toUpperCase()
                    : entry.role === 'task'
                      ? 'DELIVERED TASK'
                      : entry.role === 'warning'
                        ? 'WARNING · ' + providerLabel(session.provider).toUpperCase()
                        : entry.role === 'delegation'
                          ? 'DELEGATION'
                          : entry.role === 'usage'
                            ? ''
                            : 'STATUS'}
              </span>
              {entry.role === 'agent' ? (
                // Markdown for agent output only — the delivered-task/provenance
                // blocks below stay plain monospace so the exact text is visible.
                <MarkdownText text={entry.text} />
              ) : (
                <p>
                  {entry.role === 'delegation' && entry.targetSessionId
                    ? session.name + ' → ' + resolveSessionName(entry.targetSessionId)
                    : entry.text}
                </p>
              )}
            </div>
          ))
        ) : (
          <div className="managed-empty">
            Runs {providerLabel(session.provider)} in structured headless mode when you send a
            task. No process is running until then. Output and results appear here.
          </div>
        )}
      </div>
      <form
        className="managed-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          aria-label={'Task for ' + session.name}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Give this agent a task…"
          disabled={session.status === 'running' || session.status === 'stopped' || submitting}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="paste-button"
          disabled={
            !task.trim() ||
            session.status === 'running' ||
            session.status === 'stopped' ||
            submitting
          }
          type="submit"
        >
          {session.status === 'running' ? 'Agent running' : 'Run task'} <span>↗</span>
        </button>
      </form>
    </section>
  );
}

// Focus-traps Tab/Shift+Tab within the given container while it is mounted, and focuses the
// first focusable element once. Escape-to-close is handled by the app's single global keydown
// handler (see App), never duplicated here.
function useFocusTrap(containerRef: { current: HTMLElement | null }) {
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
    (focusables()[0] || root).focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const idx = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && idx <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && idx === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [containerRef]);
}

// Keyboard-shortcut Settings view: lists every configurable action with its current binding,
// lets the user rebind one (press-a-combo capture), refuses conflicting/invalid combos inline,
// and can reset to defaults. Persists nothing itself — the parent owns `shortcuts` state and
// only that state (bindings, never anything else) is written to disk (see App).
function SettingsPanel({
  shortcuts,
  conflictMessage,
  capturingId,
  onStartCapture,
  onCancelCapture,
  onCaptureCombo,
  onReset,
  onClose,
}: {
  shortcuts: Record<ShortcutActionId, string>;
  conflictMessage: string;
  capturingId: ShortcutActionId | '';
  onStartCapture: (id: ShortcutActionId) => void;
  onCancelCapture: () => void;
  onCaptureCombo: (id: ShortcutActionId, combo: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);
  useEffect(() => {
    if (!capturingId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (MODIFIER_CODES.has(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        onCancelCapture();
        return;
      }
      const combo = comboFromEvent(e);
      if (combo) onCaptureCombo(capturingId, combo);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturingId, onCaptureCombo, onCancelCapture]);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={containerRef}
      >
        <header className="modal-head">
          <h2 id="settings-title">Keyboard shortcuts</h2>
          <button className="icon-button" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="modal-copy">
          Click Change, then press the new key combo. Every shortcut must include ⌘ so it can
          never be confused with plain terminal input or a Ctrl-combo the shell owns.
        </p>
        {conflictMessage && (
          <div className="settings-conflict" role="alert">
            {conflictMessage}
          </div>
        )}
        <ul className="shortcut-list">
          {SHORTCUT_ACTION_IDS.map((id) => (
            <li className="shortcut-row" key={id}>
              <span className="shortcut-label">{SHORTCUT_LABELS[id]}</span>
              {capturingId === id ? (
                <span className="shortcut-capturing">
                  Press a combo…
                  <button className="subtle-button" onClick={onCancelCapture}>
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <kbd className="shortcut-combo">{comboLabel(shortcuts[id])}</kbd>
                  <button
                    className="subtle-button"
                    aria-label={'Change binding for ' + SHORTCUT_LABELS[id]}
                    onClick={() => onStartCapture(id)}
                  >
                    Change
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <footer className="modal-foot">
          <button className="subtle-button" onClick={onReset}>
            Reset to defaults
          </button>
        </footer>
      </div>
    </div>
  );
}

// Row config for "Add multiple…": one Terminal (shell) row plus one managed-agent row per known
// provider. Launching respects the room's managed-session policy (maxAgents) and the app-wide
// terminal session cap (MAX_SESSIONS in desktop/main.cjs) — both enforced again server-side
// regardless of what this dialog computes.
const ADD_MULTIPLE_ROWS: { provider: Provider; kind: Session['kind']; label: string }[] = [
  { provider: 'shell', kind: 'terminal', label: providerInfo.shell.label },
  ...providers
    .filter((p) => p.id !== 'shell')
    .map((p) => ({ provider: p.id, kind: 'managed' as const, label: p.label + ' agent' })),
];
const APP_MAX_TERMINAL_SESSIONS = 12;
function AddMultipleDialog({
  agents,
  maxAgents,
  managedCount,
  runningTerminalCount,
  onLaunch,
  onClose,
}: {
  agents: Agent[];
  maxAgents: number;
  managedCount: number;
  runningTerminalCount: number;
  onLaunch: (rows: { provider: Provider; kind: Session['kind']; count: number }[]) => Promise<void>;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [launching, setLaunching] = useState(false);
  const key = (row: (typeof ADD_MULTIPLE_ROWS)[number]) => row.provider + ':' + row.kind;
  const setCount = (row: (typeof ADD_MULTIPLE_ROWS)[number], value: number) =>
    setCounts((prev) => ({ ...prev, [key(row)]: Math.max(0, Math.min(12, Math.round(value) || 0)) }));
  async function launch() {
    const rows = ADD_MULTIPLE_ROWS.map((row) => ({ ...row, count: counts[key(row)] || 0 })).filter(
      (row) => row.count > 0,
    );
    if (!rows.length) {
      setError('Choose at least one session to add.');
      return;
    }
    const unavailable = rows.filter((row) => {
      if (row.provider === 'shell') return false;
      const agent = agents.find((a) => a.id === row.provider);
      return agent && !agent.available;
    });
    if (unavailable.length) {
      setError(
        unavailable.map((row) => row.label).join(', ') + ' not detected on this computer.',
      );
      return;
    }
    const managedRequested = rows
      .filter((row) => row.kind === 'managed')
      .reduce((sum, row) => sum + row.count, 0);
    const terminalRequested = rows
      .filter((row) => row.kind === 'terminal')
      .reduce((sum, row) => sum + row.count, 0);
    if (managedCount + managedRequested > maxAgents) {
      setError(
        `That is ${managedCount + managedRequested} agent sessions, above this room's limit of ${maxAgents}. Lower a count or raise the room's session limit.`,
      );
      return;
    }
    if (runningTerminalCount + terminalRequested > APP_MAX_TERMINAL_SESSIONS) {
      setError(
        `That is ${runningTerminalCount + terminalRequested} terminal sessions, above the app-wide limit of ${APP_MAX_TERMINAL_SESSIONS}.`,
      );
      return;
    }
    setError('');
    setLaunching(true);
    try {
      await onLaunch(rows);
      onClose();
    } catch (err) {
      setError('Could not launch every session: ' + String(err));
    } finally {
      setLaunching(false);
    }
  }
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal add-multiple-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-multiple-title"
        tabIndex={-1}
        ref={containerRef}
      >
        <header className="modal-head">
          <h2 id="add-multiple-title">Add multiple sessions</h2>
          <button className="icon-button" aria-label="Close add multiple" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="modal-copy">
          Choose a count per provider and launch them all at once. Managed sessions get unique
          names automatically.
        </p>
        {error && (
          <div className="settings-conflict" role="alert">
            {error}
          </div>
        )}
        <ul className="add-multiple-list">
          {ADD_MULTIPLE_ROWS.map((row) => {
            const agent = agents.find((a) => a.id === row.provider);
            const disabled = row.provider !== 'shell' && agent && !agent.available;
            return (
              <li className="add-multiple-row" key={key(row)}>
                <span className={'provider-mark ' + row.provider}>{providerMark(row.provider)}</span>
                <span className="add-multiple-label">
                  {row.label}
                  {disabled && <small> · not detected</small>}
                </span>
                <input
                  type="number"
                  min={0}
                  max={12}
                  aria-label={'Count of ' + row.label}
                  disabled={!!disabled}
                  value={counts[key(row)] || 0}
                  onChange={(e) => setCount(row, Number(e.target.value))}
                />
              </li>
            );
          })}
        </ul>
        <footer className="modal-foot">
          <button className="subtle-button" disabled={launching} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button add-multiple-launch" disabled={launching} onClick={() => void launch()}>
            {launching ? 'Launching…' : 'Launch'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  const bridge = window.rooms;
  const [rooms, setRooms] = useState<Room[]>([]);
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const [selected, setSelected] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirmRemoveRoom, setConfirmRemoveRoom] = useState(false);
  const confirmRemoveTimer = useRef<number | undefined>(undefined);
  const [activityByRoom, setActivityByRoom] = useState<Record<string, ActivityItem[]>>({});
  // Ended-session metadata only, per room (see SessionHistoryEntry). Populated explicitly when a
  // session is closed, and — for any session still live when the app quits without an explicit
  // close (PTYs and engine sessions never survive a restart either way) — merged in at save time
  // from a snapshot of the live session list. Either way, restart shows every prior session as
  // truly ended, never as fictitiously running/idle.
  const [sessionHistoryByRoom, setSessionHistoryByRoom] = useState<Record<string, SessionHistoryEntry[]>>(
    {},
  );
  const [delegationsByRoom, setDelegationsByRoom] = useState<Record<string, DelegationRecord[]>>(
    {},
  );
  // roomId:sessionId:taskId -> the last state a real event proved for that task.
  const [taskStateByKey, setTaskStateByKey] = useState<Record<string, TaskState>>({});
  const [renamingSessionId, setRenamingSessionId] = useState('');
  const [sessionNameDraft, setSessionNameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingState, setLoadingState] = useState(!!bridge);
  const canPersist = useRef(false);
  const lastSavedMetadata = useRef('');
  // Keyboard shortcuts (Settings view): bindings only, persisted as top-level settings.shortcuts
  // (sanitized again in desktop/main.cjs). `target` doubles as "the focused session" for
  // shortcut actions (close/next/prev/focus-task-input) — the same id focusSession() sets.
  const [shortcuts, setShortcuts] = useState<Record<ShortcutActionId, string>>(DEFAULT_SHORTCUTS);
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const [capturingAction, setCapturingAction] = useState<ShortcutActionId | ''>('');
  const capturingActionRef = useRef(capturingAction);
  capturingActionRef.current = capturingAction;
  const [shortcutConflict, setShortcutConflict] = useState('');
  const [focusMode, setFocusMode] = useState(false);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const [activityHidden, setActivityHidden] = useState(false);
  const [addMultipleOpen, setAddMultipleOpen] = useState(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  // Inline "confirm to close" arming for a running session (⌘W and the pane's own × button both
  // route through requestCloseSession below) — never a silent kill of a running process.
  const [confirmCloseId, setConfirmCloseId] = useState('');
  const confirmCloseTimer = useRef<number | undefined>(undefined);
  const appendActivity = useCallback(
    (text: string, kind: 'system' | 'user' | 'warning' = 'system', roomId?: string) => {
      const id = roomId || selectedRef.current;
      if (!id) return;
      setActivityByRoom((prev) => ({
        ...prev,
        [id]: [...(prev[id] || []), { id: makeId(), text, time: Date.now(), kind }].slice(-80),
      }));
    },
    [],
  );
  const appendOutputActivity = useCallback((event: AgentEvent, name: string) => {
    const output = event.text;
    if (!output) return;
    const key = event.sessionId + ':' + event.taskId;
    setActivityByRoom((prev) => {
      const existing = prev[event.roomId] || [];
      const last = existing.at(-1);
      // A whitespace-only chunk (providers often stream a lone "\n") still separates the
      // words around it; it only must not start a new activity item on its own.
      if (!output.trim() && last?.streamKey !== key) return prev;
      if (last?.streamKey === key)
        return {
          ...prev,
          [event.roomId]: [
            ...existing.slice(0, -1),
            { ...last, text: (last.text + output).slice(0, 300) },
          ],
        };
      const item: ActivityItem = {
        id: makeId(),
        text: name + ': ' + output.slice(0, 300),
        time: Date.now(),
        kind: 'system',
        streamKey: key,
      };
      return { ...prev, [event.roomId]: [...existing, item].slice(-80) };
    });
  }, []);
  // Metadata only — id/name/provider/kind/timestamps/final state, plus the opaque
  // providerSessionId when the session had one. Never the session's transcript/output.
  const toHistoryEntry = useCallback(
    (session: Session, finalState: SessionFinalState): SessionHistoryEntry => ({
      id: session.id,
      name: session.name,
      provider: session.provider,
      kind: session.kind,
      createdAt: session.createdAt,
      endedAt: Date.now(),
      finalState,
      ...(session.kind === 'managed' && session.providerSessionId
        ? { providerSessionId: session.providerSessionId }
        : {}),
    }),
    [],
  );
  const inferFinalState = useCallback((session: Session): SessionFinalState => {
    if (session.kind === 'terminal') return session.status === 'exited' ? 'exited' : 'stopped';
    return session.status === 'failed' ? 'failed' : 'stopped';
  }, []);
  const recordSessionEnded = useCallback(
    (roomId: string, session: Session, finalState: SessionFinalState) => {
      const entry = toHistoryEntry(session, finalState);
      setSessionHistoryByRoom((prev) => ({
        ...prev,
        [roomId]: [...(prev[roomId] || []).filter((e) => e.id !== entry.id), entry].slice(-MAX_SESSION_HISTORY),
      }));
    },
    [toHistoryEntry],
  );
  // Every session still live when state is saved is merged into the persisted history as a
  // fallback snapshot (see sessionHistoryByRoom comment above) — a session explicitly closed
  // already has a more accurate recorded entry, which wins.
  const mergedSessionHistory = useCallback(
    (room: Room): SessionHistoryEntry[] => {
      const byId = new Map<string, SessionHistoryEntry>();
      for (const entry of sessionHistoryByRoom[room.id] || []) byId.set(entry.id, entry);
      for (const session of room.sessions)
        if (!byId.has(session.id)) byId.set(session.id, toHistoryEntry(session, inferFinalState(session)));
      return Array.from(byId.values())
        .sort((a, b) => a.endedAt - b.endedAt)
        .slice(-MAX_SESSION_HISTORY);
    },
    [sessionHistoryByRoom, toHistoryEntry, inferFinalState],
  );
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge
      .detectAgents()
      .then((a) => {
        if (active) setAgents(a);
      })
      .catch(() => {});
    bridge
      .loadState()
      .then(async (raw) => {
        if (!active) return;
        const rows = Array.isArray(raw) ? raw : (raw as any)?.rooms;
        setShortcuts(parseShortcuts((raw as any)?.settings?.shortcuts));
        const restored = (Array.isArray(rows) ? rows : [])
          .filter((r: any) => r && typeof r.id === 'string' && typeof r.cwd === 'string')
          .map((r: any) => ({
            id: r.id,
            name: typeof r.name === 'string' ? r.name : pathName(r.cwd),
            cwd: r.cwd,
            sessions: [],
            createdAt: r.createdAt || Date.now(),
            allowSpawn: r.allowSpawn === true,
            maxAgents:
              Number.isInteger(r.maxAgents) && r.maxAgents >= 1 && r.maxAgents <= 12
                ? r.maxAgents
                : 4,
            preapproveRoomTools: r.preapproveRoomTools === true,
            columns: r.columns === 1 || r.columns === 2 || r.columns === 3 ? r.columns : 'auto',
            columnWeights: isValidColumnWeights(
              r.columnWeights,
              (r.columns === 1 || r.columns === 2 || r.columns === 3 ? r.columns : 1) as ColumnCount,
            )
              ? r.columnWeights
              : equalColumnWeights(
                  (r.columns === 1 || r.columns === 2 || r.columns === 3
                    ? r.columns
                    : 1) as ColumnCount,
                ),
          })) as Room[];
        const rawRooms = (Array.isArray(rows) ? rows : []).filter(
          (r: any) => r && typeof r.id === 'string' && typeof r.cwd === 'string',
        );
        const historyInit: Record<string, SessionHistoryEntry[]> = {};
        const activityInit: Record<string, ActivityItem[]> = {};
        for (const r of rawRooms) {
          historyInit[r.id] = parseSessionHistory(r.sessionHistory);
          activityInit[r.id] = parseActivityHistory(r.activityHistory);
        }
        const results = await Promise.allSettled(
          restored.map((room) =>
            bridge.setRoomPolicy({
              roomId: room.id,
              allowSpawn: room.allowSpawn,
              maxAgents: room.maxAgents,
              preapproveRoomTools: room.preapproveRoomTools,
            }),
          ),
        );
        if (!active) return;
        const ready = restored.map((room, index) =>
          results[index].status === 'fulfilled'
            ? room
            : { ...room, allowSpawn: false, maxAgents: 4, preapproveRoomTools: false },
        );
        if (results.some((result) => result.status === 'rejected'))
          setNotice('Could not restore agent creation policy. Affected rooms are set to off.');
        setRooms(ready);
        setSelected(ready[0]?.id || '');
        setSessionHistoryByRoom(historyInit);
        setActivityByRoom(activityInit);
        canPersist.current = true;
      })
      .catch(() =>
        setNotice('Saved rooms could not be loaded. Existing saved data will not be overwritten.'),
      )
      .finally(() => {
        if (active) setLoadingState(false);
      });
    return () => {
      active = false;
    };
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    return bridge.onOutput(({ id, data }) => {
      const terminal = terminalRegistry.get(id);
      if (terminal) terminal.write(data);
      else outputBuffers.set(id, [...(outputBuffers.get(id) || []), data].slice(-1000));
    });
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    return bridge.onExit(({ id: sessionId, exitCode }) => {
      const owner = roomsRef.current.find((r) => r.sessions.some((s) => s.id === sessionId));
      setRooms((prev) =>
        prev.map((r) => ({
          ...r,
          sessions: r.sessions.map((s) =>
            s.id === sessionId && s.kind === 'terminal' ? { ...s, status: 'exited', exitCode } : s,
          ),
        })),
      );
      if (owner)
        appendActivity(
          'Session exited' + (exitCode === 0 ? '.' : ' with code ' + exitCode + '.'),
          'system',
          owner.id,
        );
    });
  }, [bridge, appendActivity]);
  useEffect(() => {
    if (!bridge?.onAgentEvent) return;
    return bridge.onAgentEvent((event) => {
      if (event.type === 'session-created' && event.session) {
        const created = event.session;
        setRooms((prev) =>
          prev.map((room) =>
            room.id !== event.roomId || room.sessions.some((s) => s.id === created.id)
              ? room
              : {
                  ...room,
                  sessions: [
                    ...room.sessions,
                    {
                      id: created.id,
                      kind: 'managed',
                      provider: created.provider,
                      name: created.name,
                      status: created.status,
                      transcript: [],
                      createdAt: Date.now(),
                      ...(created.providerSessionId
                        ? { providerSessionId: created.providerSessionId }
                        : {}),
                    },
                  ],
                },
          ),
        );
        appendActivity(
          created.name +
            ' managed session created' +
            (created.providerSessionId ? ' (resumed).' : '.'),
          'system',
          event.roomId,
        );
        return;
      }
      const owner = roomsRef.current.find((r) => r.id === event.roomId);
      const eventSession = owner?.sessions.find((s) => s.id === event.sessionId);
      const name = eventSession?.name || event.session?.name || 'Agent';
      const eventProvider = eventSession?.provider || event.session?.provider;
      setRooms((prev) =>
        prev.map((room) =>
          room.id !== event.roomId
            ? room
            : {
                ...room,
                sessions: room.sessions.map((session) => {
                  if (session.id !== event.sessionId || session.kind !== 'managed') return session;
                  if (event.type === 'session-renamed' && event.name)
                    return { ...session, name: event.name };
                  if (event.type === 'task-started')
                    return event.text
                      ? appendTranscript(
                          { ...session, status: 'running' },
                          'task',
                          event.text,
                          event.taskId,
                        )
                      : { ...session, status: 'running' };
                  if (event.type === 'output' && event.text)
                    return appendTranscript(session, 'agent', event.text, event.taskId);
                  if (event.type === 'task-completed') {
                    const idleSession: ManagedSession = {
                      ...session,
                      status: 'idle',
                      // Captured only from the provider's own reported id (see decisions.md);
                      // it lets a later "Resume" ask the provider CLI to resume this session.
                      ...(event.providerSessionId ? { providerSessionId: event.providerSessionId } : {}),
                    };
                    if (!event.usage) return idleSession;
                    const withTotal: ManagedSession = {
                      ...idleSession,
                      usageTotal: accumulateUsage(session.usageTotal, event.usage),
                    };
                    const line = formatUsage(event.usage);
                    // Never estimate: only show a usage line when the provider
                    // actually reported at least one field on this event.
                    return line
                      ? appendTranscript(
                          withTotal,
                          'usage',
                          line + ' · reported by ' + providerLabel(session.provider),
                          event.taskId,
                        )
                      : withTotal;
                  }
                  if (event.type === 'task-failed')
                    return appendTranscript(
                      { ...session, status: 'failed' },
                      'system',
                      event.text || 'Task failed.',
                      event.taskId,
                    );
                  if (event.type === 'session-stopped') return { ...session, status: 'stopped' };
                  if (event.type === 'delegation' && event.text)
                    return appendTranscript(
                      session,
                      'delegation',
                      event.text,
                      event.taskId,
                      event.targetSessionId,
                    );
                  if (event.type === 'permission-denied')
                    return appendTranscript(
                      session,
                      'warning',
                      'Permission denied by ' +
                        providerLabel(session.provider) +
                        ': ' +
                        (event.text || 'unspecified action') +
                        '. Provider permissions were not bypassed.',
                      event.taskId,
                    );
                  return session;
                }),
              },
        ),
      );
      if (event.taskId && (event.type === 'task-started' || event.type === 'task-completed' || event.type === 'task-failed')) {
        const key = event.roomId + ':' + event.sessionId + ':' + event.taskId;
        const state: TaskState =
          event.type === 'task-started'
            ? 'started'
            : event.type === 'task-completed'
              ? 'completed'
              : 'failed';
        setTaskStateByKey((prev) => ({ ...prev, [key]: state }));
      }
      if (event.type === 'delegation' && event.targetSessionId) {
        setDelegationsByRoom((prev) => ({
          ...prev,
          [event.roomId]: [
            ...(prev[event.roomId] || []),
            {
              id: makeId(),
              roomId: event.roomId,
              sourceSessionId: event.sessionId,
              sourceTaskId: event.taskId,
              targetSessionId: event.targetSessionId!,
              targetTaskId: event.targetTaskId,
              text: event.text || '',
              time: Date.now(),
            },
          ].slice(-80),
        }));
      }
      if (event.type === 'task-started')
        appendActivity(name + ' started a task.', 'system', event.roomId);
      if (event.type === 'output') appendOutputActivity(event, name);
      if (event.type === 'task-completed')
        appendActivity(name + ' completed a task.', 'system', event.roomId);
      if (event.type === 'task-failed')
        appendActivity(
          name + ' failed: ' + (event.text || 'Unknown error'),
          'system',
          event.roomId,
        );
      if (event.type === 'session-stopped')
        appendActivity(name + ' stopped.', 'system', event.roomId);
      if (event.type === 'delegation' && event.text)
        appendActivity('Delegation: ' + event.text, 'system', event.roomId);
      if (event.type === 'permission-denied')
        appendActivity(
          'Permission denied for ' +
            name +
            (eventProvider ? ' (' + providerLabel(eventProvider) + ')' : '') +
            ': ' +
            (event.text || 'unspecified action') +
            '. Provider permissions were not bypassed.',
          'warning',
          event.roomId,
        );
    });
  }, [bridge, appendActivity, appendOutputActivity]);
  useEffect(() => {
    if (!bridge || loadingState || !canPersist.current) return;
    const metadata = rooms.map((room) => {
      const {
        id: roomId,
        name,
        cwd,
        createdAt,
        allowSpawn,
        maxAgents,
        preapproveRoomTools,
        columns,
        columnWeights,
      } = room;
      return {
        id: roomId,
        name,
        cwd,
        createdAt,
        allowSpawn,
        maxAgents,
        preapproveRoomTools,
        columns,
        columnWeights,
        // Ended-session metadata only (id/name/provider/kind/timestamps/final state, and the
        // opaque providerSessionId when present) — never terminal output or an agent transcript.
        sessionHistory: mergedSessionHistory(room),
        // Short lifecycle/delegation/permission-denied labels only. Entries carrying a streamed
        // output preview (streamKey set) are excluded — those are agent output, not a label.
        activityHistory: (activityByRoom[roomId] || [])
          .filter((item) => !item.streamKey)
          .map(({ id, text, time, kind }) => ({ id, text, time, kind }))
          .slice(-MAX_ACTIVITY_HISTORY),
      };
    });
    // A global app setting, not per-room: only the shortcut bindings, never anything else.
    const settings = { shortcuts };
    const signature = JSON.stringify({ metadata, settings });
    if (signature !== lastSavedMetadata.current) {
      lastSavedMetadata.current = signature;
      void bridge.saveState({ rooms: metadata, settings }).catch(() => {
        lastSavedMetadata.current = '';
        setNotice('Could not save rooms. Your running sessions are still available.');
      });
    }
  }, [rooms, bridge, loadingState, sessionHistoryByRoom, activityByRoom, mergedSessionHistory, shortcuts]);
  const current = rooms.find((r) => r.id === selected);
  async function addRoom() {
    if (!bridge) {
      setNotice('Folder selection is available in the desktop app.');
      window.setTimeout(() => setNotice(''), 3000);
      return;
    }
    const cwd = await bridge.chooseDirectory().catch(() => null);
    if (!cwd) return;
    const room: Room = {
      id: makeId(),
      name: pathName(cwd),
      cwd,
      sessions: [],
      createdAt: Date.now(),
      allowSpawn: false,
      maxAgents: 4,
      preapproveRoomTools: false,
      columns: 'auto',
      columnWeights: [],
    };
    try {
      await bridge.setRoomPolicy({
        roomId: room.id,
        allowSpawn: false,
        maxAgents: 4,
        preapproveRoomTools: false,
      });
    } catch (error) {
      setNotice('Could not set room policy: ' + String(error));
      return;
    }
    setRooms((prev) => [...prev, room]);
    setSelected(room.id);
    setMenu(false);
    setActivityByRoom((prev) => ({
      ...prev,
      [room.id]: [
        { id: makeId(), text: 'Room opened at ' + cwd + '.', time: Date.now(), kind: 'system' },
      ],
    }));
  }
  async function addSession(
    provider: Provider,
    kind: Session['kind'],
    // Set only when resuming a previously-ended managed session (see resumeManagedSession):
    // an opaque provider session/thread id, never a credential (doc/decisions.md).
    providerSessionId?: string,
    // Set only by "Add multiple…" (see launchMultiple): that flow pre-computes every name up
    // front from one snapshot, since calling addSession several times in a row races the
    // render/effect cycle that keeps roomsRef current, and duplicate numbering has been
    // observed from relying on it across immediately-consecutive calls.
    nameOverride?: string,
  ) {
    if (!current) return;
    setPicker(false);
    if (!bridge) {
      setNotice('Sessions run in the desktop app.');
      window.setTimeout(() => setNotice(''), 3000);
      return;
    }
    const detected = agents.find((a) => a.id === provider);
    if (provider !== 'shell' && detected && !detected.available) {
      setNotice(detected.name + ' was not detected on this computer.');
      window.setTimeout(() => setNotice(''), 3000);
      return;
    }
    if (kind === 'managed' && provider === 'shell') return;
    const sessionId = makeId(),
      roomId = current.id,
      cwd = current.cwd;
    const liveRoom = roomsRef.current.find((r) => r.id === roomId) || current;
    const name = nameOverride || sessionName(liveRoom.sessions, provider, kind);
    if (kind === 'managed') {
      try {
        const created = await bridge.createAgentSession({
          roomId,
          provider: provider as AgentProvider,
          cwd,
          name,
          ...(providerSessionId ? { providerSessionId } : {}),
        });
        setRooms((prev) =>
          prev.map((r) =>
            r.id !== roomId || r.sessions.some((s) => s.id === created.id)
              ? r
              : {
                  ...r,
                  sessions: [
                    ...r.sessions,
                    {
                      id: created.id,
                      kind: 'managed',
                      provider: created.provider,
                      name: created.name,
                      status: created.status,
                      transcript: [],
                      createdAt: Date.now(),
                      ...((created.providerSessionId || providerSessionId)
                        ? { providerSessionId: created.providerSessionId || providerSessionId }
                        : {}),
                    },
                  ],
                },
          ),
        );
        setTarget(created.id);
      } catch (error) {
        setNotice('Could not ' + (providerSessionId ? 'resume' : 'connect') + ' agent: ' + String(error));
      }
      return;
    }
    setRooms((prev) =>
      prev.map((r) =>
        r.id === roomId
          ? {
              ...r,
              sessions: [
                ...r.sessions,
                { id: sessionId, kind: 'terminal', provider, name, status: 'running', createdAt: Date.now() },
              ],
            }
          : r,
      ),
    );
    try {
      await bridge.createSession({ id: sessionId, provider, cwd, cols: 92, rows: 26 });
      appendActivity(
        providers.find((p) => p.id === provider)!.label + ' session opened.',
        'system',
        roomId,
      );
    } catch (error) {
      setRooms((prev) =>
        prev.map((r) =>
          r.id === roomId
            ? {
                ...r,
                sessions: r.sessions.map((s) =>
                  s.id === sessionId && s.kind === 'terminal'
                    ? { ...s, status: 'exited', exitCode: 1 }
                    : s,
                ),
              }
            : r,
        ),
      );
      appendActivity('Could not start session: ' + String(error), 'system', roomId);
    }
  }
  async function closeSession(session: Session) {
    const owner = roomsRef.current.find((r) => r.sessions.some((s) => s.id === session.id));
    if (bridge) {
      try {
        if (session.kind === 'managed' && session.status !== 'stopped')
          await bridge.stopAgentSession(session.id);
        else await bridge.closeSession(session.id);
      } catch (error) {
        setNotice('Could not stop session: ' + String(error));
        return;
      }
    }
    outputBuffers.delete(session.id);
    setRooms((prev) =>
      prev.map((r) => ({ ...r, sessions: r.sessions.filter((s) => s.id !== session.id) })),
    );
    if (owner) {
      recordSessionEnded(owner.id, session, inferFinalState(session));
      appendActivity(session.name + ' closed.', 'system', owner.id);
    }
  }
  // Shared close path for both the pane's own × button and the ⌘W shortcut: a running process
  // is never killed silently. The first click/press only arms an inline confirmation (the ×
  // button switches to a "confirm close" state for 4s); a second click/press while armed — or
  // any close request for a session that isn't running — closes it immediately.
  const requestCloseSession = useCallback(
    (session: Session) => {
      const running = session.status === 'running';
      window.clearTimeout(confirmCloseTimer.current);
      if (!running || confirmCloseId === session.id) {
        setConfirmCloseId('');
        void closeSession(session);
        return;
      }
      setConfirmCloseId(session.id);
      confirmCloseTimer.current = window.setTimeout(() => setConfirmCloseId(''), 4000);
    },
    [confirmCloseId],
  );
  const focusSession = useCallback((id: string) => {
    document.getElementById('pane-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    terminalRegistry.get(id)?.focus();
    setTarget(id);
  }, []);
  const renameOpenedAt = useRef(0);
  const startRename = useCallback((session: Session) => {
    renameOpenedAt.current = Date.now();
    setRenamingSessionId(session.id);
    setSessionNameDraft(session.name);
    setRenameError('');
  }, []);
  const cancelRename = useCallback(() => {
    setRenamingSessionId('');
    setRenameError('');
  }, []);
  // Closing on blur — but the double-click that opens the field also fires
  // a same-tick focus/blur pair on some platforms (the field mounts and
  // grabs focus mid dblclick before the OS has actually settled focus on
  // the window). A blur landing within that opening window is that
  // artifact, not the user clicking away, so it is ignored; any later blur
  // closes the field as expected.
  const blurCancelRename = useCallback(() => {
    if (Date.now() - renameOpenedAt.current > 250) cancelRename();
  }, [cancelRename]);
  // Applies the pending rename in sessionNameDraft to `session`. Names must
  // stay unique within the room — case-insensitively, since room_send
  // addressing a managed session by name should not depend on case — and a
  // rejected rename keeps editing open with an inline error rather than
  // silently accepting a collision. For a managed session, the rename is
  // sent to the backend (rooms:rename-agent-session) first, and local state
  // is only updated on success — otherwise the name shown to the user and
  // the actual room_send address would drift apart.
  const commitRename = useCallback(
    async (session: Session): Promise<boolean> => {
      const room = roomsRef.current.find((r) => r.sessions.some((s) => s.id === session.id));
      if (!room) {
        setRenamingSessionId('');
        setRenameError('');
        return false;
      }
      // Re-read the exact session this rename targets from live room state,
      // never a stale closure, so the result can only ever apply to it.
      const target = room.sessions.find((s) => s.id === session.id);
      if (!target) {
        setRenamingSessionId('');
        setRenameError('');
        return false;
      }
      const trimmed = sessionNameDraft.trim().slice(0, 80);
      if (!trimmed) {
        setRenameError('Session name cannot be empty.');
        return false;
      }
      if (trimmed === target.name) {
        setRenamingSessionId('');
        setRenameError('');
        return true;
      }
      const duplicate = room.sessions.some(
        (s) => s.id !== target.id && s.name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (duplicate) {
        setRenameError(
          'Already used in this room.' +
            (target.kind === 'managed' ? ' room_send addresses sessions by name.' : ''),
        );
        return false;
      }
      const previousName = target.name;
      if (target.kind === 'managed' && bridge) {
        try {
          await bridge.renameAgentSession({ id: target.id, name: trimmed });
        } catch (error) {
          setRenameError('Could not rename: ' + String((error as Error)?.message || error));
          return false;
        }
      }
      setRooms((prev) =>
        prev.map((r) =>
          r.id !== room.id
            ? r
            : {
                ...r,
                sessions: r.sessions.map((s) => (s.id === target.id ? { ...s, name: trimmed } : s)),
              },
        ),
      );
      appendActivity(previousName + ' renamed to ' + trimmed + '.', 'user', room.id);
      setRenamingSessionId('');
      setRenameError('');
      return true;
    },
    [sessionNameDraft, appendActivity, bridge],
  );
  useEffect(() => {
    if (!menu) {
      window.clearTimeout(confirmRemoveTimer.current);
      setConfirmRemoveRoom(false);
    }
  }, [menu]);
  useEffect(() => {
    window.clearTimeout(confirmRemoveTimer.current);
    setConfirmRemoveRoom(false);
  }, [selected]);
  async function removeRoom(room: Room) {
    if (bridge)
      await Promise.all(
        room.sessions.map((s) =>
          s.kind === 'managed'
            ? s.status === 'stopped'
              ? Promise.resolve()
              : bridge.stopAgentSession(s.id).catch(() => {})
            : bridge.closeSession(s.id).catch(() => {}),
        ),
      );
    setRooms((prev) => prev.filter((r) => r.id !== room.id));
    setSelected(rooms.find((r) => r.id !== room.id)?.id || '');
    setSessionHistoryByRoom((prev) => {
      const { [room.id]: _removed, ...rest } = prev;
      return rest;
    });
    setActivityByRoom((prev) => {
      const { [room.id]: _removed, ...rest } = prev;
      return rest;
    });
  }
  function clearHistory(room: Room) {
    setSessionHistoryByRoom((prev) => ({ ...prev, [room.id]: [] }));
    setActivityByRoom((prev) => ({ ...prev, [room.id]: [] }));
    appendActivity('History cleared.', 'system', room.id);
  }
  // Ended sessions only: a session still live in this room's current pane list is never shown
  // here, even if a stale disk snapshot still has an entry for it (see mergedSessionHistory).
  const sessionHistory = current
    ? (sessionHistoryByRoom[current.id] || []).filter(
        (entry) => !current.sessions.some((s) => s.id === entry.id),
      )
    : [];
  const activity = current ? activityByRoom[current.id] || [] : [];
  // Keep the newest activity in view (a live run appends many items), but never
  // yank the list away from someone who scrolled up to read older entries.
  const activityList = useRef<HTMLDivElement>(null);
  const activityPinned = useRef(true);
  const activityAutoTop = useRef(0);
  const lastActivityRoom = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = activityList.current;
    if (!el) return;
    if (lastActivityRoom.current !== current?.id) {
      lastActivityRoom.current = current?.id;
      activityPinned.current = true;
    }
    if (activityPinned.current) {
      el.scrollTop = el.scrollHeight;
      activityAutoTop.current = el.scrollTop;
    }
  }, [activity, current?.id]);
  const delegations = current ? delegationsByRoom[current.id] || [] : [];
  // Always resolves by session id, never by name, so two sessions that
  // happen to share a display name (or a session that has since been
  // renamed or removed) are never confused with each other.
  const sessionLabel = (id: string) => {
    const found = current?.sessions.find((s) => s.id === id);
    if (!found) return id;
    return found.name + ' (' + providerLabel(found.provider) + ')';
  };
  const taskState = (sessionId: string, taskId?: string): TaskState | undefined =>
    current && taskId ? taskStateByKey[current.id + ':' + sessionId + ':' + taskId] : undefined;
  // Group delegations under their parent (source session + source task) so
  // Room Activity can show child tasks indented under the task that spawned
  // them, exactly as the delegation events proved it.
  const delegationGroups = (() => {
    const map = new Map<
      string,
      { sourceSessionId: string; sourceTaskId?: string; items: DelegationRecord[] }
    >();
    for (const item of delegations) {
      const key = item.sourceSessionId + ':' + (item.sourceTaskId || '');
      const group =
        map.get(key) ||
        ({ sourceSessionId: item.sourceSessionId, sourceTaskId: item.sourceTaskId, items: [] } as {
          sourceSessionId: string;
          sourceTaskId?: string;
          items: DelegationRecord[];
        });
      group.items.push(item);
      map.set(key, group);
    }
    return Array.from(map.entries()).map(([key, group]) => ({ key, ...group }));
  })();
  const activeSession =
    current?.sessions.find(
      (s) => s.id === target && s.kind === 'terminal' && s.status === 'running',
    ) || current?.sessions.find((s) => s.kind === 'terminal' && s.status === 'running');
  async function runAgentTask(session: ManagedSession, text: string) {
    if (!bridge) return;
    appendActivity('Task requested for ' + session.name + '.', 'user', current?.id);
    try {
      await bridge.runAgentTask({ sessionId: session.id, text });
    } catch (error) {
      setRooms((prev) =>
        prev.map((r) => ({
          ...r,
          sessions: r.sessions.map((s) =>
            s.id === session.id && s.kind === 'managed'
              ? appendTranscript(s, 'system', 'Task could not be sent: ' + String(error))
              : s,
          ),
        })),
      );
      setNotice('Could not run task: ' + String(error));
      throw error;
    }
  }
  async function updatePolicy(
    room: Room,
    allowSpawn: boolean,
    maxAgents: number,
    preapproveRoomTools = room.preapproveRoomTools,
  ) {
    if (!bridge) return;
    try {
      await bridge.setRoomPolicy({ roomId: room.id, allowSpawn, maxAgents, preapproveRoomTools });
      setRooms((prev) =>
        prev.map((r) =>
          r.id === room.id ? { ...r, allowSpawn, maxAgents, preapproveRoomTools } : r,
        ),
      );
      appendActivity(
        'Agent session creation ' +
          (allowSpawn ? 'allowed' : 'disabled') +
          '; limit ' +
          maxAgents +
          '; room tools ' +
          (preapproveRoomTools ? 'pre-approved' : 'use provider permission prompts') +
          '.',
        'user',
        room.id,
      );
    } catch (error) {
      setNotice('Could not update room policy: ' + String(error));
    }
  }
  async function pasteHandoff() {
    if (!activeSession || !current || !bridge) return;
    const text = draft
      .replace(/[\r\n\u2028\u2029]+/g, ' ')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
      .trim();
    if (!text) return;
    try {
      await bridge.writeSession({ id: activeSession.id, data: text });
      appendActivity(
        'Manual handoff pasted to ' +
          providers.find((p) => p.id === activeSession.provider)?.label +
          '.',
        'user',
        current.id,
      );
      setDraft('');
      terminalRegistry.get(activeSession.id)?.focus();
    } catch {
      setNotice('The note was not pasted. Check that the session is still running.');
    }
  }
  // --- Keyboard shortcuts: dispatch only (see Settings panel for rebinding). A single
  // capture-phase window listener, registered once, always reads the latest bindings/state
  // through refs so it never needs to re-subscribe. ---
  const rebindShortcut = useCallback((id: ShortcutActionId, combo: string): boolean => {
    if (!isValidCustomCombo(combo)) {
      setShortcutConflict('Shortcuts must include ⌘ and cannot use a combo reserved by the system.');
      return false;
    }
    const conflictId = (Object.entries(shortcutsRef.current) as [ShortcutActionId, string][]).find(
      ([otherId, bound]) => otherId !== id && bound === combo,
    )?.[0];
    if (conflictId) {
      setShortcutConflict('Already used by "' + SHORTCUT_LABELS[conflictId] + '". Choose another combo.');
      return false;
    }
    setShortcuts((prev) => ({ ...prev, [id]: combo }));
    setShortcutConflict('');
    return true;
  }, []);
  const resetShortcuts = useCallback(() => {
    setShortcuts({ ...DEFAULT_SHORTCUTS });
    setShortcutConflict('');
  }, []);
  const onCaptureCombo = useCallback(
    (id: ShortcutActionId, combo: string) => {
      if (rebindShortcut(id, combo)) setCapturingAction('');
    },
    [rebindShortcut],
  );
  function runShortcutAction(id: ShortcutActionId) {
    if (id === 'newRoom') {
      void addRoom();
      return;
    }
    if (id === 'openSettings') {
      setSettingsOpen(true);
      return;
    }
    if (id === 'toggleFocusMode') {
      setFocusMode((v) => !v);
      return;
    }
    if (id === 'toggleActivityPanel') {
      setActivityHidden((v) => !v);
      return;
    }
    if (!current) return;
    if (id === 'addSession') {
      setPicker(true);
      return;
    }
    if (id === 'closeSession') {
      const session = current.sessions.find((s) => s.id === targetRef.current);
      if (session) requestCloseSession(session);
      return;
    }
    if (id === 'nextSession' || id === 'prevSession') {
      const list = current.sessions;
      if (!list.length) return;
      const idx = list.findIndex((s) => s.id === targetRef.current);
      const step = id === 'nextSession' ? 1 : -1;
      const next = idx === -1 ? list[0] : list[(idx + step + list.length) % list.length];
      focusSession(next.id);
      return;
    }
    if (id.startsWith('focusSession')) {
      const n = Number(id.slice('focusSession'.length));
      const session = current.sessions[n - 1];
      if (session) focusSession(session.id);
      return;
    }
    if (id === 'nextRoom' || id === 'prevRoom') {
      if (rooms.length < 2) return;
      const idx = rooms.findIndex((r) => r.id === selected);
      const step = id === 'nextRoom' ? 1 : -1;
      const next = rooms[(idx + step + rooms.length) % rooms.length];
      setSelected(next.id);
      setTarget('');
      return;
    }
    if (id === 'focusTaskInput') {
      const managed =
        current.sessions.find((s) => s.id === targetRef.current && s.kind === 'managed') ||
        current.sessions.find((s) => s.kind === 'managed');
      if (managed) {
        setTarget(managed.id);
        window.setTimeout(
          () => document.querySelector<HTMLTextAreaElement>('#pane-' + managed.id + ' textarea')?.focus(),
          0,
        );
      }
    }
  }
  const actionHandlerRef = useRef(runShortcutAction);
  actionHandlerRef.current = runShortcutAction;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Settings' own "press a combo to bind it" capture consumes the very next keypress
      // itself (see SettingsPanel); the app must never also dispatch an action for it.
      if (capturingActionRef.current) return;
      if (event.key === 'Escape') {
        if (settingsOpenRef.current) {
          setSettingsOpen(false);
          return;
        }
        if (focusModeRef.current) {
          setFocusMode(false);
          return;
        }
        setPicker(false);
        setMenu(false);
        return;
      }
      const combo = comboFromEvent(event);
      if (!combo || RESERVED_COMBOS.has(combo)) return;
      const targetEl = event.target as HTMLElement | null;
      const inTerminal = !!targetEl?.closest?.('.terminal-host, .xterm-helper-textarea');
      // While a terminal has DOM focus, only Meta-combos may ever be handled here — plain keys
      // and Ctrl-combos (Ctrl-C, etc.) always reach the shell untouched.
      if (inTerminal && !combo.split('+').includes('meta')) return;
      const match = (Object.entries(shortcutsRef.current) as [ShortcutActionId, string][]).find(
        ([, bound]) => bound === combo,
      );
      if (!match) return;
      event.preventDefault();
      actionHandlerRef.current(match[0]);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // "Add multiple…": every name is numbered up front from one snapshot of the room's current
  // sessions (never recomputed mid-flight — see nameOverride on addSession), so a whole batch
  // gets unique auto-numbered names (e.g. "Claude 1", "Claude 2") regardless of how fast the
  // sequential backend calls below resolve. Awaits each launch so the first real backend error
  // (room/app session limits are re-checked there too) is still surfaced.
  async function launchMultiple(rows: { provider: Provider; kind: Session['kind']; count: number }[]) {
    const snapshot = (current && roomsRef.current.find((r) => r.id === current.id)?.sessions) || [];
    const planned: { provider: Provider; kind: Session['kind']; name: string }[] = [];
    for (const row of rows)
      for (let i = 0; i < row.count; i++) {
        const name = sessionName([...snapshot, ...planned] as Session[], row.provider, row.kind);
        planned.push({ provider: row.provider, kind: row.kind, name });
      }
    for (const item of planned) await addSession(item.provider, item.kind, undefined, item.name);
  }
  // --- Pane column layout: UI metadata only (no transcripts). Weights update
  // locally while a drag is in progress and only land in `rooms` (and so get
  // persisted) once the drag ends, so a drag never spams saveState. ---
  const terminalStackRef = useRef<HTMLDivElement>(null);
  const [dragWeights, setDragWeights] = useState<number[] | null>(null);
  const dragState = useRef<{
    handleIndex: number;
    startX: number;
    startWeights: number[];
    trackPx: number;
  } | null>(null);
  const setColumns = useCallback(
    (room: Room, columns: ColumnCount | 'auto') => {
      setRooms((prev) =>
        prev.map((r) =>
          r.id === room.id
            ? {
                ...r,
                columns,
                columnWeights: columns === 'auto' ? [] : equalColumnWeights(columns),
              }
            : r,
        ),
      );
    },
    [],
  );
  // Converts MIN_PANE_COLUMN_PX into weight units for the current track width,
  // so a column's weight (and so its rendered pixel width) can never drop
  // below what its header needs to stay legible and non-overlapping.
  const minColumnWeight = (weights: number[], trackPx: number) => {
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (trackPx <= 0) return totalWeight * 0.15;
    return (MIN_PANE_COLUMN_PX / trackPx) * totalWeight;
  };
  const clampWeightDelta = (weights: number[], i: number, delta: number, trackPx: number) => {
    const min = minColumnWeight(weights, trackPx);
    let d = delta;
    if (weights[i] + d < min) d = min - weights[i];
    if (weights[i + 1] - d < min) d = weights[i + 1] - min;
    return d;
  };
  const commitColumnWeights = useCallback((roomId: string, weights: number[]) => {
    setRooms((prev) =>
      prev.map((r) => (r.id === roomId ? { ...r, columnWeights: weights } : r)),
    );
  }, []);
  const onColumnHandlePointerDown = useCallback(
    (room: Room, handleIndex: number) => (e: ReactMouseEvent) => {
      if (room.columns === 'auto') return;
      const track = terminalStackRef.current;
      if (!track) return;
      e.preventDefault();
      const startWeights = room.columnWeights;
      dragState.current = {
        handleIndex,
        startX: e.clientX,
        startWeights,
        trackPx: track.getBoundingClientRect().width,
      };
      setDragWeights(startWeights);
      const onMove = (moveEvent: MouseEvent) => {
        const drag = dragState.current;
        if (!drag || drag.trackPx <= 0) return;
        const deltaWeight =
          ((moveEvent.clientX - drag.startX) / drag.trackPx) *
          drag.startWeights.reduce((a, b) => a + b, 0);
        const d = clampWeightDelta(drag.startWeights, drag.handleIndex, deltaWeight, drag.trackPx);
        const next = [...drag.startWeights];
        next[drag.handleIndex] += d;
        next[drag.handleIndex + 1] -= d;
        setDragWeights(next);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        setDragWeights((prevWeights) => {
          if (prevWeights) commitColumnWeights(room.id, prevWeights);
          return null;
        });
        dragState.current = null;
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [commitColumnWeights],
  );
  const onColumnHandleKeyDown = useCallback(
    (room: Room, handleIndex: number) => (e: ReactKeyboardEvent) => {
      if (room.columns === 'auto') return;
      const step = 5;
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = -step;
      else if (e.key === 'ArrowRight') delta = step;
      else return;
      e.preventDefault();
      const weights = room.columnWeights;
      const trackPx = terminalStackRef.current?.getBoundingClientRect().width || 0;
      const d = clampWeightDelta(weights, handleIndex, delta, trackPx);
      const next = [...weights];
      next[handleIndex] += d;
      next[handleIndex + 1] -= d;
      commitColumnWeights(room.id, next);
    },
    [commitColumnWeights],
  );
  const onColumnHandleDoubleClick = useCallback(
    (room: Room, handleIndex: number) => () => {
      if (room.columns === 'auto') return;
      const weights = room.columnWeights;
      const trackPx = terminalStackRef.current?.getBoundingClientRect().width || 0;
      const pair = weights[handleIndex] + weights[handleIndex + 1];
      const min = Math.min(minColumnWeight(weights, trackPx), pair / 2);
      const next = [...weights];
      next[handleIndex] = Math.max(pair / 2, min);
      next[handleIndex + 1] = pair - next[handleIndex];
      commitColumnWeights(room.id, next);
    },
    [commitColumnWeights],
  );
  // Measured width of the pane container, kept live via ResizeObserver so a
  // window resize (or the sidebar/activity panel changing) can immediately
  // reduce the effective column count — never leaving stale layout that could
  // overlap panes.
  const [stackWidth, setStackWidth] = useState(0);
  useEffect(() => {
    const el = terminalStackRef.current;
    if (!el) return;
    setStackWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number') setStackWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [current?.id, current?.columns, !!current?.sessions.length]);
  // The room's `columns` setting is a ceiling, never a promise: at the current
  // width, fewer columns may be all that fit without dropping any pane below
  // MIN_PANE_COLUMN_PX. This is what's actually rendered.
  // Focus mode always tiles with the same responsive Auto grid (see .terminal-stack in
  // styles.css), regardless of the room's saved column setting — never mutates it.
  const effectiveColumns =
    !focusMode && current && current.columns !== 'auto'
      ? maxFittingColumns(stackWidth, current.columns)
      : null;
  const autoColumns =
    current && !effectiveColumns ? balancedAutoColumns(stackWidth, current.sessions.length) : 0;
  const currentPaneGrid =
    current && effectiveColumns ? computePaneGrid(current.sessions, effectiveColumns) : null;
  const effectiveColumnWeights =
    current && effectiveColumns ? (dragWeights || current.columnWeights).slice(0, effectiveColumns) : null;
  const currentManagedCount = current?.sessions.filter((s) => s.kind === 'managed').length || 0;
  const globalRunningTerminalCount = rooms
    .flatMap((r) => r.sessions)
    .filter((s) => s.kind === 'terminal' && s.status === 'running').length;
  return (
    <div
      className={
        'app-shell' +
        (focusMode ? ' focus-mode' : '') +
        (!focusMode && activityHidden ? ' activity-hidden' : '')
      }
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-glyph">◈</span>
          <span>ALFRED</span>
          <span className="brand-beta">DESKTOP</span>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <button
          aria-label="Create room and choose a folder"
          className="new-room"
          onClick={() => void addRoom()}
        >
          <span className="plus">＋</span> New room{' '}
          <span className="shortcut">{comboLabel(shortcuts.newRoom)}</span>
        </button>
        <div className="rooms-heading">
          <span>ROOMS</span>
          <span className="count">{rooms.length}</span>
          <button className="tiny-plus" aria-label="New room" onClick={() => void addRoom()}>
            ＋
          </button>
        </div>
        <nav className="room-list">
          {rooms.map((room) => (
            <div key={room.id} className="room-group">
              <button
                aria-label={'Open room ' + room.name}
                className={'room-row ' + (room.id === selected ? 'selected' : '')}
                onClick={() => {
                  setSelected(room.id);
                  setTarget('');
                }}
              >
                <span className="room-dot" />
                <span className="room-row-label">{room.name}</span>
                <span className="room-session-count">{room.sessions.length || ''}</span>
              </button>
              {room.id === selected &&
                room.sessions.map((s, index) =>
                  renamingSessionId === s.id ? (
                    <div className="session-row session-row-editing" key={s.id}>
                      <span className="tree-mark">
                        {index === room.sessions.length - 1 ? '└' : '├'}
                      </span>
                      <span className={'session-mini ' + s.status} />
                      <span className="pane-name-wrap">
                        <input
                          autoFocus
                          aria-label={'Rename ' + s.name}
                          className="session-name-input"
                          value={sessionNameDraft}
                          maxLength={80}
                          onChange={(e) => setSessionNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitRename(s);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelRename();
                            }
                          }}
                          onBlur={blurCancelRename}
                        />
                        {renameError && <span className="rename-error">{renameError}</span>}
                      </span>
                    </div>
                  ) : (
                    <button
                      key={s.id}
                      aria-label={'Focus ' + s.name + ' session'}
                      className={'session-row ' + (target === s.id ? 'focused' : '')}
                      onClick={() => focusSession(s.id)}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        startRename(s);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          e.preventDefault();
                          const rows = Array.from(
                            document.querySelectorAll<HTMLElement>('.session-row'),
                          );
                          const at = rows.indexOf(e.currentTarget);
                          const next = rows[at + (e.key === 'ArrowDown' ? 1 : -1)];
                          next?.focus();
                        }
                      }}
                    >
                      <span className="tree-mark">
                        {index === room.sessions.length - 1 ? '└' : '├'}
                      </span>
                      <span className={'session-mini ' + s.status} />
                      <span className="session-row-name">{s.name}</span>
                      <span className="session-status-label">{s.status}</span>
                    </button>
                  ),
                )}
            </div>
          ))}
        </nav>
        {!rooms.length && <div className="sidebar-empty">Your rooms will show up here.</div>}
        <div className="sidebar-bottom">
          <span className={'connection-dot ' + (bridge ? 'online' : '')} />
          <span>{bridge ? 'Desktop connected' : 'Browser preview'}</span>
          <span className="version">v0.1</span>
        </div>
      </aside>
      <main className="main-area">
        {!current ? (
          <div className="welcome">
            <div className="welcome-icon">◈</div>
            <p className="eyebrow">A CALM SPACE TO BUILD</p>
            <h1>
              Make room for
              <br />
              <em>good work.</em>
            </h1>
            <p className="welcome-copy">
              Bring your tools together in a room. Start with a folder, then open a terminal or an
              agent session beside your work.
            </p>
            <button className="primary-button" onClick={() => void addRoom()}>
              ＋ <span>Choose a folder</span>
            </button>
            <div className="welcome-foot">
              <span className="welcome-rule" />
              Sessions run locally on your computer
              <span className="welcome-rule" />
            </div>
          </div>
        ) : (
          <>
            <header className="topbar">
              <div className="breadcrumbs">
                <span className="crumb-muted">Rooms</span>
                <span className="slash">/</span>
                {renaming ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setRooms((prev) =>
                        prev.map((r) =>
                          r.id === current.id ? { ...r, name: roomName.trim() || r.name } : r,
                        ),
                      );
                      setRenaming(false);
                    }}
                  >
                    <input
                      autoFocus
                      className="rename-input"
                      value={roomName}
                      onChange={(e) => setRoomName(e.target.value)}
                      onBlur={() => setRenaming(false)}
                      onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
                    />
                  </form>
                ) : (
                  <button
                    className="crumb-current"
                    title="Rename room"
                    onClick={() => {
                      setRoomName(current.name);
                      setRenaming(true);
                    }}
                  >
                    {current.name}
                    <span className="edit-mark">⌄</span>
                  </button>
                )}
                <span className="path-pill">
                  ⌘ <span>{current.cwd || 'Folder not selected'}</span>
                </span>
              </div>
              <div className="topbar-right">
                {!bridge && <span className="preview-badge">PREVIEW</span>}
                <button
                  aria-label="Toggle focus mode"
                  aria-pressed={focusMode}
                  className={'top-icon' + (focusMode ? ' active' : '')}
                  title={'Focus mode (' + comboLabel(shortcuts.toggleFocusMode) + ')'}
                  onClick={() => setFocusMode((v) => !v)}
                >
                  ⛶
                </button>
                <button
                  aria-label="Open settings"
                  className="top-icon"
                  title={'Settings (' + comboLabel(shortcuts.openSettings) + ')'}
                  onClick={() => setSettingsOpen(true)}
                >
                  ⚙
                </button>
                <button
                  aria-label="Room options"
                  className="top-icon"
                  title="Room options"
                  onClick={() => setMenu(!menu)}
                >
                  •••
                </button>
                {menu && (
                  <div className="menu-pop">
                    <button
                      aria-label="Change room folder"
                      onClick={() => {
                        setMenu(false);
                        if (current.sessions.some((s) => s.kind === 'managed')) {
                          setNotice('Close connected agents before changing this room’s folder.');
                          return;
                        }
                        if (bridge)
                          void bridge.chooseDirectory().then((path) => {
                            if (path) {
                              setRooms((prev) =>
                                prev.map((r) =>
                                  r.id === current.id
                                    ? {
                                        ...r,
                                        cwd: path,
                                        name:
                                          r.name === pathName(current.cwd)
                                            ? pathName(path)
                                            : r.name,
                                      }
                                    : r,
                                ),
                              );
                              appendActivity('Folder changed to ' + path + '.');
                            }
                          });
                      }}
                    >
                      Change folder
                    </button>
                    {confirmRemoveRoom ? (
                      <>
                        <button
                          aria-label={
                            'Confirm remove room, ' +
                            current.sessions.filter((s) =>
                              s.kind === 'terminal'
                                ? s.status === 'running'
                                : s.status === 'running' || s.status === 'idle',
                            ).length +
                            ' live sessions'
                          }
                          onClick={() => {
                            window.clearTimeout(confirmRemoveTimer.current);
                            setConfirmRemoveRoom(false);
                            setMenu(false);
                            void removeRoom(current);
                          }}
                        >
                          Confirm remove (
                          {
                            current.sessions.filter((s) =>
                              s.kind === 'terminal'
                                ? s.status === 'running'
                                : s.status === 'running' || s.status === 'idle',
                            ).length
                          }{' '}
                          live sessions)
                        </button>
                        <button
                          aria-label="Cancel remove room"
                          onClick={() => {
                            window.clearTimeout(confirmRemoveTimer.current);
                            setConfirmRemoveRoom(false);
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        aria-label="Remove room"
                        onClick={() => {
                          setConfirmRemoveRoom(true);
                          window.clearTimeout(confirmRemoveTimer.current);
                          confirmRemoveTimer.current = window.setTimeout(
                            () => setConfirmRemoveRoom(false),
                            4000,
                          );
                        }}
                      >
                        Remove room
                      </button>
                    )}
                  </div>
                )}
              </div>
            </header>
            <div className="content-grid">
              <div className="work-area">
                <div className="section-title">
                  <div>
                    <span className="section-overline">YOUR WORKSPACE</span>
                    <h2>
                      {current.name}
                      <span className="session-total">
                        {current.sessions.length}{' '}
                        {current.sessions.length === 1 ? 'session' : 'sessions'}
                      </span>
                    </h2>
                  </div>
                  <div className="section-title-right">
                    <div
                      className="layout-columns"
                      role="group"
                      aria-label="Session pane columns"
                    >
                      <span className="layout-columns-label">Columns</span>
                      {([1, 2, 3, 'auto'] as const).map((n) => (
                        <button
                          key={n}
                          type="button"
                          aria-pressed={current.columns === n}
                          aria-label={'Columns: ' + n}
                          className={current.columns === n ? 'active' : ''}
                          onClick={() => setColumns(current, n)}
                        >
                          {n === 'auto' ? 'Auto' : n}
                        </button>
                      ))}
                    </div>
                    <div className="add-wrap">
                      <button
                        className="add-session"
                        title={'Add session (' + comboLabel(shortcuts.addSession) + ')'}
                        onClick={() => setPicker(!picker)}
                      >
                        <span>＋</span> Add session <span className="chevron">⌄</span>
                      </button>
                    {picker && (
                      <div className="picker-menu">
                        <div className="picker-group">NATIVE TERMINAL</div>
                        {providers.map((p) => {
                          const agent = agents.find((a) => a.id === p.id);
                          return (
                            <button
                              key={'terminal-' + p.id}
                              onClick={() => void addSession(p.id, 'terminal')}
                            >
                              <span className={'provider-mark ' + p.id}>{p.mark}</span>
                              <span className="picker-text">
                                <b>
                                  {p.label}
                                  {p.id !== 'shell' ? ' terminal' : ''}
                                </b>
                                <small>
                                  {p.id !== 'shell' && agent && !agent.available
                                    ? 'Not detected'
                                    : p.detail}
                                </small>
                              </span>
                              <span className="picker-arrow">↗</span>
                            </button>
                          );
                        })}
                        <div className="picker-group">MANAGED AGENT</div>
                        {providers
                          .filter((p) => p.id !== 'shell')
                          .map((p) => {
                            const agent = agents.find((a) => a.id === p.id);
                            return (
                              <button
                                key={'managed-' + p.id}
                                onClick={() => void addSession(p.id, 'managed')}
                              >
                                <span className={'provider-mark ' + p.id}>{p.mark}</span>
                                <span className="picker-text">
                                  <b>{p.label} agent</b>
                                  <small>
                                    {agent && !agent.available
                                      ? 'Not detected'
                                      : 'Structured CLI · task and output'}
                                  </small>
                                </span>
                                <span className="picker-arrow">↗</span>
                              </button>
                            );
                          })}
                        <div className="picker-group">BULK</div>
                        <button
                          key="add-multiple"
                          onClick={() => {
                            setPicker(false);
                            setAddMultipleOpen(true);
                          }}
                        >
                          <span className="provider-mark">▤</span>
                          <span className="picker-text">
                            <b>Add multiple…</b>
                            <small>Launch several sessions at once</small>
                          </span>
                          <span className="picker-arrow">↗</span>
                        </button>
                      </div>
                    )}
                  </div>
                  </div>
                </div>
                {rooms.some((r) => r.sessions.length > 0) && (
                  <div
                    className={'terminal-stack' + (effectiveColumns ? ' terminal-stack-columns' : '')}
                    ref={terminalStackRef}
                    style={{
                      display: current.sessions.length ? undefined : 'none',
                      ...(effectiveColumns && effectiveColumnWeights
                        ? {
                            gridTemplateColumns: buildColumnTemplate(
                              effectiveColumnWeights,
                              effectiveColumns,
                            ),
                          }
                        : autoColumns
                          ? { gridTemplateColumns: `repeat(${autoColumns}, minmax(0, 1fr))` }
                          : {}),
                    }}
                  >
                    {rooms.flatMap((room) =>
                      room.sessions.map((session) => {
                        const gridPos =
                          room.id === current.id && currentPaneGrid
                            ? currentPaneGrid.get(session.id)
                            : undefined;
                        return (
                        <div
                          id={'pane-' + session.id}
                          key={session.id}
                          className={'pane-anchor ' + (room.id === current.id ? '' : 'pane-hidden')}
                          style={
                            gridPos
                              ? { gridColumn: gridPos.col * 2 + 1, gridRow: gridPos.row }
                              : undefined
                          }
                        >
                          {session.kind === 'terminal' ? (
                            <TerminalPane
                              session={session}
                              onClose={() => void closeSession(session)}
                              closeConfirming={confirmCloseId === session.id}
                              renaming={renamingSessionId === session.id}
                              nameDraft={
                                renamingSessionId === session.id ? sessionNameDraft : session.name
                              }
                              renameError={renamingSessionId === session.id ? renameError : ''}
                              onStartRename={() => startRename(session)}
                              onNameDraftChange={setSessionNameDraft}
                              onCommitRename={() => commitRename(session)}
                              onCancelRename={cancelRename}
                              onBlurRename={blurCancelRename}
                            />
                          ) : (
                            <ManagedPane
                              session={session}
                              onClose={() => void closeSession(session)}
                              closeConfirming={confirmCloseId === session.id}
                              onRun={(text) => runAgentTask(session, text)}
                              renaming={renamingSessionId === session.id}
                              nameDraft={
                                renamingSessionId === session.id ? sessionNameDraft : session.name
                              }
                              renameError={renamingSessionId === session.id ? renameError : ''}
                              onStartRename={() => startRename(session)}
                              onNameDraftChange={setSessionNameDraft}
                              onCommitRename={() => commitRename(session)}
                              onCancelRename={cancelRename}
                              onBlurRename={blurCancelRename}
                              resolveSessionName={(id) =>
                                room.sessions.find((s) => s.id === id)?.name || id
                              }
                            />
                          )}
                        </div>
                        );
                      }),
                    )}
                    {effectiveColumns &&
                      effectiveColumns > 1 &&
                      current.sessions.length > 0 &&
                      Array.from({ length: effectiveColumns - 1 }).map((_, i) => (
                        <div
                          key={'handle-' + i}
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={'Resize columns ' + (i + 1) + ' and ' + (i + 2)}
                          tabIndex={0}
                          className="column-handle"
                          style={{ gridColumn: (i + 1) * 2, gridRow: '1 / -1' }}
                          onMouseDown={onColumnHandlePointerDown(current, i)}
                          onDoubleClick={onColumnHandleDoubleClick(current, i)}
                          onKeyDown={onColumnHandleKeyDown(current, i)}
                        />
                      ))}
                  </div>
                )}
                {!current.sessions.length && (
                  <div className="empty-sessions">
                    <div className="empty-orbit">
                      <span>⌘</span>
                      <i>＋</i>
                    </div>
                    <h3>This room is ready.</h3>
                    <p>
                      Open a native terminal or connect a coding agent. Each session works in{' '}
                      <code>{current.cwd || 'your selected folder'}</code>.
                    </p>
                    <button
                      aria-label="Add first session"
                      className="subtle-button"
                      onClick={() => setPicker(true)}
                    >
                      ＋ Add your first session
                    </button>
                  </div>
                )}
                {sessionHistory.length > 0 && (
                  <div className="session-history">
                    <div className="session-history-head">
                      <span className="section-overline">RECOVERY</span>
                      <h3>Session history</h3>
                      <button
                        type="button"
                        className="subtle-button"
                        aria-label={'Clear history for ' + current.name}
                        onClick={() => clearHistory(current)}
                      >
                        Clear history
                      </button>
                    </div>
                    <ul className="session-history-list">
                      {sessionHistory
                        .slice()
                        .reverse()
                        .map((entry) => (
                          <li key={entry.id} className="session-history-row">
                            <span className={'provider-mark ' + entry.provider}>
                              {providerMark(entry.provider)}
                            </span>
                            <span className="session-history-name">{entry.name}</span>
                            <span className="session-history-state">{'ended · ' + entry.finalState}</span>
                            <time>
                              {new Date(entry.endedAt).toLocaleString([], {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              })}
                            </time>
                            {entry.kind === 'terminal' ? (
                              <button
                                type="button"
                                className="subtle-button"
                                aria-label={'Reopen ' + entry.name}
                                onClick={() => void addSession(entry.provider, 'terminal')}
                              >
                                Reopen
                              </button>
                            ) : entry.providerSessionId ? (
                              <button
                                type="button"
                                className="subtle-button"
                                aria-label={'Resume ' + entry.name}
                                onClick={() =>
                                  void addSession(entry.provider, 'managed', entry.providerSessionId)
                                }
                              >
                                Resume
                              </button>
                            ) : (
                              <span className="session-history-no-resume">No resume data</span>
                            )}
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
                <div className="workspace-hint">
                  <span className="hint-icon">✳</span>
                  <span>Local by design</span>
                  <i />
                  Your sessions run on this machine, in this room's folder.
                </div>
              </div>
              <aside className="activity-panel">
                <div className="activity-head">
                  <div>
                    <span className="section-overline">LIVE CONTEXT</span>
                    <h2>Room activity</h2>
                  </div>
                  <span className="live-indicator">
                    <i />
                    LOCAL
                  </span>
                </div>
                <div
                  className="activity-list"
                  ref={activityList}
                  onScroll={(e) => {
                    // Scroll events from our own auto-scroll can arrive after newer
                    // items rendered; only a scroll *up* by the user unpins.
                    const el = e.currentTarget;
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24)
                      activityPinned.current = true;
                    else if (el.scrollTop < activityAutoTop.current - 2)
                      activityPinned.current = false;
                  }}
                >
                  {activity.length ? (
                    activity.map((item) => (
                      <div key={item.id} className={'activity-item ' + item.kind}>
                        <span className="activity-symbol">
                          {item.kind === 'user' ? '↗' : item.kind === 'warning' ? '⚠' : '·'}
                        </span>
                        <div>
                          <p>{item.text}</p>
                          <time>
                            {new Date(item.time).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </time>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="activity-empty">
                      <span className="activity-empty-icon">◌</span>
                      <p>Room activity will appear here as you work.</p>
                      <small>Session starts, exits, and manual handoffs.</small>
                    </div>
                  )}
                </div>
                {delegationGroups.length > 0 && (
                  <div className="delegation-view">
                    <div className="delegation-head">
                      <span className="section-overline">VERIFIED DELEGATION</span>
                      <h3>Delegations</h3>
                    </div>
                    <div className="delegation-list">
                      {delegationGroups.map((group) => {
                        const parentState = taskState(group.sourceSessionId, group.sourceTaskId);
                        return (
                          <div className="delegation-group" key={group.key}>
                            <button
                              className="delegation-parent"
                              onClick={() => focusSession(group.sourceSessionId)}
                            >
                              <span className="delegation-name">
                                {sessionLabel(group.sourceSessionId)}
                              </span>
                              {parentState && (
                                <span className={'delegation-state ' + parentState}>
                                  {parentState}
                                </span>
                              )}
                            </button>
                            <div className="delegation-children">
                              {group.items.map((item) => {
                                const state = taskState(item.targetSessionId, item.targetTaskId);
                                return (
                                  <button
                                    className="delegation-child"
                                    key={item.id}
                                    onClick={() => focusSession(item.targetSessionId)}
                                    title={item.text}
                                  >
                                    <span className="tree-mark">└</span>
                                    <span className="delegation-name">
                                      {sessionLabel(item.sourceSessionId)} → {sessionLabel(item.targetSessionId)}
                                    </span>
                                    <span className={'delegation-state ' + (state || 'delegated')}>
                                      {state || 'delegated'}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="room-policy">
                  <label className="policy-toggle">
                    <input
                      type="checkbox"
                      checked={current.allowSpawn}
                      onChange={(e) =>
                        void updatePolicy(current, e.target.checked, current.maxAgents)
                      }
                      disabled={!bridge}
                    />
                    <span>Allow agents to create sessions</span>
                  </label>
                  <div className="policy-detail">
                    Managed agents in this room can message each other with room_send at any time.
                    Enabling this also lets them create new sessions with room_spawn. Provider
                    permissions still apply.
                  </div>
                  <label className="policy-toggle">
                    <input
                      type="checkbox"
                      checked={current.preapproveRoomTools}
                      onChange={(e) =>
                        void updatePolicy(
                          current,
                          current.allowSpawn,
                          current.maxAgents,
                          e.target.checked,
                        )
                      }
                      disabled={!bridge}
                    />
                    <span>Pre-approve room tools</span>
                  </label>
                  <div className="policy-detail">
                    Lets managed agents call only this room&apos;s room_send
                    {current.allowSpawn ? ' and room_spawn' : ''} tools without a provider
                    permission prompt. All other tools keep your provider permissions, and your
                    deny rules still apply. Does not apply to Cursor sessions: Cursor only honors
                    allow rules from its own config files, which Alfred does not write.
                  </div>
                  <label className="policy-limit">
                    Session limit
                    <select
                      aria-label="Agent session limit"
                      value={current.maxAgents}
                      onChange={(e) =>
                        void updatePolicy(current, current.allowSpawn, Number(e.target.value))
                      }
                      disabled={!bridge}
                    >
                      {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
                        <option value={n} key={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="handoff-box">
                  <div className="handoff-label">
                    <span>MANUAL HANDOFF</span>
                    <span className="handoff-tag">LOCAL ONLY</span>
                  </div>
                  <p>
                    Send a note to a session by pasting it into its terminal. You choose when to
                    submit it.
                  </p>
                  <select
                    aria-label="Choose session for manual handoff"
                    value={activeSession?.id || ''}
                    onChange={(e) => setTarget(e.target.value)}
                    disabled={
                      !current.sessions.some((s) => s.kind === 'terminal' && s.status === 'running')
                    }
                  >
                    <option value="">
                      {current.sessions.some((s) => s.kind === 'terminal' && s.status === 'running')
                        ? 'Choose a session'
                        : 'No running sessions'}
                    </option>
                    {current.sessions
                      .filter((s) => s.kind === 'terminal' && s.status === 'running')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                  <textarea
                    aria-label="Manual handoff text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Write a note to paste into the terminal…"
                    disabled={!activeSession}
                  />
                  <button
                    aria-label="Paste one line to terminal"
                    className="paste-button"
                    disabled={!draft.trim() || !activeSession || !bridge}
                    onClick={() => void pasteHandoff()}
                  >
                    <span>Paste to terminal</span>
                    <span>↗</span>
                  </button>
                  <div className="handoff-note">
                    Pastes as one line without Enter. Press Enter in the terminal to send.
                  </div>
                </div>
              </aside>
            </div>
          </>
        )}
      </main>
      {notice && <div className="toast">{notice}</div>}
      {settingsOpen && (
        <SettingsPanel
          shortcuts={shortcuts}
          conflictMessage={shortcutConflict}
          capturingId={capturingAction}
          onStartCapture={(id) => {
            setShortcutConflict('');
            setCapturingAction(id);
          }}
          onCancelCapture={() => {
            setCapturingAction('');
            setShortcutConflict('');
          }}
          onCaptureCombo={onCaptureCombo}
          onReset={resetShortcuts}
          onClose={() => {
            setSettingsOpen(false);
            setCapturingAction('');
            setShortcutConflict('');
          }}
        />
      )}
      {addMultipleOpen && current && (
        <AddMultipleDialog
          agents={agents}
          maxAgents={current.maxAgents}
          managedCount={currentManagedCount}
          runningTerminalCount={globalRunningTerminalCount}
          onLaunch={launchMultiple}
          onClose={() => setAddMultipleOpen(false)}
        />
      )}
    </div>
  );
}
