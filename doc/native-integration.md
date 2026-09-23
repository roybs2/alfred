# Native-friendly room tools: provider adapter research

Researched 2026-09-22 against Claude Code 2.1.280 and Codex CLI 0.149.1 installed on the development Mac. Provider help and documentation were inspected without starting model work. The only configuration probe was `codex mcp list` with a deliberately invalid local command; it did not start an agent or call a model.

## Recommendation

Keep the current PTY integration as the native interactive-session path. Add a separate structured subprocess adapter path for room collaboration. Use the installed provider CLIs, their existing sign-in and permissions, and a per-process Agent Rooms MCP bridge exposing only `room_send` and `room_spawn`. The existing parent conductor calls these tools directly with an explicit target, the task text, the exact context the user/agent authorized to send, and provenance. Do not add a router model, rewrite context, or imply that Claude/Codex redirects its private native subagents into other providers.

The bridge should authenticate local callers, bind each process to a room and source session, enforce the persisted room policy and concurrency limits, and record tool request/acknowledgement/result events. Tool arguments should identify the target provider/session, exact task, and context segments with their source session/message identifiers. `room_send` appends the request to a known existing conversation using that provider's resume mechanism; `room_spawn` starts a new provider conversation with the explicit task/context. Acknowledgement means the provider accepted a user turn or started a process/thread; it does not mean the model completed the task. Keep those states distinct. On resume, reattach to the same provider session ID and use the provider's final/turn-completed event for completion. When only exact context can be carried, send those source excerpts verbatim with labels and provenance; never claim full conversation/tool state or permissions transferred.

This retains the provider harness and is the thinnest useful mechanism: one small authenticated broker/tool server plus adapters that start/resume the official local CLI. A fresh spawn costs a normal provider turn. Reusing a session avoids resending its conversation history at the application layer, although the provider still applies its normal context and usage accounting. `--json-schema` / `--output-schema` is optional for machine-shaped task results; it does not replace lifecycle parsing.

## Claude Code adapter

Installed help verified `-p/--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--session-id <uuid>`, `--resume <session-id>`, `--fork-session`, `--mcp-config <file-or-json>`, and `--strict-mcp-config`. These are `-p`/SDK-mode options; `--strict-mcp-config` limits this process to the supplied bridge config. Pass the generated room-scoped MCP config on every invocation, including resumes, and validate `system/init.mcp_servers`/`mcp_server_errors` before treating the bridge as available.

One JSONL message example for the initial turn:

```sh
claude -p --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages --session-id "$SESSION_ID" \
  --mcp-config "$ROOM_MCP_JSON" --strict-mcp-config
```

For follow-up input, use the same flags with `--resume "$SESSION_ID"` instead of `--session-id`. Stream one documented stream-json input message per line to stdin; do not pass untrusted text through a shell command string. The official headless guide also documents simpler single-prompt use as `claude -p "<task>" --output-format json`, returning one JSON object whose `.session_id` identifies the conversation and `.result` contains final text. Follow-up is `claude -p "<task>" --resume "$SESSION_ID"`.

In stream mode, parse newline-delimited JSON events. The final event is `type: "result"`; it carries final response text, cost, and session metadata. Other events include `system/init`, assistant/user messages and partial `stream_event` deltas. `system/init` exposes loaded MCP server names/status and config validation errors. The official guide states JSON output includes result, session ID, and metadata; `--json-schema` places validated output in `structured_output`. Do not equate token deltas with completion; wait for the `result` event and process exit.

The interactive CLI's native login remains in effect. The `--bare` mode intentionally restricts authentication to `ANTHROPIC_API_KEY` or `apiKeyHelper` and skips OAuth/keychain; do not enable it in this adapter. Claude's Agent SDK is a different integration and may require API-key billing; it is not a drop-in bridge to an existing claude.ai authenticated terminal. No credential should be copied into room metadata or broker arguments.

## Codex adapter

