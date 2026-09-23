# Roadmap

Statuses reflect visible code and evidence at the time of the latest update. Milestone 1 is implemented and tested on the development Mac; distribution remains separate. No milestone should be marked complete solely because it is planned.

## 0. Capability validation — in progress

Read-only inspection of installed Codex CLI 0.149.1 and Claude Code 2.1.280 help shows promising local controls: Codex can queue a message for a session by UUID or exact name and can browse sessions on a shared app-server; Claude Code can run/list/attach/log/stop background sessions. This confirms useful CLI entry points exist, but not that Agent Rooms can reliably discover identity, receive notifications, or perform native cross-provider delegation. Next, verify official documentation and the interaction semantics. Keep research read-only; do not submit billable agent tasks.

**Exit:** documented capability matrix with links to provider documentation, verified identity and notification behavior, and clear distinctions between local session control, provider-native delegation, and cross-provider handoff; no unsupported capability claim.

## 1. Local PTY workspace MVP — implemented and tested

Build the Electron shell, room navigation, vertical grouped tabs, local PTY launch for shell and detected CLIs, split terminal view, Room Activity lifecycle, and local room metadata persistence. Include explicit manual paste with user-controlled submission.

**Exit:** an operator can run the app on macOS, use a shell without agent CLIs installed, launch supported installed CLIs, switch/split sessions, and restart without losing room metadata. Runtime, build, test, and packaging checks are recorded. No automated handoff is claimed complete in this milestone.

## 2. Structured delegation adapters — pending

Use the documented CLI structured modes and process-scoped MCP configuration described in [native integration research](native-integration.md). Define a common capability contract for status, task creation/handoff, result events, cancellation, and errors as supported. Retain manual handoff for unsupported paths. Dispatch requires user-visible confirmation by default until the user opts into a room policy; after opt-in, the authorized room tools may dispatch without per-call confirmation inside that policy.

**Exit:** each adapter has capability-specific implementation evidence and lifecycle handling; unsupported features are shown as unavailable.

## 3. User-authorized agent dispatch — pending

Add room-level policy that lets an agent open or message another agent without per-dispatch confirmation when the user has opted in. Keep the policy scoped to allowed providers, destinations, operations and concurrency, visible in the room, revocable, and reflected in Room Activity. Preserve provider permissions. This is an explicit user-controlled capability, not an orchestration LLM.

## 4. Cross-provider workflows — pending

Design user-directed handoffs between provider runtimes. Preserve provenance, show the exact context being sent, and state when history, tool state, or permissions do not transfer. Avoid a hidden model-mediated rewrite layer.

**Exit:** tested workflows are transparent about context boundaries, require user review, and can be inspected in Room Activity.

## 5. Polish and distribution — pending

Improve onboarding, accessibility, recovery behavior, macOS packaging, signing/notarization planning, update strategy, and documentation. Choose a software license with the project owner before publishing a license file or distributing under an assumed license.

**Exit:** clean install and upgrade paths are understood; platform checks and distribution limitations are documented; license decision is recorded.
