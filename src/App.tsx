import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Agent = { id: string; name: string; available: boolean; path: string };
type Provider = 'shell' | 'claude' | 'codex';
type Session = { id: string; provider: Provider; status: 'running' | 'exited'; exitCode?: number };
type Room = { id: string; name: string; cwd: string; sessions: Session[]; createdAt: number };
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
const makeId = () => crypto.randomUUID();
const pathName = (p: string) => p.split('/').filter(Boolean).pop() || p || 'New room';
const terminalRegistry = new Map<string, Terminal>();
const outputBuffers = new Map<string, string[]>();

function TerminalPane({ session, onClose }: { session: Session; onClose: () => void }) {
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
        <b>{providers.find((p) => p.id === session.provider)?.label}</b>
        <span className={'run-state ' + session.status}>
          <i />
          {session.status}
        </span>
        <button className="icon-button close-pane" title="Close session" onClick={onClose}>
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

export default function App() {
  const bridge = window.rooms;
  const [rooms, setRooms] = useState<Room[]>([]);
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const [selected, setSelected] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [activityByRoom, setActivityByRoom] = useState<
    Record<string, { id: string; text: string; time: number; kind: 'system' | 'user' }[]>
  >({});
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingState, setLoadingState] = useState(!!bridge);
  const canPersist = useRef(false);
  const appendActivity = useCallback(
    (text: string, kind: 'system' | 'user' = 'system', roomId = selected) => {
      if (!roomId) return;
      setActivityByRoom((prev) => ({
        ...prev,
        [roomId]: [...(prev[roomId] || []), { id: makeId(), text, time: Date.now(), kind }].slice(
          -80,
        ),
      }));
    },
    [selected],
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
      .then((raw) => {
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
          })) as Room[];
        setRooms(restored);
        setSelected(restored[0]?.id || '');
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
            s.id === sessionId ? { ...s, status: 'exited', exitCode } : s,
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
    if (!bridge) return;
    if (!loadingState && canPersist.current)
      void bridge
        .saveState({
          rooms: rooms.map(({ id: roomId, name, cwd, createdAt }) => ({
            id: roomId,
            name,
            cwd,
            createdAt,
          })),
        })
        .catch(() => setNotice('Could not save rooms. Your running sessions are still available.'));
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
    const room = { id: makeId(), name: pathName(cwd), cwd, sessions: [], createdAt: Date.now() };
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
  async function addSession(provider: Provider) {
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
    const sessionId = makeId(),
      roomId = current.id,
      cwd = current.cwd;
    setRooms((prev) =>
      prev.map((r) =>
        r.id === roomId
          ? { ...r, sessions: [...r.sessions, { id: sessionId, provider, status: 'running' }] }
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
                  s.id === sessionId ? { ...s, status: 'exited', exitCode: 1 } : s,
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
    if (bridge) await bridge.closeSession(session.id).catch(() => {});
    outputBuffers.delete(session.id);
    setRooms((prev) =>
      prev.map((r) => ({ ...r, sessions: r.sessions.filter((s) => s.id !== session.id) })),
    );
    if (owner)
      appendActivity(
        providers.find((p) => p.id === session.provider)!.label + ' session closed.',
        'system',
        owner.id,
      );
  }
  async function removeRoom(room: Room) {
    if (bridge)
      await Promise.all(
        room.sessions
          .filter((s) => s.status === 'running')
          .map((s) => bridge.closeSession(s.id).catch(() => {})),
      );
    setRooms((prev) => prev.filter((r) => r.id !== room.id));
    setSelected(rooms.find((r) => r.id !== room.id)?.id || '');
  }
  const activity = current ? activityByRoom[current.id] || [] : [];
  const activeSession =
    current?.sessions.find((s) => s.id === target && s.status === 'running') ||
    current?.sessions.find((s) => s.status === 'running');
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
                    aria-label={
                      'Focus ' + providers.find((p) => p.id === s.provider)?.label + ' session'
                    }
                    className="session-row"
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
                    {providers.find((p) => p.id === s.provider)?.label}
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
                    <button
                      aria-label="Remove room"
                      onClick={() => {
                        setMenu(false);
                        void removeRoom(current);
                      }}
                    >
                      Remove room
                    </button>
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
                        {providers.map((p) => {
                          const agent = agents.find((a) => a.id === p.id);
                          return (
                            <button key={p.id} onClick={() => void addSession(p.id)}>
                              <span className={'provider-mark ' + p.id}>{p.mark}</span>
                              <span className="picker-text">
                                <b>{p.label}</b>
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
                          <TerminalPane
                            session={session}
                            onClose={() => void closeSession(session)}
                          />
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
                      Add a terminal or a detected coding agent to get started. Each session opens
                      in <code>{current.cwd || 'your selected folder'}</code>.
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
                    disabled={!current.sessions.some((s) => s.status === 'running')}
                  >
                    <option value="">
                      {current.sessions.some((s) => s.status === 'running')
                        ? 'Choose a session'
                        : 'No running sessions'}
                    </option>
                    {current.sessions
                      .filter((s) => s.status === 'running')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {providers.find((p) => p.id === s.provider)?.label}
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
                    Pastes as one line without Enter. Press Enter in the terminal to send. Automated
                    delegation is not connected yet.
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
