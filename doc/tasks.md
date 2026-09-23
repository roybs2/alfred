# Task tracker

Updated 2026-09-22. Milestone 1 (local terminal foundation) is implemented and tested on this Mac. Automated agent delegation is not implemented. This file is the handoff point for continued work.

## Done — foundation

- [x] New standalone Git project in `/Users/roy/repos/agent-rooms`.
- [x] Name and license decided by the owner (2026-09-22): product is **Alfred**, license **Apache-2.0**. See decisions.md.
- [x] Electron + React + TypeScript + xterm.js + node-pty with lockfile.
- [x] Isolated renderer, narrow preload API, main-frame IPC validation, CSP, provider allowlist.
- [x] Create, rename, switch and remove rooms; select a project directory.
- [x] Vertical session entries grouped under rooms; focus terminal from sidebar.
- [x] Real PTY shell input/output, resize, close and process-exit events.
- [x] Detect installed Claude Code and Codex; launch actions implemented through the same PTY path.
- [x] Side-by-side terminal panes; retain terminal instances when switching rooms.
- [x] Room-scoped activity for session lifecycle and manual paste.
- [x] Manual paste normalizes to one line, removes control characters, and never adds Enter. This is not automated delegation or lossless context transfer.
- [x] Persist room names/paths only; restart never pretends terminated sessions are live.
- [x] Bound session count (12), activity (80 per room), and saved metadata (1 MiB).
- [x] Close PTYs when removing a room or closing the app.
- [x] Five backend tests pass.
- [x] Production typecheck/build pass.
- [x] Real Electron/PTY smoke passes: UI room creation, two shells, input/output, safe manual paste, switching, removal, metadata restoration after restart.
- [x] Actual app screenshot: [workspace](screenshots/workspace.png).
- [x] npm audit reports no known vulnerabilities at initial installation.

## Capability validation — partial

- [x] Inspect installed CLI help without dispatching model tasks: Claude Code 2.1.280, Codex CLI 0.149.1.
- [x] Record Codex queue/agents/app-server and Claude background/attach/logs/stop paths.
- [x] Read official App Server and Agent SDK overview; document authentication caveat.
- [ ] Manually validate Claude and Codex interactive sessions with the user's chosen authentication. Detection is verified; model work has not been exercised by the smoke test.
- [x] Live-verify (2026-09-22) Claude managed path: bridge init status, session id, resume, headless room_send delivery to Codex, permission-denial behavior under default mode. Evidence in adapters.md.
- [x] Live-verify Codex required-bridge startup/failure and JSONL event parsing; live-verify cancellation (SIGTERM, bridge grandchild gone, task-failed).
- [x] Fix: Claude runner aborts at init when the room bridge failed/missing (was letting a billable turn run); Codex runner surfaces inner API error text and maps required-bridge startup failure.
- [x] Add explicit off-by-default "Pre-approve room tools" room policy (scoped Claude --allowedTools / Codex per-tool approval_mode; Codex enabled_tools limited to room tools). Unit and managed UI smoke tests.
- [ ] Live-verify a successful Codex turn, `codex exec resume`, Codex-initiated room_send, and that pre-approval suppresses denials (blocked: configured Codex model needs newer CLI; account usage limit).
- [x] Surface provider permission denials: runner `onPermissionDenied` → engine event `{type:'permission-denied', sessionId, roomId, taskId, text}` (tool name + short provider reason, ≤300 chars, never tool input). Sources: Claude `system/permission_denied` + `result.permission_denials` (deduped by tool_use_id); Cursor `tool_call.completed…result.rejected` (live-verified 2026-09-22). Codex has no documented denial event, so none is emitted. Unit tested. UI rendering pending (renderer owner).
- [x] Cursor CLI (2026.09.18-9a7762b) as a third provider (2026-09-22, evidence in adapters.md):
  - PTY: detected as `cursor-agent` (not the generic `agent` alias), in the provider allowlist. The UI picker list in `src/App.tsx` is hardcoded and still needs a Cursor entry.
  - Managed: `-p --output-format stream-json --stream-partial-output`, session id, and `--resume` verified live. The room bridge loads through a temporary `--plugin-dir` (never project or ~/.cursor files). Claude→Cursor `room_send` verified live.
  - Room-tool approval: under Cursor's default permission mode the bridge tools are auto-rejected in print mode (verified live). No per-process per-tool allow exists, so the room's pre-approve policy has no effect for Cursor. Workspace trust is never passed; an untrusted folder fails with a clear message.
