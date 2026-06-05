# Changelog

## 0.2.0 — 2026-06-05

Initial public release as `codex-flow`.

### User-facing

- Global CLI: `codex-flow run`, `codex-flow init`, `codex-flow try`, `codex-flow doctor`, `codex-flow install-codex`, `codex-flow smoke`.
- Codex App / CLI skill: say “用动态工作流” or “use a dynamic workflow” in any project.
- `codex-flow try` creates and runs a starter workflow with the fake backend, no network required.
- Prompt gallery with Chinese/English copy-paste prompts for bug investigation, PR review, issue triage, release smoke, and refactor planning.
- Import-free workflow examples using plain JSON Schema: bug investigation, PR review, issue triage, release smoke, triage, hello, pong.
- FAQ clarifying that the default path uses Codex / ChatGPT membership login, not an OpenAI API key.

### Engine

- Parallel, pipeline, phase, and agent workflow primitives.
- Resumable journal replay keyed by prompt/schema/cwd/sandbox/position/dependency state.
- Schema repair loop separate from transient 429/5xx/network retry.
- Soft token/node budget, deterministic shadows, stable cache-key sequence.
- Writable-cwd collision guard for concurrent workspace-write agents.
- Crash-residue and non-terminal repair journal recovery.
- Fake backend now returns schema-shaped output by default, so examples smoke-test cleanly offline.

### Backends and packaging

- Real Codex backends: `codex-sdk` and `codex-exec` verified with structured smoke output.
- Optional `openai-responses` backend for API-key users; missing key skips smoke cleanly.
- Typed package root export: `createEngine`, `runWorkflow`.
- npm publish gate: `prepublishOnly` runs typecheck and tests.
- MIT license, contributing guide, security policy, issue templates, PR template, roadmap, and GitHub release.
