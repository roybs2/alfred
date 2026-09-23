# Agent adapters and delegation

## Why this boundary matters

Starting a provider's CLI in a PTY is not the same as integrating its agent protocol. It gives Alfred a local terminal session, but does not by itself expose structured task creation, internal state, tool events, cancellation, or delegation. The UI and documentation must keep those capabilities separate.

## MVP adapter: local process

The initial adapter is a process launcher for shell, Claude Code, and Codex when installed. Its responsibility is limited to executable discovery, starting the command in a room's working directory, connecting PTY input/output, and reporting process lifecycle. It should not extract credentials, infer private agent state, or claim native delegation support.

The manual handoff path is user-mediated: prepare or copy a prompt, let the user paste it into the receiving session, and leave final submission to the user. Activity records should describe only observed events.

## Future structured adapters

An adapter may expose operations such as `discover`, `start`, `sendUserApprovedTask`, `readEvents`, `cancel`, and `capabilities`, but each operation is optional and must be backed by a provider-supported mechanism. Capability declarations should be explicit, for example:

| Capability | Meaning |
| --- | --- |
| `launchCli` | Start the provider's installed CLI in a local PTY. |
| `structuredEvents` | Receive documented, machine-readable session events. |
| `taskHandoff` | Submit a user-approved task through a supported interface. |
| `nativeDelegation` | Provider itself supports delegating work to another agent/session through a documented mechanism. |
| `crossProviderContext` | A supported mechanism transfers specified context across providers. |

One capability must never be inferred from another. In particular, `launchCli` does not imply `nativeDelegation` or `crossProviderContext`.

## Locally observed CLI control paths (2026-09-22)

Read-only help inspection on the development machine found more useful control surfaces than a launch-only model suggests:

- **Codex CLI 0.149.1** lists `agents` for browsing agent sessions on a shared local app-server daemon, `app-server` tooling, and `queue` for sending a message to an existing session. `codex queue --help` accepts a session UUID or exact session name and a message. This is a promising user-directed way to address an existing Codex session. It is not evidence of Claude-to-Codex native delegation, hidden context transfer, or completion notifications. We have not yet verified how names are discovered, how queue acknowledgement works, whether the target session receives a visible notification, or what identity and permission boundary is applied.
- **Claude Code 2.1.280** advertises background sessions via `--bg` (returns an ID), `agents` (can list active sessions as JSON), `attach`, `logs`, and `stop`/`kill`; `--resume` can continue a background session. These are promising lifecycle and observability hooks. Help output does not establish a stable external API for dispatching a task into a running session or cross-provider delegation, and notification delivery/acknowledgement remains unverified.

These observations are specific to the installed versions and may change. The CLI help was inspected without creating or messaging an agent session. Before implementing, verify official provider docs, session identity/discovery, ownership, notification and acknowledgement semantics, event freshness, cancellation, and auth behavior. In the MVP, the user reviews and submits each manual paste. Later, a user may explicitly authorize a room-level policy that lets an agent open or message another agent without a confirmation for every dispatch; show policy scope and activity, preserve provider permissions, and make authorization revocable. Keep manual copy/paste as a fallback.

## Official integration references

- [Codex App Server](https://developers.openai.com/codex/app-server) is an official integration surface to assess alongside the installed CLI's `app-server` and `queue` commands. Verify its current protocol, supported operations, authentication, and notification behavior before adopting it.
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) describes embedding the Claude Code agent loop in an application process, while the CLI is the interactive terminal path. Its docs say SDK quickstart uses an API key and third-party products may not offer claude.ai login or rate limits absent approval. Validate this constraint before choosing the SDK path.

SDK/app-server integrations differ from launching an already installed local CLI. Launching the local CLI uses that tool's own sign-in and permission flow; it does not by itself grant Alfred structured API control. Avoid silently switching users from their CLI authentication to API billing.

## Provider research notes

Provider interfaces and terms change over time. Before implementing an adapter, consult current official documentation and record the date, exact supported protocol, authentication path, event semantics, and any preview/beta status. SDKs may support building applications on a model API without controlling an existing interactive CLI; an app-server may expose a protocol without supporting arbitrary cross-provider delegation. Verify each required action rather than relying on product naming.