Installed help verified `codex exec --json`, `--output-schema <file>`, `-o <file>`, `-C <dir>`, and `-c <key=value>`. Resume syntax is `codex exec resume <SESSION_ID> <PROMPT>` and it accepts the same `--json`, `-C`, and `-c` overrides. A process-local MCP definition can therefore be passed without editing the user's config:

```sh
codex exec --json -C "$PROJECT_DIR" \
  -c 'mcp_servers.agent_rooms.command="/absolute/path/to/agent-rooms-mcp"' \
  -c 'mcp_servers.agent_rooms.args=["--stdio"]' \
  -c 'mcp_servers.agent_rooms.env={ROOM_ID="<opaque-room-id>",SESSION_ID="<source-session-id>"}' \
  -c 'mcp_servers.agent_rooms.required=true' \
  '<exact task and explicitly authorized context>'
```

Follow-up: `codex exec resume --json -C "$PROJECT_DIR" <same -c overrides> "$THREAD_ID" '<exact message>'`. Pass argv as an array; do not build a shell string from task content. Official configuration documentation defines `mcp_servers.<id>.command`, `.args`, `.env`, `.required`, and `enabled_tools`. The local no-bill probe below confirms the installed CLI accepts the nested overrides and lists the dummy server entry:

```sh
codex mcp list \
  -c 'mcp_servers.agent_rooms.command="/usr/bin/false"' \
  -c 'mcp_servers.agent_rooms.args=["--stdio"]' \
  -c 'mcp_servers.agent_rooms.env={ROOMS_TEST="ok"}'
```

The output contained `agent_rooms /usr/bin/false --stdio ROOMS_TEST=***** ... enabled Unsupported`. In this listing, `Unsupported` is an authentication/status column value for the configured stdio server; it is not evidence that `/usr/bin/false` was run or rejected. The dummy process was not run. This verifies configuration parsing and listing only, not MCP server startup, tool discovery/calling under `codex exec`, or provider authentication; those need a user-authorized authenticated smoke.

`codex exec --json` writes a JSONL event stream. Official examples include `thread.started` with `thread_id`, `turn.started`, `item.started`/`item.completed`, and `turn.completed` with usage. The documented type family also includes `turn.failed`, `item.*`, and `error`; item types include MCP tool calls. Store `thread_id` from `thread.started`; don't guess it from output. Treat `turn.completed`/`turn.failed` as terminal for the turn and check process exit/error too. `--output-schema` shapes a final response; `-o` writes final text separately while events still go to stdout.

Codex App Server is the richer structured alternative: the documented JSON-RPC lifecycle is `initialize`/`initialized`, `thread/start` or `thread/resume`, `turn/start`, streamed `item/*` and `turn/*`, with `turn/completed` statuses `completed`, `interrupted`, or `failed`; `turn/interrupt` requests cancellation. The installed CLI exposes `codex app-server --listen stdio://` and process-level `-c` overrides. It can reuse the signed-in CLI installation without adopting API-key SDK auth, but its protocol has more plumbing than the initial CLI adapter. Official docs expose a `config` object on `thread/start`/`thread/resume` while not specifying MCP override semantics there. Prefer process-level `-c` with a dedicated app-server process if later choosing app-server; don't assume undocumented thread-level MCP injection.

## Cursor CLI adapter

