# Architecture

## Shape of the application

Alfred is a Mac-first Electron desktop application. Keep the process boundary clear: the renderer owns room navigation, vertical tabs, splits, and activity presentation; the privileged main process owns local persistence and process lifecycle; a narrow preload bridge exposes validated operations to the renderer. Do not expose unrestricted Node APIs to UI code. See "Current implementation and limits" below for the concrete process/IPC contract as built.

Local PTY processes remain the execution layer for interactive terminal sessions: a session is a child process started in a room working directory, with terminal input/output and lifecycle events passed through the desktop IPC boundary. Shell, Claude Code, Codex, and Cursor CLI are launched as local commands. CLI discovery is explicit and failure-tolerant: an unavailable CLI does not prevent shell use. Native permission-bypass flags must never be added implicitly. A separate headless path (`AgentEngine`) runs managed-agent sessions and the room MCP bridge; see below.

## Core entities

- **Room:** stable local identifier, display name, project path, creation/update metadata.
- **Session:** identifier, room identifier, command/provider label, working directory, lifecycle state, timestamps, and PTY reference while running.
- **Activity item:** timestamped lifecycle or user-visible handoff event, associated with a room and optionally a session.
- **Adapter capability:** a declared and tested set of operations for a provider/runtime. It must distinguish launching a CLI from native delegation support.

Persist room and tab metadata, not terminal secrets, credentials, or terminal transcripts. PTY process handles are runtime-only and must be re-established after application restart rather than treated as durable state.

## Execution and security boundaries

All terminal commands execute locally under the current user's account. The application should pass arguments without shell-string interpolation where practical, validate room working directories, and keep IPC methods narrowly scoped. Output can contain secrets; avoid writing terminal output to persistent logs by default. Stop/close behavior should surface process termination clearly.

Manual handoff between terminal sessions is a user-mediated copy/paste action. Room Activity may record that a handoff was prepared or pasted when that is observable, but must not claim receipt or completion unless it can verify it. It must not send an Enter keystroke automatically. Separately, a room-level dispatch policy ("Pre-approve room tools", plus spawn-allowed and session-limit policies) authorizes an agent to open or message other sessions without per-message provider confirmation, scoped to that room's own bridge tool names, visible in the room, revocable, and reflected in Room Activity. It never implies that a provider's other permission checks were bypassed — see "Current implementation and limits" and `doc/decisions.md`.

## Future adapter boundary

Provider-specific adapters should sit behind a stable internal interface and report their capabilities. Potential integrations include a documented SDK or app-server protocol, but only where official documentation supports the required operation. A generic CLI process adapter can launch and observe a process; that does not make it a native task-delegation adapter.

The product has no orchestration LLM. Routing, if added, must be deterministic/user-directed or delegated through a provider's supported protocol. Cross-provider flows should make context loss and user review visible.

## Current implementation and limits

### Processes

- **Main** (`desktop/main.cjs`): owns PTYs, provider/CLI discovery, project-state persistence, CSP,
  the application menu, keyboard-shortcut settings, and all validated `rooms:*` IPC handlers,
  including sanitization at the `rooms:save-state` boundary.
- **Renderer** (`src/App.tsx`): hosts rooms, split terminal panes, Room Activity (including the
  delegation tree), Settings, focus mode, and xterm instances; hidden room terminals stay mounted
  when switching rooms.
- **Preload** (`desktop/preload.cjs`): the narrow, validated bridge the renderer calls instead of
  raw Node/IPC.
- **`AgentEngine`** (`desktop/agent-engine.cjs`): manages headless managed-agent sessions
  (creation, resume, rename, cancellation, delegation tree, usage/permission-denial events), and a
  **`BridgeBroker`** listening on loopback with a per-task bridge token.
- **Per-turn bridge subprocess** (`desktop/room-mcp-bridge.mjs`): one short-lived MCP server per
  provider turn, spawned by the runner (`desktop/agent-runner.cjs`), exposing only `room_send` and,
  when the room allows spawning, `room_spawn`, authenticated to the broker by that turn's token.
  Claude reaches it via `--mcp-config`/`--strict-mcp-config`, Codex via per-process
  `-c mcp_servers.<id>.*` overrides, and Cursor via a temporary `--plugin-dir`. No project or
  user-level provider config file is ever written.

### Persisted data

`rooms:save-state` persists, per the current schema (sanitized regardless of what the renderer
sends):

- Rooms: id, name, project path, layout/`columns` setting, room policies (`preapproveRoomTools`,
  spawn allowed, session limit).
- Global `settings.shortcuts`: rebound keyboard-shortcut combos, validated against known action ids.
- Per-room `sessionHistory` (cap 50): ended sessions' id/name/provider/kind/timestamps/final state,
  plus a managed session's opaque `providerSessionId` (the provider's own session/thread id) when
  present.
- Per-room `activityHistory` (cap 200, each entry capped at 300 chars): short lifecycle/delegation/
  permission-denied labels only.

**Never persisted:** terminal output, agent transcripts, task text, or credentials. Live (not yet
ended) session state, running-session terminal buffers, and live Room Activity items beyond the
80-per-room in-memory cap are runtime-only and are not restored verbatim across a restart — on
restart every prior session renders as `ended`, and only the bounded, sanitized history above is
available for Resume/Reopen.

### Known limits

Quitting terminates PTYs; child processes that deliberately detach are not guaranteed to be
stopped. A room directory is a working directory, not a filesystem sandbox. Existing sessions
retain their launch directory when the room folder is changed; changes apply to subsequent
launches. Claude Code runs MCP tools not marked `readOnlyHint` one at a time, so a single Claude
turn with multiple `room_send` calls dispatches them sequentially rather than in parallel (a
provider-side limitation, not the engine's — `AgentEngine` itself supports concurrent delegated
calls). Codex's adapter has no documented permission-denial event, so denials are only surfaced for
Claude and Cursor. Cursor has no per-process tool-allow mechanism, so the room's "Pre-approve room
tools" policy has no effect on Cursor sessions. Manual handoff normalizes input to one line and
strips control characters to avoid unintended submission; this manual convenience is not reused as
the room-bridge delegation transport, which sends task text and provenance verbatim instead.
