# Task tracker

Updated 2026-09-23. Alfred is a working Mac-first Electron app: local PTY terminals, headless
managed-agent sessions for Claude Code, Codex and Cursor CLI, a per-room MCP bridge for
`room_send`/`room_spawn` delegation, opt-in room policies, recovery after restart, configurable
shortcuts, focus mode, and macOS packaging. Claude and Cursor delegation are verified live
end-to-end, including a real multi-agent build (2 Claude + 2 Cursor). Codex is now also verified
live end-to-end (CLI upgraded to 0.156.1, usage limit reset): a full turn, `codex exec resume` on
the same thread, `room_send` in both directions (Claude→Codex and Codex→Claude), and the
`preapproveRoomTools` override suppressing Codex's own approval denial. `npm test` passes 45/45.
This file is the handoff point for continued work.

## Done — foundation

- [x] Electron + React + TypeScript + xterm.js + node-pty with lockfile.
- [x] Isolated renderer, narrow preload API, main-frame IPC validation, CSP, provider allowlist.
- [x] Create, rename, switch and remove rooms; select a project directory.
- [x] Vertical session entries grouped under rooms; focus terminal from sidebar.
- [x] Real PTY shell input/output, resize, close and process-exit events.
- [x] Detect installed Claude Code, Codex and Cursor CLI; launch through the same PTY path.
- [x] Side-by-side terminal panes; retain terminal instances when switching rooms.
- [x] Room-scoped activity for session lifecycle and manual paste.
- [x] Manual paste normalizes to one line, removes control characters, and never adds Enter.
- [x] Bound session count (12), activity (80 live per room), and saved metadata (1 MiB).
- [x] Close PTYs when removing a room or closing the app.
- [x] Production typecheck/build pass.
- [x] npm audit reports no known vulnerabilities at initial installation.

## Done — managed agents, bridge and delegation

- [x] `AgentEngine` (`desktop/agent-engine.cjs`) manages headless provider sessions, a
      `BridgeBroker` listening on loopback with per-task bridge tokens, and `room-mcp-bridge.mjs`
      exposing `room_send`/`room_spawn` as a per-process MCP server over that broker.
- [x] Headless runners (`desktop/agent-runner.cjs`) for Claude (`stream-json`), Codex (`exec --json`)
      and Cursor (`-p --output-format stream-json`), with resume, cancellation, bridge-init checks,
      and scoped opt-in room-tool pre-approval.
- [x] Stability fixes: test-hang fix (broker connections), stale-token race, cycle-detection gap,
      abort-before-spawn when the room bridge is missing/failed, long-running tool timeouts.
- [x] Delegation delivery envelope: a fixed reply-instruction line appended to every `room_send`/
      `room_spawn` provenance header (owner decision, see decisions.md).
- [x] Permission-denied events: `{type:'permission-denied', sessionId, roomId, taskId, text}` for
      Claude and Cursor denials (Codex has no documented denial event, so none is emitted).
- [x] Delegation tree in Room Activity, resolved by session id with provider labels, live even
      across renames.
- [x] Provider-reported usage only (never estimated): Claude cost + tokens, Codex tokens, Cursor
      tokens, surfaced on `task-completed` only when the provider actually reported it.
- [x] Session rename calls `rooms:rename-agent-session`, renaming the real `AgentEngine` session so
      `room_send` addresses the new name immediately; UI applies the rename only on backend success.
- [x] Hand-written React Markdown renderer for agent output (no raw HTML); nested lists, `<ol start>`
      numbering, and underscore-in-identifier fixes from the final e2e run.

## Done — providers

- [x] **Claude Code**: managed sessions via `-p`/stream-json, bridge via `--mcp-config` +
      `--strict-mcp-config`, resume, permission-denial parsing. Verified live end-to-end, including
      as a `room_send` caller and target.
- [x] **Cursor CLI**: PTY launch and managed headless turns (stream-json, resume); room bridge via
      a temporary `--plugin-dir` (no project/`~/.cursor` writes, no trust/force/approve-all flags).
      Verified live as a `room_send` target and as a caller whose own `room_send` is denied by
      Cursor's default permission mode (expected — no per-process tool allow exists for Cursor, so
      the room's pre-approval policy has no effect there).
