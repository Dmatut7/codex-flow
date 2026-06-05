# Changelog

## 0.2.0 — 2026-06-05

Initial public release as `codex-flow`.

- Global CLI: `codex-flow run`, `codex-flow install-codex`, `codex-flow smoke`.
- Codex App / CLI skill: say “用动态工作流” or “use a dynamic workflow” in any project.
- Parallel, pipeline, phase, and agent workflow primitives.
- Resumable journal replay keyed by prompt/schema/cwd/sandbox/position/dependency state.
- Real Codex backends: `codex-sdk`, `codex-exec`, `openai-responses`; fake backend for tests.
- Transient retry, schema repair, soft budget, deterministic shadows, writable-cwd collision guard.
- MIT license.
