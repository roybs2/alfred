# Decision log

Decisions and constraints recorded at project start. Add dated entries when implementation or provider research resolves open questions.

## Accepted direction

### Mac-first Electron desktop app

Start with a desktop app that can host local terminal sessions and room organization. Electron was chosen for the initial build because Node integrates directly with local CLIs and PTYs and lets the team iterate without introducing a Rust layer or sidecar. Measure resource use during polish before treating the choice as final. Keep the architecture portable where practical, while treating macOS as the first supported platform.

### Local CLIs remain the agent runtime

Use the user's installed command line tools and their established authentication. Keep Agent Rooms' first role to launching, organizing, and observing sessions.

### Minimal harness; no orchestration LLM

Agent Rooms does not add an LLM to decide which provider runs, translate every prompt, or reconstruct hidden context. Any future workflow must be user-directed or use a provider-supported protocol.

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

### License remains open

The project is intended to be open source, but the owner has not selected a license. Do not invent one or add a license file without that decision.

## Open questions

- Which officially documented Claude Code and Codex interfaces, if any, provide stable structured session or delegation control?
- What exact room and session metadata should survive restart?
- Which macOS versions and distribution channel will be supported first?
- Which open-source license does the owner want?