- [x] **Codex**: adapter implemented (`exec --json`, resume, per-tool `approval_mode` overrides,
      `enabled_tools` scoping). Verified live end-to-end on 2026-09-23 against codex-cli 0.156.1: a
      full successful turn (`agent_message`/`turn.completed`, usage), `codex exec resume` on the same
      `thread_id`, required-bridge abort before any thread/model request, cancellation (SIGTERM, both
      process and bridge child gone), `room_send` as a delegation target (Claude→Codex) and as a
      caller (Codex→Claude) under both `preapproveRoomTools` off and on. CLI help and `-c` override
      parsing were re-checked against 0.156.1 first (no model call); no runner changes were needed.
      See [adapters.md](adapters.md#codex-live-verification-2026-09-23).
- [x] Opt-in room policies: "Allow agents to create sessions" (spawn) and per-room session limit;
      "Pre-approve room tools" scoped to only this room's `room_send`/`room_spawn` tool names via
      Claude `--allowedTools` / Codex `approval_mode` overrides (not applicable to Cursor — see
      decisions.md). Live-confirmed for both Claude and Codex on 2026-09-23: off, Codex's own
      approval policy denies its `room_send` call client-side with a clear error item and the turn
      still completes; on, the per-tool override suppresses the denial and the delegation completes.

## Done — UX

- [x] Resizable columns: 1/2/3/`Auto` layouts, drag + keyboard resize, minimum column width,
      `Auto` balances rows instead of leaving 3+1 gaps (2026-09-22 fix).
- [x] Provider usage display, safe Markdown rendering, delegation-aware Room Activity feed that
      pins to newest and never truncates.
- [x] Configurable keyboard shortcuts: 20 rebindable Cmd-based actions in a Settings dialog
      (`⌘,`), conflict refusal, reset to defaults; terminal input keeps plain keys and Ctrl-combos
      untouched; explicit app menu with no default Cmd-W window close.
- [x] Focus mode (`⌘⇧F`): hides sidebar/header chrome, tiles all of a room's sessions.
- [x] "Add multiple…": launch N sessions per provider at once, unique auto-numbered names, bounded
      by room and app session limits.

## Done — recovery

- [x] Per-room `sessionHistory` (cap 50) and `activityHistory` (cap 200) metadata, sanitized and
      bounded at the `rooms:save-state` IPC boundary regardless of what the renderer sends; never
      terminal output, agent transcripts, or task text.
- [x] On restart every prior session renders as `ended`. A managed session with a stored provider
      session id gets **Resume** (the provider's own CLI resumes via `providerSessionId`, validated
      as an opaque non-credential string). A terminal session gets **Reopen** (new shell, same
      folder, no transcript restore). Per-room **Clear history**.
- [x] `rooms:save-state` writes atomically (temp file + rename).

## Done — packaging, rename and license

- [x] Renamed the product to **Alfred**; license set to **Apache-2.0** (owner decision, 2026-09-22).
      Branding, `package.json` metadata, docs, and bridge/plugin tool ids all updated. `userData`
      migration copies saved rooms from the old `agent-rooms` directory on first launch.
- [x] GitHub remote `roybs2/alfred` created; kept **private** until the owner approves a release.
- [x] electron-builder packaging: unsigned `.dmg` + `.zip` for `arm64` and `x64`; `postdist:mac`
      rebuilds `node-pty` for the host Electron ABI after cross-arch packaging. `asarUnpack` covers
      `node-pty` and the room MCP bridge + its deps so both run from the packaged `app.asar`.
      Packaged `arm64` app verified directly (PTY works, bridge starts, DMGs mount); `x64` build
      produced but not launched on real Intel/Rosetta hardware. See `doc/release.md`.

## Verified live (pointers into doc/adapters.md)

- Claude: bridge init/status, session id + resume, headless `room_send` delivery, permission-denial
  behavior under default vs. `auto` mode — [Live verification 2026-09-22](adapters.md).
- Cursor: PTY detection, managed turn + resume, bridge via temp plugin dir, `room_send` as a target,
  own `room_send`/`shell` denied under default permission mode — [Cursor CLI live verification
  2026-09-22](adapters.md#cursor-cli-live-verification-2026-09-22).
- Cross-provider UI demo (Claude → Cursor, 3 runs) —
  [Live UI demo 2026-09-22](adapters.md#live-ui-demo-2026-09-22).
- Final end-to-end build (2 Claude + 2 Cursor, 3 `room_send` delegations, working site) —
  [Final end-to-end test 2026-09-22](adapters.md#final-end-to-end-test-2026-09-22).
- Codex: required-bridge startup/abort, JSONL event parsing, cancellation (SIGTERM), a full turn,
  `codex exec resume`, `room_send` as target and as caller (both pre-approval states) —
  [Codex live verification 2026-09-23](adapters.md#codex-live-verification-2026-09-23).
- Packaged-app checks (PTY, bridge startup, provider allowlist, DMG mount) — `doc/release.md`
  "Packaged-app testing".

## Pending

- [ ] Live-verify `room_spawn` against real providers (currently unit-tested only), for any provider.
- [ ] Live-verify busy-session queueing/duplicate-suppression and cancellation of a delegated call
      against real providers.
- [ ] Concurrent `room_send` fan-out from a single Claude turn is not available: Claude Code runs
      MCP tools that are not marked `readOnlyHint` one at a time, so a turn with multiple
      delegations sends them sequentially. This is a Claude Code limitation, not an Alfred one;
      Alfred's engine supports concurrent calls, but it has not been exercised live. Do not mark
      this done without a live multi-agent-in-parallel run.
- [ ] Render Markdown links (currently agent output text renders safely but link syntax is not
      turned into clickable links).
- [ ] Signed/notarized installer, auto-update wiring, and clean-machine installation checks (the
      current build is unsigned; see "Known limitations" in `doc/release.md`).
- [ ] Homebrew cask for `brew install --cask alfred` (referenced in the final e2e demo site and the
      README install instructions, not yet created).
- [ ] Define supported macOS versions and Intel/Apple Silicon release coverage explicitly (x64 is
      packaged but untested on real hardware).
- [ ] More accessibility and keyboard navigation checks.
- [x] GitHub Release [v0.1.0](https://github.com/roybs2/alfred/releases/tag/v0.1.0) published
      2026-09-23 with owner approval: unsigned dmg + zip for arm64 and x64. The packaged arm64 app
      passed smoke checks (detect agents, native PTY, provider allowlist, bridge tools) before
      upload. Repository made public the same day.

## Verification commands

`npm test` — isolated backend tests (45/45 passing as of 2026-09-23).

`npm run build` — TypeScript and production assets.

`npm run test:smoke` / `npm run test:smoke:managed` — real Electron + local shell, isolated
temporary app state; never launches billable agent work.

`npm run dev` — interactive development app.

`npm run dist:mac` — packaged unsigned macOS `.dmg`/`.zip` (see `doc/release.md`).
