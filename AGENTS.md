# Alfred

Name is Alfred; license Apache-2.0 (owner decision, 2026-09-22). All implementation and planning lives in this repository.

## Product constraints
- Mac-first Electron application; vertical sessions grouped into rooms.
- Preserve provider harnesses and permissions. Never silently add permission bypass flags.
- No orchestration LLM, automatic context rewriting, or invented agent status.
- Distinguish native PTY sessions, manual handoff, and verified automated delegation.
- Do not turn terminal text into commands automatically.
- Keep renderer isolated; native actions pass through narrow validated IPC.
- Do not store terminal transcripts or credentials in project metadata.

## Workflow
- Read doc/tasks.md and update it with completed, pending, and verified work.
- Record architecture decisions in doc/decisions.md and integration evidence in doc/adapters.md.
- Run npm test and npm run build for meaningful changes. npm run test:smoke uses a real local shell; it must not launch billable agent work.
- Keep lockfile committed. Native node-pty must be rebuilt for the installed Electron version.
- Name is Alfred; license Apache-2.0. Publishing (making the repo public, GitHub releases) only when the owner has approved it.