- [ ] Cursor: live-verify a Cursor-initiated `room_send` that is allowed (needs a user-owned `Mcp(...)` allow rule), `room_spawn`, and cancellation.
- [ ] Verify owned session identity, message delivery acknowledgement, busy-session behavior, delegated-call cancellation, and room_spawn against real providers.
- [ ] Prove whether native subagent delegation can be redirected to another provider. Do not infer this from CLI launch or queue support.

## Next — native-friendly collaboration

1. Specify the smallest capability interface and preserve exact source context plus provenance.
2. Validate one real send/receive path for each provider using its supported interface.
3. Add a room-scoped bridge for send/spawn, with no routing LLM and no automatic context rewriting.
4. Add room policy for authorized autonomous spawn/dispatch, allowed providers, concurrency, and stop.
5. Display verified task/message events and parent/child relationships in Room Activity.
6. Measure token overhead where observable; keep UI/lifecycle events out of model prompts.
7. Test cross-provider task completion, failures, cancellation, and duplicate deliveries.

## Remaining UX/release work

- [ ] Resizable split handles and pane layout controls.
- [x] Distinct names/roles for multiple sessions of the same provider: renaming a managed session now calls `rooms:rename-agent-session`, which renames the real `AgentEngine` session (so `room_send` addresses the new name immediately) and only updates the UI on backend success; unit tests cover validation, per-room case-insensitive uniqueness, and `resolveDestination` after a rename.
- [x] Delegation transcript lines in a managed session's own pane are rendered from the live session name (source) and the target session id (current name), like Room Activity already did, instead of the names frozen into the event text.
- [x] Better recovery and persisted activity/session display history (no sensitive transcripts by default). Per room, `desktop/main.cjs` now persists `sessionHistory` (ended sessions: id/name/provider/kind/createdAt/endedAt/finalState, plus the managed provider's own opaque session/thread id when present) and `activityHistory` (short lifecycle/delegation/permission-denied labels only, never agent output or task text), both bounded (50 sessions/200 activity items per room, oldest dropped first) and sanitized at the `rooms:save-state` IPC boundary regardless of what the renderer sends. `rooms:save-state` already wrote atomically (temp file + rename); confirmed and covered by a new test. On restart every prior session renders as `ended` (never running/idle); a managed entry with a provider session id gets **Resume** (`AgentEngine.createSession({..., providerSessionId })`, validated as a short opaque string — never a credential, see decisions.md — so the provider's own CLI resumes on the next task); a terminal entry gets **Reopen** (new shell, same folder, no transcript restore); **Clear history** empties both fields for that room. Backend tests cover round-tripping, bounds, and that transcript/task-text-shaped or unknown fields are dropped rather than persisted. `tests/smoke.cjs` covers real-PTY close→ended-history→Reopen and the quit-while-running fallback across a real restart; `tests/managed-ui-smoke.cjs` covers close→ended-history→**Resume** end to end with a synthetic engine session (never a real provider call), including the opaque `providerSessionId` round-tripping through persisted state.
- [ ] Provider discovery beyond the Claude/Codex/Cursor/shell allowlist. Cursor backend support is done; its UI picker entry is pending.
- [ ] More accessibility and keyboard navigation checks.
- [ ] Define supported macOS versions and Intel/Apple Silicon release coverage.
- [ ] Signed/notarized installer, updates and clean-machine installation checks.
- [x] Name is Alfred; license Apache-2.0 (owner decision, 2026-09-22). No public repository or release has been published; publishing still needs explicit owner approval.

## Post-MVP (owner requests, 2026-09-22)

- [ ] Keyboard shortcuts for common actions, configurable in a Settings view (persist bindings only; no conflicts with terminal input).
- [ ] Open many terminals/agents in one room at once, with a focus mode that minimizes everything except the room (sidebar/activity collapsed, sessions tiled).

## Verification commands

`npm test` — isolated backend tests.

`npm run build` — TypeScript and production assets. One nonblocking bundle-size advisory remains.

`npm run test:smoke` — real Electron + local shell, isolated temporary app state; never launches billable agent work. Rewrites the workspace screenshot.

`npm run dev` — interactive development app.
