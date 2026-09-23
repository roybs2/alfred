import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Agent = { id: string; name: string; available: boolean; path: string };
type Provider = 'shell' | 'claude' | 'codex';
type AgentProvider = 'claude' | 'codex';
type TerminalSession = {
  id: string;
  kind: 'terminal';
  provider: Provider;
  name: string;
  status: 'running' | 'exited';
  exitCode?: number;
};
type ManagedSession = {
  id: string;
  kind: 'managed';
  provider: AgentProvider;
  name: string;
  status: 'idle' | 'running' | 'failed' | 'stopped';
  transcript: {
    id: string;
    taskId?: string;
    role: 'user' | 'agent' | 'system' | 'task';
    text: string;
  }[];
};
type Session = TerminalSession | ManagedSession;
type Room = {
  id: string;
  name: string;
  cwd: string;
  sessions: Session[];
  createdAt: number;
  allowSpawn: boolean;
  maxAgents: number;
  preapproveRoomTools: boolean;
};
type AgentEvent = {
  type:
    | 'session-created'
    | 'task-started'
    | 'output'
    | 'task-completed'
    | 'task-failed'
    | 'session-stopped'
    | 'delegation';
  sessionId: string;
  roomId: string;
  taskId?: string;
  text?: string;
  targetSessionId?: string;
  targetTaskId?: string;
  session?: {
    id: string;
    roomId: string;
    provider: AgentProvider;
    name: string;
    status: ManagedSession['status'];
  };
};
type ActivityItem = {
  id: string;
  text: string;
  time: number;
  kind: 'system' | 'user';
  streamKey?: string;
};
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
  }): Promise<{
    id: string;
    roomId: string;
    provider: AgentProvider;
    name: string;
    status: ManagedSession['status'];
  }>;
  runAgentTask(input: { sessionId: string; text: string }): Promise<{ taskId: string }>;
  stopAgentSession(id: string): Promise<void>;
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
const providers: { id: Provider; label: string; detail: string; mark: string }[] = [
  { id: 'shell', label: 'Terminal', detail: 'Start a shell session', mark: '>_' },
  { id: 'claude', label: 'Claude Code', detail: 'Launch Claude in this folder', mark: '✳' },
  { id: 'codex', label: 'Codex', detail: 'Launch Codex in this folder', mark: '◈' },
];
const providerLabel = (id: Provider) => providers.find((p) => p.id === id)?.label || id;
const providerMark = (id: Provider) => providers.find((p) => p.id === id)?.mark || '◈';
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
const pathName = (p: string) => p.split('/').filter(Boolean).pop() || p || 'New room';
const terminalRegistry = new Map<string, Terminal>();
const outputBuffers = new Map<string, string[]>();
const appendTranscript = (
  session: ManagedSession,
  role: 'user' | 'agent' | 'system' | 'task',
  text: string,
  taskId?: string,
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
  return {
    ...session,
    transcript: [...session.transcript, { id: makeId(), taskId, role, text }].slice(-200),
  };
};