Researched and live-tested 2026-09-22 against `cursor-agent` 2026.09.18-9a7762b. Evidence is in [adapters.md](adapters.md#cursor-cli-live-verification-2026-09-22), and the reasoning is in the decision log.

```sh
cursor-agent -p --output-format stream-json --stream-partial-output \
  --plugin-dir "$TMP/agent-rooms" [--resume "$CHAT_ID"] -- '<exact task>'
```

- **PTY.** The PTY path launches `cursor-agent` with no arguments; its interactive trust and approval prompts are the user's.
- **Output.** Streamed text comes from `assistant` events with `timestamp_ms` and no `model_call_id`. `result.result` is the final text and `session_id` is the chat id; `result.is_error` marks failure.
- **MCP.** Cursor documents no per-process MCP config. The documented `--plugin-dir` loads a temporary plugin (`.cursor-plugin/plugin.json` + `mcp.json`) defining only the room bridge. The runner does not write project or home config.
- **Permissions.** Print mode keeps the user's Cursor permission config. Without `--force`, edits are proposed only. MCP tools need approval, and in print mode they are auto-rejected unless the user's own `Mcp(server:tool)` allow rules cover them. Rejections become `permission-denied` events. The runner never passes `--force`, `--yolo`, `--approve-mcps`, `--auto-review`, `--sandbox`, or `--trust`.
- **Not reported.** `system/init` has no MCP server status, so a failed bridge is not detected before the turn.

## What is verified and what remains

Verified locally without model work (earlier): exact installed versions and help flags; Codex `-c` parsing for MCP command/args/env via read-only list; official configuration and app-server entry points.

Verified live on 2026-09-22 (owner-authorized minimal runs; evidence in [adapters.md](adapters.md#live-verification-2026-09-22)):
- **Claude:**
  - The per-process room bridge starts under `--mcp-config … --strict-mcp-config`.
  - `system/init.mcp_servers` reports `{name, status: "connected", source: "dynamic"}` exactly as the runner parses it, and a failed bridge reports `status: "failed"`.
  - `session_id` is captured, and `--resume` continues the same session id.
  - `result` is the completion signal.
  - A headless `room_send` MCP call reached the broker and delivered the exact task and provenance to a Codex session. The tool error came back to Claude as `tool_result.is_error`.
- **Claude permissions:**
  - Under the user's `auto` permission mode, the tool call was allowed.
  - Under `--permission-mode default` it was denied (`system/permission_denied` plus `result.permission_denials`). Rooms therefore have an explicit, off-by-default "Pre-approve room tools" policy (see the decision log).
- **Codex:**
  - With `required=true`, the room bridge starts as a child of `codex exec` before `thread.started`.
  - A failing bridge aborts before any thread or model request.
  - `thread.started.thread_id`, `turn.started`, non-fatal `item.completed{type:"error"}` warnings, and `error` / `turn.failed` are emitted as the runner parses them.
- **Cancellation:** `stopSession` emits `task-failed` immediately. The provider child exits on SIGTERM, and its bridge grandchild is gone.

Not verified end to end:
- A successful Codex turn (`agent_message` / `turn.completed`) and `codex exec resume`. The user's configured Codex model is rejected by CLI 0.149.1, and the account hit its usage limit during the run.
- Codex as a `room_send` caller, and whether `codex exec` prompts for, denies, or allows MCP calls by default.
- That the new pre-approval flags (Claude `--allowedTools mcp__<bridge>__room_send[,room_spawn]`, Codex per-tool `approval_mode="approve"`) suppress denials live. Only config parsing is verified.
- `room_spawn`, busy-session queueing, duplicate suppression, and cancellation of a delegated call against real providers.
- Cost attribution beyond Claude's reported `total_cost_usd`.

- Cursor: an allowed Cursor-initiated room tool call, `room_spawn`, cancellation, and failed-bridge detection (see adapters.md).

Never claim redirect of native provider subagents unless a provider documents and a test proves that path.

## Primary references

- [Cursor CLI: Output format](https://cursor.com/docs/cli/reference/output-format), [Headless](https://cursor.com/docs/cli/headless), [Permissions](https://cursor.com/docs/cli/reference/permissions), [MCP](https://cursor.com/docs/context/mcp), [Plugins](https://cursor.com/docs/reference/plugins).

- [Claude Code: Run programmatically](https://code.claude.com/docs/en/headless) — print/JSON/stream-json output, result and session IDs, resume, MCP config validation, and session metadata.
- [Claude Code: CLI reference](https://code.claude.com/docs/en/cli-reference) — current flag surface.
- [Codex: Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) — JSONL events, final output, resume and saved CLI authentication.
- [Codex: Configuration reference](https://developers.openai.com/codex/config-reference) — per-process config override keys and MCP fields.
- [Codex: App Server](https://developers.openai.com/codex/app-server) — JSON-RPC lifecycle, event status, cancellation, and thread/turn APIs.
