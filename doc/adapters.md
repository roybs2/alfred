# Agent adapters and delegation

## Why this boundary matters

Starting a provider's CLI in a PTY is not the same as integrating its agent protocol. It gives Agent Rooms a local terminal session, but does not by itself expose structured task creation, internal state, tool events, cancellation, or delegation. The UI and documentation must keep those capabilities separate.

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

SDK/app-server integrations differ from launching an already installed local CLI. Launching the local CLI uses that tool's own sign-in and permission flow; it does not by itself grant Agent Rooms structured API control. Avoid silently switching users from their CLI authentication to API billing.

## Provider research notes

Provider interfaces and terms change over time. Before implementing an adapter, consult current official documentation and record the date, exact supported protocol, authentication path, event semantics, and any preview/beta status. SDKs may support building applications on a model API without controlling an existing interactive CLI; an app-server may expose a protocol without supporting arbitrary cross-provider delegation. Verify each required action rather than relying on product naming.

At the time this doc was created, local CLI help has verified the existence of potentially useful Codex session queue/browse commands and Claude background session lifecycle commands. Their end-to-end integration has not been verified in this repository. Native cross-provider delegation, delegation redirects, and hidden context transfer are not implemented and must not be described as available.