function TerminalPane({ session, onClose }: { session: TerminalSession; onClose: () => void }) {
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
        <span className={'provider-mark ' + session.provider}>
          {providers.find((p) => p.id === session.provider)?.mark}
        </span>
        <b>{session.name}</b>
        <span className={'run-state ' + session.status}>
          <i />
          {session.status}
        </span>
        <button
          className="icon-button close-pane"
          title="Close session"
          aria-label="Close session"
          onClick={onClose}
        >
          ×
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
  onRun,
}: {
  session: ManagedSession;
  onClose: () => void;
  onRun: (text: string) => Promise<void>;
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
        <b>{session.name}</b>
        <span className="mode-tag">MANAGED AGENT</span>
        <span className={'run-state ' + session.status}>
          <i />
          {session.status}
        </span>
        <button
          className="icon-button close-pane"
          title={session.status === 'stopped' ? 'Remove agent session' : 'Stop agent session'}
          aria-label={session.status === 'stopped' ? 'Remove agent session' : 'Stop agent session'}
          onClick={onClose}
        >
          ×
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
                      : 'STATUS'}
              </span>
              <p>{entry.text}</p>
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
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingState, setLoadingState] = useState(!!bridge);
  const canPersist = useRef(false);
  const lastSavedMetadata = useRef('');
  const appendActivity = useCallback(
    (text: string, kind: 'system' | 'user' = 'system', roomId?: string) => {
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
    if (!output?.trim()) return;
    const key = event.sessionId + ':' + event.taskId;
    setActivityByRoom((prev) => {
      const existing = prev[event.roomId] || [];
      const last = existing.at(-1);
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
          })) as Room[];
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
                    },
                  ],
                },
          ),
        );
        appendActivity(created.name + ' managed session created.', 'system', event.roomId);
        return;
      }
      const owner = roomsRef.current.find((r) => r.id === event.roomId);
      const name =
        owner?.sessions.find((s) => s.id === event.sessionId)?.name ||
        event.session?.name ||
        'Agent';
      setRooms((prev) =>
        prev.map((room) =>
          room.id !== event.roomId
            ? room
            : {
                ...room,
                sessions: room.sessions.map((session) => {
                  if (session.id !== event.sessionId || session.kind !== 'managed') return session;
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
                  if (event.type === 'task-completed') return { ...session, status: 'idle' };
                  if (event.type === 'task-failed')
                    return appendTranscript(
                      { ...session, status: 'failed' },
                      'system',
                      event.text || 'Task failed.',
                      event.taskId,
                    );
                  if (event.type === 'session-stopped') return { ...session, status: 'stopped' };
                  if (event.type === 'delegation' && event.text)
                    return appendTranscript(session, 'system', event.text, event.taskId);
                  return session;
                }),
              },
        ),
      );
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
    });
  }, [bridge, appendActivity, appendOutputActivity]);
  useEffect(() => {
    if (!bridge || loadingState || !canPersist.current) return;
    const metadata = rooms.map(
      ({ id: roomId, name, cwd, createdAt, allowSpawn, maxAgents, preapproveRoomTools }) => ({
        id: roomId,
        name,
        cwd,
        createdAt,
        allowSpawn,
        maxAgents,
        preapproveRoomTools,
      }),
    );
    const signature = JSON.stringify(metadata);
    if (signature !== lastSavedMetadata.current) {
      lastSavedMetadata.current = signature;
      void bridge.saveState({ rooms: metadata }).catch(() => {
        lastSavedMetadata.current = '';
        setNotice('Could not save rooms. Your running sessions are still available.');
      });
    }
  }, [rooms, bridge, loadingState]);
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void addRoom();
      }
      if (event.key === 'Escape') {
        setPicker(false);
        setMenu(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bridge]);
  async function addSession(provider: Provider, kind: Session['kind']) {
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
    const name = sessionName(current.sessions, provider, kind);
    if (kind === 'managed') {
      try {
        const created = await bridge.createAgentSession({
          roomId,
          provider: provider as AgentProvider,
          cwd,
          name,
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
                    },
                  ],
                },
          ),
        );
        setTarget(created.id);
      } catch (error) {
        setNotice('Could not connect agent: ' + String(error));
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
                { id: sessionId, kind: 'terminal', provider, name, status: 'running' },
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
    if (owner) appendActivity(session.name + ' closed.', 'system', owner.id);
  }
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
  }
  const activity = current ? activityByRoom[current.id] || [] : [];
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
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-glyph">◈</span>
          <span>ROOMS</span>
          <span className="brand-beta">DESKTOP</span>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <button
          aria-label="Create room and choose a folder"
          className="new-room"
          onClick={() => void addRoom()}
        >
          <span className="plus">＋</span> New room <span className="shortcut">⌘ N</span>
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
                room.sessions.map((s, index) => (
                  <button
                    key={s.id}
                    aria-label={'Focus ' + s.name + ' session'}
                    className={'session-row ' + (target === s.id ? 'focused' : '')}
                    onClick={() => {
                      document
                        .getElementById('pane-' + s.id)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                      terminalRegistry.get(s.id)?.focus();
                      setTarget(s.id);
                    }}
                  >
                    <span className="tree-mark">
                      {index === room.sessions.length - 1 ? '└' : '├'}
                    </span>
                    <span className={'session-mini ' + s.status} />
                    <span className="session-row-name">{s.name}</span>
                    <span className="session-status-label">{s.status}</span>
                  </button>
                ))}
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
                  <div className="add-wrap">
                    <button className="add-session" onClick={() => setPicker(!picker)}>
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
                      </div>
                    )}
                  </div>
                </div>
                {rooms.some((r) => r.sessions.length > 0) && (
                  <div
                    className="terminal-stack"
                    style={{ display: current.sessions.length ? undefined : 'none' }}
                  >
                    {rooms.flatMap((room) =>
                      room.sessions.map((session) => (
                        <div
                          id={'pane-' + session.id}
                          key={session.id}
                          className={'pane-anchor ' + (room.id === current.id ? '' : 'pane-hidden')}
                        >
                          {session.kind === 'terminal' ? (
                            <TerminalPane
                              session={session}
                              onClose={() => void closeSession(session)}
                            />
                          ) : (
                            <ManagedPane
                              session={session}
                              onClose={() => void closeSession(session)}
                              onRun={(text) => runAgentTask(session, text)}
                            />
                          )}
                        </div>
                      )),
                    )}
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
                <div className="activity-list">
                  {activity.length ? (
                    activity.map((item) => (
                      <div key={item.id} className={'activity-item ' + item.kind}>
                        <span className="activity-symbol">{item.kind === 'user' ? '↗' : '·'}</span>
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
                    Connected agents can message peers. Enable this to let them create new sessions.
                    Provider permissions still apply.
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
                    deny rules still apply.
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
    </div>
  );
}