At the time this doc was created, local CLI help has verified the existence of potentially useful Codex session queue/browse commands and Claude background session lifecycle commands. Their end-to-end integration has not been verified in this repository. Native cross-provider delegation, delegation redirects, and hidden context transfer are not implemented and must not be described as available.

## Live verification 2026-09-22

Owner-authorized minimal live runs of the managed-agent path (`AgentEngine` + `BridgeBroker` + `room-mcp-bridge.mjs` + `cliRunner`) against the real provider CLIs, driven by a scratch harness outside the repository that requires the real `desktop/agent-engine.cjs` and `desktop/agent-runner.cjs`. Environment: Claude Code 2.1.280, codex-cli 0.149.1, Node v26.3.0 as the bridge executable, macOS, a fresh `git init`'d temporary directory as the room cwd, the user's existing sign-in. Parent Claude Code session variables were removed from the child environment to mimic a GUI launch. No permission-bypass flag was passed. Evidence below is event types, IDs, and timings only; no transcripts were stored in the repository.

### Claude Code: verified

- **Single turn.** Spawned `claude -p --input-format text --output-format stream-json --verbose --include-partial-messages --mcp-config <json> --strict-mcp-config`. Event order: `system/hook_started` ×2, `system/hook_response` ×2 (the user's own hooks), `system/init`, `system/status`, `stream_event` deltas, `assistant`, `rate_limit_event`, `result/success`. Task completed in about 3.6 s with the result `OK` and captured session id `94d0d3c4-…`.
- **`system/init` shape matches the parser.** `mcp_servers` is `[{ name, status, source }]`, for example `{ name: "agent_rooms_<session uuid with _>", status: "connected", source: "dynamic" }`. `--strict-mcp-config` loaded only the room bridge. `tools` listed only `mcp__agent_rooms_…__room_send` and `…__room_spawn` from MCP. `permissionMode` reported the user's setting (`auto`). No `mcp_server_errors` key was present, so that branch of the parser is defensive only.
- **Failed bridge.** With `/usr/bin/false` as the bridge command, init reported `status: "failed"` and an empty `tools` list. The runner used to wait for the full model turn before failing. It now kills the process at init, before any assistant event (see the fixes below).
- **Resume.** A second task on the same managed session spawned the same argv plus `--resume 94d0d3c4-…`. Init and result both reported the same `session_id`, and the task completed in about 3.9 s.
- **Cross-provider `room_send` (Claude to Codex), under the user's `permissionMode: auto`.** Claude found the deferred tool through `ToolSearch` and called `mcp__agent_rooms_…__room_send` with `{to: "Codex", task: "Reply with the word OK and nothing else."}`. `result.permission_denials` was empty, so the call was permitted. The engine emitted `delegation` (`Claude → Codex`), then created and ran a Codex task containing the exact provenance header and task text. The Codex child failed on its account usage limit (see below). That failure went back to Claude as an MCP `tool_result` with `is_error: true`, and Claude's own task then completed normally. The whole path was exercised live except a successful Codex reply: Claude to MCP stdio bridge to loopback broker token check to engine to Codex spawn to error propagation.
- **Cross-provider `room_send` under `--permission-mode default`.** This was a harness-only diagnostic. It is stricter than the user's setting and is not a bypass. The same call was **denied**: the stream emitted `system/permission_denied` ("Claude requested permissions to use mcp__agent_rooms_…__room_send, but you haven't granted it yet."), and `result.permission_denials` listed the tool. **Finding:** headless room collaboration does not work for users whose Claude permission mode prompts for MCP tools unless the room tools are allowed. This led to the scoped pre-approval option described in the decision log.

### Codex: partially verified

- **MCP bridge startup with `required=true`.** Verified. `thread.started` came about 0.5–1.8 s after spawn, and `ps` then showed `node …/desktop/room-mcp-bridge.mjs` as a child of the `codex exec` process. With `/usr/bin/false` as the bridge, Codex exited 1 before `thread.started`, and stderr contained `required MCP servers failed to initialize: agent_rooms_…: handshaking with MCP server failed`. No model request was made.
- **JSONL parsing.** `thread.started` with `thread_id` (UUIDv7 form, for example `01a0cbf1-12a4-…`), `turn.started`, and non-fatal `item.completed` items with `item.type: "error"` (warnings) were observed. The runner correctly ignores the warning items. Terminal failure appeared as `error` with a `message` string, followed by `turn.failed` with `error.message`.
- **Not verified: turn completion and resume.** No Codex turn completed.
  - The user's configured default model (`gpt-6-astra`) is rejected by this CLI version: "requires a newer version of Codex" (HTTP 400).
  - The harness then pinned the cheaper listed model `gpt-5.6-luna`. This was a harness-only `-c model=…` and the runner never sets a model. Every attempt then failed with "You've hit your usage limit … try again at Sep 23rd, 2026 1:44 AM" (local time).
  - `turn.completed`, `agent_message` capture, `thread_id` persistence after a successful turn, and `codex exec resume` were therefore not observed live.
  - Because both turns failed, the runner (correctly) did not store the thread id, and the second task started a new thread instead of resuming.
- **Codex as the `room_send` caller.** Not run.

### Cancellation: verified

This check used Codex. `stopSession` was called about 2.5 s after spawn, after `thread.started`/`turn.started` and while the child and its bridge grandchild were running. The engine immediately emitted `task-failed` ("Agent session stopped") and `session-stopped`. The child closed with signal `SIGTERM`. After 4.5 s, `kill(pid, 0)` failed and `ps` showed no `room-mcp-bridge` process. Cancellation during a delegated `room_send` was not exercised live; unit tests still cover it.

### Model turns used

- **Claude:** 4 turns that reached the model (single turn, resume, two cross-provider sends). A fifth process was killed at init on the failed-bridge check before any assistant event, so it probably made no model request.
- **Codex:** 8 `turn.started` attempts, and none produced a model response. Two were rejected with HTTP 400 for the model version, five hit the usage limit, and one was cancelled by the cancellation check. One further run (the failed bridge) never reached a turn.

### Remains

- A successful Codex turn, `codex exec resume` on the same thread, and a Codex-initiated `room_send`. These need a Codex CLI upgrade for the configured model, or an owner-chosen model, and available usage.
- Live confirmation that the new pre-approval flags actually suppress the denial:
  - Claude: `--allowedTools mcp__<bridge>__room_send[,room_spawn]`.
  - Codex: per-tool `approval_mode="approve"`. Only config parsing has been verified, via `codex mcp get --json`, which also rejects unknown variants.
  - Whether `codex exec` prompts, auto-denies, or auto-allows MCP tool calls without the override is still unknown.
- ~~Surfacing `permission_denials` / `system/permission_denied` as a visible activity event.~~ Done: engine `permission-denied` event (see the Cursor section for the live check).
- Delegated-call cancellation, busy-target queueing, and `room_spawn` against real providers.

## Cursor CLI live verification 2026-09-22

The owner authorized adding Cursor CLI and a small live test budget of at most 4 Cursor model turns with trivial prompts. Environment: `cursor-agent` 2026.09.18-9a7762b at `~/.local/bin/cursor-agent` (the installer also creates a generic `agent` alias, which detection ignores). Signed in with the user's Cursor login (`apiKeySource: "login"`). `model: "Auto"`, the user's default; no `--model` was passed. Node v26.3.0 ran the bridge. Each run used a fresh `git init`'d temporary room directory. The harness is the same scratch harness as above, driving the real `AgentEngine`, `BridgeBroker`, and `cliRunner`. No transcripts are stored here.

### Read-only surface (help and official docs)

- **Help.** `-p/--print` ("Has access to all tools, including write and shell"), `--output-format text|json|stream-json`, `--stream-partial-output`, `--resume [chatId]`, `--continue`, `create-chat`, `--mode plan|ask`, `--plugin-dir <path>`, `--approve-mcps` ("Automatically approve all MCP servers"), `--trust`, `-f/--force`/`--yolo`, `--auto-review`, `--sandbox`. `mcp` subcommands: `list`, `list-tools`, `login`, `enable`, `disable`. They read only `.cursor/mcp.json` and `~/.cursor/mcp.json`; `mcp list`/`list-tools` ignored `--plugin-dir`.
- **Docs.**
  - [Output format](https://cursor.com/docs/cli/reference/output-format): `system/init` with `session_id`, `model`, and `permissionMode`; then `user`, `assistant`, `tool_call` `started`/`completed`, and `result` with `result`, `is_error`, and `session_id`. With partial output, deltas carry `timestamp_ms`, and the flush before a tool call carries `model_call_id`.
  - [Headless](https://cursor.com/docs/cli/headless): "Without --force, changes are only proposed, not applied".
  - [Permissions](https://cursor.com/docs/cli/reference/permissions): `Mcp(server:tool)` rules live in `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`.
  - [MCP](https://cursor.com/docs/context/mcp): "Cursor asks for approval before using MCP tools by default".
  - [Plugins](https://cursor.com/docs/plugins) and [plugin reference](https://cursor.com/docs/reference/plugins): `.cursor-plugin/plugin.json` (with `name`) plus a root `mcp.json` with `mcpServers`.

### Observed

- **Workspace trust.** Without trust, print mode exits 1 in about 0.3 s, before any model request, with "Workspace Trust Required … Pass --trust, --yolo, or -f". The runner maps this to a clear message and never passes those flags. The harness passed `--trust` only for its scratch directories. This was a harness-only change, like the earlier `--permission-mode` diagnostic.
- **Single turn (turn 1).** `-p --output-format stream-json --stream-partial-output --plugin-dir <tmp>/agent-rooms -- <prompt>`.
  - Events: `system/init` (keys `apiKeySource, cwd, session_id, model, permissionMode`; `permissionMode: "default"`; no MCP status field), `user`, `thinking` `delta`/`completed` (ignored), an `assistant` delta, the final full `assistant` message (no `timestamp_ms`), `result/success` (`duration_ms` 3034, `usage`).
  - The task completed with `OK` in about 10.5 s wall time, with session id `1d2e7ebc-…`.
- **Bridge loaded through `--plugin-dir`.** At `system/init`, `ps` showed `node …/desktop/room-mcp-bridge.mjs` as a child of `cursor-agent`. The tool was exposed as `plugin-<plugin dir basename>-<server key>-room_send`. After the change to a fixed basename, the id became `plugin-agent-rooms-agent_rooms-room_send` (server `plugin-agent-rooms-agent_rooms`). Loading the plugin may depend on a Cursor-side feature gate (`enableUserLocalPlugins`) and has not been verified on other accounts or versions. Nothing was written to the project or to `~/.cursor`, and the temporary plugin directories were gone after each run. This evidence was captured while the Cursor plugin folder/server name was still `agent-rooms`; the 2026-09-22 rename to Alfred deliberately kept that plugin name unchanged (see decisions.md), so the tool id above is still accurate. It is unrelated to `room-mcp-bridge.mjs`'s own `McpServer` name, which is now `alfred`.
- **Resume (turn 2).** The same argv plus `--resume 1d2e7ebc-…` kept the same `session_id` in init and result.
  - In this resumed chat, the model called the tool under the first turn's randomly named plugin id. That led to the fixed plugin naming.
  - The result text concatenates all assistant segments, including the pre-tool preamble (`"…DONE.DONE"`). The runner passes it through unchanged.
- **Approval (turns 2 and 4).** A Cursor-initiated `room_send` under `permissionMode: "default"` was auto-rejected about 130–180 ms after `tool_call.started`, before reaching the bridge.
  - Observed shapes: `tool_call.started` carries `{mcpToolCall:{args:{toolName:"room_send", providerIdentifier, skipApproval:false, …}}}`; `tool_call.completed` (same `call_id`) carries only `{mcpToolCall:{result:{rejected:{reason:"User rejected MCP: plugin-agent-rooms-agent_rooms-room_send"}}}}`.
  - In turn 4, the engine emitted `{type:"permission-denied", …, text:"mcp: User rejected MCP: …"}`. The tool name came out as `mcp` because the completed event has no `args`. The runner now keys the tool name by `call_id` from `started`. Replaying that raw stream through the fixed runner produced `room_send: User rejected MCP: plugin-agent-rooms-agent_rooms-room_send`.
  - Tool discovery (`getMcpToolsToolCall`) ran without approval.
- **Claude→Cursor `room_send` (turn 3, plus 1 Claude task).** Under the user's `auto` mode, Claude called `mcp__agent_rooms_…__room_send {to:"Cursor"}`. Claude's init `tools` listed only `room_send`, because the bridge now hides `room_spawn` when spawning is disabled.
  - The engine emitted `delegation` (`Claude → Cursor`) and ran a Cursor task containing the exact provenance header. Cursor's bridge child started, the task completed (session `5136311a-…`, `duration_ms` 16809), and the result came back to Claude as a successful `tool_result`.
  - Claude's task then completed with `permission_denials: []` and a reported cost of $0.146, across 3 API iterations in one task.

### Model turns used

- **Cursor:** 4 turns that reached the model: single turn, resume + `room_send` attempt, Claude→Cursor target, and the denial event check. Two earlier spawns stopped at the trust check before any model request.
- **Claude:** 1 task (the `room_send` caller).
- **Codex:** not used; it is rate-limited until Sep 23, 1:44 AM.

### Not verified for Cursor

- An allowed Cursor-initiated `room_send`. This would need a user-owned allow rule such as `Mcp(plugin-agent-rooms-agent_rooms:room_send)`; the exact server-name form in rules has not been tested.
- `room_spawn` of a Cursor agent against the real CLI, cancellation/SIGTERM of `cursor-agent` and its bridge child, failed-bridge detection (init reports no MCP status), and denial shapes for non-MCP tools.

## Live UI demo 2026-09-22

The owner authorized a visible end-to-end run in the real Alfred app, with a budget of at most 3 Claude and 3 Cursor model turns. Codex was not used (rate-limited until Sep 23, 1:44 AM). A scratch Playwright script, kept outside the repo, launched the built Electron app in test mode with isolated userData. It used the real detected CLIs, the real `cliRunner` and `BridgeBroker`, and the real renderer. The room folder was a throwaway directory in the session scratchpad (`index.html` plus `git init`), never inside this repo. No permission-bypass flags were added. No transcripts are stored here.

- **Flow, all through the UI.** Choose folder → tick "Pre-approve room tools" (Claude only, as the UI states) → add a Claude Code managed agent and a Cursor managed agent → rename them inline to "Claude lead" and "Cursor helper" → type the task into Claude lead's composer → Run task. The task was: "Use the room_send tool to ask 'Cursor helper' to suggest a one-line tagline… reply with its answer prefixed 'Cursor says:'".
- **Cursor workspace trust.** Answered through the app's documented path: a native Cursor terminal session in the room showed "Workspace Trust Required … [a] Trust this workspace", and the demo pressed `a` for the scratch folder, then closed the terminal. No prompt was sent, so no model turn was used. The managed runner still passes no `--trust`.
- **Observed, in each of 3 runs.** `task-started` (Claude lead) → about 5 s → `delegation` "Claude lead → Cursor helper" → `task-started` (Cursor helper) with the exact provenance header → Cursor `task-completed` → Claude `task-completed` with "Cursor says: …". Both panes and the sidebar showed running, then idle. The Delegations tree went from started/started to completed/completed. Wall time was 20–28 s per run.
- **Cursor tool attempts.** In runs 2 and 3, Cursor on its own tried `shell` and then `room_send`, apparently to reply back to the room. Cursor's own permission mode (`default`) denied both. Each denial appeared as a `permission-denied` warning in the Cursor pane with "Provider permissions were not bypassed", and the task still completed with its text answer.
- **Bugs found and fixed.**
  - Streamed text segments on either side of a tool call ran together ("…tagline back.Always at your service."). The runner now inserts a paragraph break at segment boundaries: Cursor `model_call_id` flush or `tool_call`, and Claude `content_block_start` after text. A new transcript entry (for example, after a warning) trims that leading break.
  - The Room Activity feed collapsed to about one item when Delegations was shown, and did not follow new items. It now has a 220px minimum, the panel scrolls instead, and the feed sticks to the newest entry unless the user scrolls up.
  - The delegation child row was ellipsized ("→ Curso…"). It now wraps.
  - Tests: a Claude runner unit test, an updated Cursor delta expectation, and managed smoke assertions for no truncation, feed pinned to bottom, feed height ≥ 200px at 860×700, and no blank gap after a warning.
- **Not addressed.** Agent output is shown as plain text, so Markdown such as `**…**` appears literally. The result text from Cursor still concatenates segments; it is passed through unchanged.
- **Model turns used.** Claude: 3 tasks, one per run. Each task included one `room_send` tool call. Cursor: 3 delegated tasks. Cost was not captured: the runner does not surface the provider's reported cost, and none is shown in the UI.
