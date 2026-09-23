# Decision log

Decisions and constraints recorded at project start. Add dated entries when implementation or provider research resolves open questions.

## Accepted direction

### Mac-first Electron desktop app

Start with a desktop app that can host local terminal sessions and room organization. Electron was chosen for the initial build because Node integrates directly with local CLIs and PTYs and lets the team iterate without introducing a Rust layer or sidecar. Measure resource use during polish before treating the choice as final. Keep the architecture portable where practical, while treating macOS as the first supported platform.

### Local CLIs remain the agent runtime

Use the user's installed command line tools and their established authentication. Keep Alfred's first role to launching, organizing, and observing sessions.

### Minimal harness; no orchestration LLM

Alfred does not add an LLM to decide which provider runs, translate every prompt, or reconstruct hidden context. Any future workflow must be user-directed or use a provider-supported protocol.

### MVP handoff is explicit; room authorization can reduce future friction

The initial handoff path can copy/paste between sessions, but the user must review and submit the receiving prompt. The app must not press Enter automatically in this MVP. Future room-level policy may explicitly authorize an agent to open or message another session without a confirmation for each dispatch; policy scope, targets, permissions, activity, and revocation must remain clear. Manual paste is not native delegation.

### Truthful delegation labels

Do not claim native delegation redirects, structured delegation, or cross-provider context transfer until verified in implementation and provider documentation.

### Room tools can be pre-approved only by explicit room policy

Decided 2026-09-22 after live evidence: Claude Code in `-p` mode denies the room bridge's `room_send` under the default permission mode (`system/permission_denied`) but allows it under `auto`.

Rooms have a `preapproveRoomTools` policy flag. It is off by default, shown as "Pre-approve room tools" in the room policy panel, persisted with room metadata, and logged in Room Activity when changed. When it is on, the runner:
- **Claude:** adds `--allowedTools mcp__<this bridge>__room_send`, plus `…__room_spawn` only when spawning is allowed. These are exact-name documented allow rules for this process's bridge only, with no wildcards. User and managed deny/ask rules still take precedence.
- **Codex:** adds the documented per-tool override `mcp_servers.<this bridge>.tools.<tool>.approval_mode="approve"` for the same tool names.

The runner always restricts Codex's bridge exposure with `enabled_tools`, so `room_spawn` is only exposed when the room allows it. It never changes the permission mode, sandbox, approval policy, or any other tool's permission, and it never passes bypass flags. Live confirmation of the flags is still pending (see adapters.md).

### Cursor CLI: bridge via temporary plugin dir, no trust or approval shortcuts

Decided 2026-09-22 after reading Cursor CLI 2026.09.18-9a7762b help and docs and running live tests (see adapters.md).
- **MCP config.** Cursor documents MCP config only in `.cursor/mcp.json` (project) and `~/.cursor/mcp.json` (global); neither is written. The runner uses the documented `--plugin-dir <path>` flag with a private temporary plugin (`.cursor-plugin/plugin.json` + `mcp.json`, owner-only permissions) that defines only this task's room bridge. The directory holds the per-task bridge token and is removed when the process exits. Its basename and server key are fixed (`agent-rooms`/`agent_rooms`), so Cursor's tool id `plugin-agent-rooms-agent_rooms-room_send` stays stable across resumes. The bridge registers `room_spawn` only when the room allows spawning (`AGENT_ROOMS_TOOLS`), because Cursor has no per-process tool filter.
- **Pre-approval.** Not applied for Cursor. Its per-tool allow syntax `Mcp(server:tool)` exists only in `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`. `--approve-mcps` approves every configured MCP server, and `--force`/`--yolo` run everything, so none of these is used. In print mode under the default permission mode, the room tools are therefore auto-rejected. This is reported as a `permission-denied` event. A user may add their own allow rule, which is unverified.
- **Workspace trust.** Print mode refuses an untrusted folder. The runner never passes `--trust`; it reports "open a Cursor terminal session in this room and answer its trust prompt". The live harness passed `--trust` only for its throwaway scratch directory.
- **Prompt input.** No stdin prompt input is documented, so the prompt is one argv element after `--` (no shell). It is visible to local process listings for the life of the turn.
- **Bridge check.** Cursor's `system/init` reports no MCP status, so unlike Claude and Codex a failed bridge cannot be detected before the model turn.

### Product name and license (owner decision, 2026-09-22)

The owner named the product **Alfred** and set its license to **Apache-2.0** (LICENSE already present in the repo). This supersedes the earlier constraint in AGENTS.md against choosing a name or claiming a license. User-visible branding (window title, sidebar logo, HTML title, `package.json` name/productName/description/license, activity/policy copy, the MCP server name reported by `room-mcp-bridge.mjs`, and docs) was updated to Alfred. "Rooms" remains the in-product concept — Alfred has rooms.

Kept unchanged, deliberately: IPC channel names (`rooms:*`), env var names (`AGENT_ROOMS_*`, including the `x-agent-rooms-token` bridge header), the MCP tool names `room_send`/`room_spawn`, and the Cursor plugin folder/server name `agent-rooms` (so the tool id `plugin-agent-rooms-agent_rooms-room_send` recorded in adapters.md is still accurate and did not need updating). Only the MCP server's own reported `name` field in `room-mcp-bridge.mjs` (as seen via `initialize`/tools metadata, not the Cursor plugin id) changed to `alfred`.

Electron derives the default userData directory from the app name; adding `productName: "Alfred"` moves that directory. `desktop/main.cjs` now migrates `project-state.json` from the previous `agent-rooms` userData directory into the new one on first launch when the new directory has no saved state yet, so existing rooms are not lost. Covered by backend tests in `tests/backend.test.cjs`.

## Open questions

- Which officially documented Claude Code and Codex interfaces, if any, provide stable structured session or delegation control?
- What exact room and session metadata should survive restart?
- Which macOS versions and distribution channel will be supported first?
