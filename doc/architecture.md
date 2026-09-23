# Architecture

## Shape of the application

Alfred is a Mac-first Electron desktop application. Keep the process boundary clear: the renderer owns room navigation, vertical tabs, splits, and activity presentation; the privileged main process owns local persistence and process lifecycle; a narrow preload bridge exposes validated operations to the renderer. Do not expose unrestricted Node APIs to UI code. The current scaffold has Electron main/preload entry points and a React renderer; the concrete IPC contract and end-to-end behavior are still in progress.

The current MVP uses local PTY processes as its execution layer. A session is a child process started in a room working directory, with terminal input/output and lifecycle events passed through the desktop IPC boundary. Shell, Claude Code, and Codex are launched as local commands. CLI discovery should be explicit and failure-tolerant: an unavailable CLI must not prevent shell use. Native permission-bypass flags must never be added implicitly.

## Core entities

- **Room:** stable local identifier, display name, project path, creation/update metadata.
- **Session:** identifier, room identifier, command/provider label, working directory, lifecycle state, timestamps, and PTY reference while running.
- **Activity item:** timestamped lifecycle or user-visible handoff event, associated with a room and optionally a session.
- **Adapter capability:** a declared and tested set of operations for a provider/runtime. It must distinguish launching a CLI from native delegation support.

Persist room and tab metadata, not terminal secrets, credentials, or terminal transcripts. PTY process handles are runtime-only and must be re-established after application restart rather than treated as durable state.

## Execution and security boundaries

All terminal commands execute locally under the current user's account. The application should pass arguments without shell-string interpolation where practical, validate room working directories, and keep IPC methods narrowly scoped. Output can contain secrets; avoid writing terminal output to persistent logs by default. Stop/close behavior should surface process termination clearly.

The MVP manual handoff is a user-mediated copy/paste action. Room Activity may record that a handoff was prepared or pasted when that is observable, but must not claim receipt or completion unless it can verify it. It must not send an Enter keystroke automatically. A future room-level dispatch policy may authorize agents to open or message other sessions without per-message confirmation. Such a policy needs clear scope, visible targets, revocation, permission preservation, and observable activity; it must not imply that provider-level approvals were granted.

## Future adapter boundary

Provider-specific adapters should sit behind a stable internal interface and report their capabilities. Potential integrations include a documented SDK or app-server protocol, but only where official documentation supports the required operation. A generic CLI process adapter can launch and observe a process; that does not make it a native task-delegation adapter.

The product has no orchestration LLM. Routing, if added, must be deterministic/user-directed or delegated through a provider's supported protocol. Cross-provider flows should make context loss and user review visible.

## Current implementation and limits

`desktop/main.cjs` owns PTYs, discovery, persistence, CSP and validated IPC. `desktop/preload.cjs` exposes the narrow renderer bridge. `src/App.tsx` hosts rooms, in-memory activity and xterm instances; hidden room terminals remain mounted. `tests/backend.test.cjs` validates the backend with isolated mocks; `tests/smoke.cjs` drives the actual Electron app and real shells.

Only room names and project paths persist today. Sessions, terminal output and room activity are in-memory. Quitting terminates PTYs; child processes that deliberately detach are not guaranteed to be stopped. A room directory is a working directory, not a filesystem sandbox. Existing sessions retain their launch directory when the room folder is changed; changes apply to subsequent launches. The application has no standalone collaboration broker, native subagent interception or automatic dispatch yet.

Manual handoff normalizes input to one line and strips control characters to avoid unintended submission. This manual convenience must not be reused as the future lossless agent-context transport.
