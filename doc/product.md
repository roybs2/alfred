# Product brief

## Vision

Agent Rooms gives developers a practical, local-first home for several coding-agent sessions. Each project is a room; vertical tabs make sessions easy to scan, group, and revisit. The workspace should reduce the overhead of switching between terminal windows while preserving the direct relationship between a developer and the agent CLI they chose.

Over time, the product can make handoffs and delegation between agents easier to observe and manage, including across providers. That destination depends on real capabilities exposed by each provider. Agent Rooms must not pretend a pasted prompt is native delegation or imply it transferred hidden context.

## Who it is for

Developers who already use local coding-agent CLIs and want a more organized way to run parallel work. The first target is an individual Mac user, not a hosted team service.

## MVP value

- Open project rooms with vertically arranged, grouped session tabs.
- Launch a normal shell, and launch detected Claude Code or Codex CLIs in a real local PTY.
- View multiple sessions in split terminal panes.
- See room activity and session lifecycle in one place.
- Persist small amounts of room and tab metadata locally.
- Perform an explicit manual handoff by copying or pasting a prompt, reviewing it, and submitting it yourself.

The MVP is a desktop organizer and terminal harness. It does not implement automated delegation, hidden context transfer, or a native delegation redirect. Future stages may support user-authorized agent dispatch through provider-supported controls, including cross-provider handoff where the exact context and delivery state can be observed.

## Product rules

1. **Local first.** Commands run on the user's machine with the user's installed CLI and its own authentication flow.
2. **No extra reasoning layer.** Agent Rooms does not add an orchestration LLM or rewrite the user's agent context behind their back.
3. **Visible actions.** Starting, stopping, pasting, and submitting work should be clear and attributable to a user action or a policy the user explicitly set.
4. **Authorization before dispatch.** In the MVP, a pasted handoff never triggers Enter; the user reviews and submits it. A later room-level policy may explicitly authorize an agent to open or message another agent without per-message confirmation. The policy must name its scope and destinations, be visible and revocable, and produce observable activity. Do not treat low-friction preference as authorization to bypass provider permissions.
5. **Provider truthfulness.** Label capabilities according to verified provider behavior. Shell launch, manual handoff, structured adapter support, and native delegation are distinct capabilities.
6. **Room boundaries.** A room groups sessions and metadata; it does not imply that sessions share files, memory, or context unless an explicit mechanism provides that.

## Success signals

For the MVP, success means a user can create or reopen a project room, start a useful CLI session without changing their existing CLI setup, switch between sessions, understand which sessions are active, and manually pass a reviewed task to another session. More ambitious measures such as delegation completion rates belong to a later stage after structured adapters exist.

## Not in the MVP

- Background autonomous orchestration.
- An orchestration model or agent that decides which provider to call.
- Claims that Claude Code and Codex share hidden context or support reciprocal native delegation.
- Unapproved prompt submission, hidden dispatch, unattended permission bypass, or credential extraction.
- A cloud account, hosted runtime, or team collaboration service.
- Distribution/signing guarantees before packaging and platform checks are completed.
