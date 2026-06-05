# Changelog

## Unreleased

- Added GitHub Actions npm Trusted Publishing workflow so tagged releases can publish without local npm tokens or OTP.
- Added maintainer operations docs for releases, Trusted Publishing, and bundled Codex skill updates.
- Clarified that users receive skill updates by reinstalling `codex-flow@latest`, rerunning `codex-flow install-codex`, and restarting Codex.

## 0.2.4 — 2026-06-05

- Added the `parallel-fix` Codex skill and example workflow for proposing independent fixes concurrently, then integrating and verifying serially.
- Hardened replay/cache correctness: implicit cwd is now part of cache identity, nested phases inside parallel no longer alias, and failed topology branches keep completed child dependencies for downstream invalidation.
- Hardened concurrency and writable isolation: FIFO semaphore handoff no longer over-admits, writable cwd locks stay held across transient retries, additional writable directories are locked, and writable configuration errors propagate through topologies.
- Hardened determinism and abort handling: adapter-side global randomness no longer shifts workflow `ctx.random`, and adapters cannot return success after timeout/abort.
- Hardened budget handling: parallel agents reserve budget before async backend work, so replayed/skipped nodes do not bypass the guard.
- Hardened strict schema handling: object-like combinator branches are enforced, root `allOf`/`oneOf` object combinators no longer make valid payloads impossible, and boolean `false` schemas are rejected instead of disabling validation.
- Hardened transient stream handling: prefixed Codex `Reconnecting...` advisories are ignored as reconnect notices instead of being promoted to fatal stream errors.

## 0.2.3 — 2026-06-05

- Moved the install command into the README first screen so GitHub visitors see it immediately.
- Rebuilt the demo GIF and storyboard SVG so the first frame shows `npm install -g codex-flow` and no terminal lines are clipped.

## 0.2.2 — 2026-06-05

- Published `codex-flow` on npm and made npm install the primary public path.
- Updated Codex App / CLI docs, launch notes, and bundled skill setup text for npm-first onboarding.
- Kept GitHub install as a fallback path.

## 0.2.1 — 2026-06-05

Release-readiness hardening after the first public tag.

- Preserves Claude's live progress stream work while adding engine and CLI regression fixes.
- Fixes replay edge cases, schema keyword handling, writable-cwd collision propagation, abort forwarding, and backend thread-id namespacing.
- Hardens `doctor`, `try`, examples, and install docs for global users and offline checks.
- Adds Codex skill checks for dynamic workflow and business-defect-audit installs.

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
