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

### License remains open

The project is intended to be open source, but the owner has not selected a license. Do not invent one or add a license file without that decision.

## Open questions

- Which officially documented Claude Code and Codex interfaces, if any, provide stable structured session or delegation control?
- What exact room and session metadata should survive restart?
- Which macOS versions and distribution channel will be supported first?
- Which open-source license does the owner want?
