# Roadmap

Statuses reflect visible code and evidence at the time of the latest update (2026-09-23). No
milestone should be marked complete solely because it is planned.

## 0. Capability validation — done

Read-only inspection of installed Codex CLI 0.149.1, Claude Code 2.1.280 and Cursor CLI
2026.09.18-9a7762b help and official docs produced a documented capability matrix (see
[native-integration.md](native-integration.md)), later confirmed against live behavior for Claude
and Cursor, and partially for Codex (bridge startup/parsing, not a full turn).

**Exit:** documented capability matrix with links to provider documentation, verified identity and
notification behavior, and clear distinctions between local session control, provider-native
delegation, and cross-provider handoff — met.

## 1. Local PTY workspace MVP — implemented and tested

Electron shell, room navigation, vertical grouped tabs, local PTY launch for shell and detected
CLIs, split terminal view, Room Activity lifecycle, and local room metadata persistence, with
explicit manual paste under user-controlled submission.

**Exit:** met. An operator can run the app on macOS, use a shell without agent CLIs installed,
launch supported installed CLIs, switch/split sessions, and restart without losing room metadata.

## 2. Structured delegation adapters — implemented; Claude and Cursor verified, Codex pending

A per-room MCP bridge (`AgentEngine` + `BridgeBroker` + `room-mcp-bridge.mjs`) exposes
`room_send`/`room_spawn` over each provider's documented headless/structured mode, per
[native-integration.md](native-integration.md): Claude `-p`/stream-json with `--mcp-config`, Codex
`exec --json` with per-process `-c mcp_servers.*` overrides, Cursor `-p`/stream-json with a
temporary `--plugin-dir`. Status, task creation/handoff, result events, cancellation and
permission-denial events are implemented for all three; manual PTY handoff remains available for
unsupported paths. Dispatch requires the user to opt into a room's "Pre-approve room tools" policy
before room tools bypass per-call provider confirmation.

**Exit:** each adapter has capability-specific implementation evidence and lifecycle handling.
Claude and Cursor are verified live end to end (see [adapters.md](adapters.md)). Codex's bridge
startup and event parsing are verified live; a full successful Codex turn is pending a CLI upgrade
(the installed 0.149.1 rejects the configured model, and the account hit its usage limit).

## 3. User-authorized agent dispatch — implemented

Room policies ("Allow agents to create sessions", per-room session limit, "Pre-approve room tools")
let an agent message or spawn another session in the room without per-dispatch provider confirmation
once the user opts in. Each policy is scoped to this room's own bridge tool names, visible in the
room UI, revocable, and logged in Room Activity when changed. Provider-level permissions are
preserved — pre-approval only names the room's own tools, never any other permission.

**Exit:** met in implementation and unit tests. Live confirmation that pre-approval suppresses
denials for Claude/Codex is pending the same Codex CLI/usage-limit block as milestone 2 (Cursor has
no equivalent pre-approval mechanism — see decisions.md).

## 4. Cross-provider workflows — demonstrated

A final end-to-end run (2 Claude + 2 Cursor managed agents) built a working one-page site through
three verified `room_send` delegations in one room, with the exact task text and provenance shown
in Room Activity's Delegations tree at every step. See
[adapters.md — Final end-to-end test 2026-09-22](adapters.md#final-end-to-end-test-2026-09-22).

**Exit:** met for Claude↔Cursor. Context boundaries are transparent (verbatim task text and
provenance headers, no rewriting), and workflows are inspectable in Room Activity. A Codex-involved
cross-provider workflow is pending the same Codex CLI blocker as milestones 2 and 3.

## 5. Polish and distribution — packaging done, release pending

Configurable keyboard shortcuts, focus mode, "Add multiple", resizable/balanced column layouts,
session/activity history recovery after restart, and unsigned macOS packaging (`.dmg`/`.zip` for
arm64 and x64) are all implemented — see [release.md](release.md). Name (Alfred) and license
(Apache-2.0) were decided by the owner on 2026-09-22 (see decisions.md).

**Exit:** clean install/upgrade paths and platform limitations are documented in
[release.md](release.md) (unsigned/not notarized, x64 untested on real hardware, no auto-update).
Remaining before this milestone closes: a signed/notarized build, a Homebrew cask, defined
supported macOS versions, and — pending the owner's approval, expected after the Codex
verification above — a GitHub Release and making the repository public.
