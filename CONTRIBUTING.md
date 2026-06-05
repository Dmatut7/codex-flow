# Contributing to codex-flow

Thanks for helping improve `codex-flow`.

## Local setup

```bash
npm install
npm run typecheck
npm test
```

The default test suite uses the fake backend only. It should not require Codex login or an OpenAI API key.

## Real-backend smoke tests

Use these only when you want to verify an installed Codex environment:

```bash
node bin/codex-flow.mjs smoke --backend codex-sdk
node bin/codex-flow.mjs smoke --backend codex-exec
node bin/codex-flow.mjs smoke --backend openai-responses
```

`codex-sdk` and `codex-exec` use the logged-in Codex account. `openai-responses` requires `OPENAI_API_KEY`. Missing credentials should print `SMOKE_SKIPPED` and exit 0.

## Development rules

- Keep engine semantics aligned with `DESIGN-codex-dynamic-workflow.md`.
- Do not weaken replay, cache-key, determinism, sandbox, budget, or error-classification behavior to make a test pass.
- Prefer small, focused changes.
- Run `npm run typecheck` and `npm test` before opening a PR.

## Good first areas

- Better generated prompts and templates for common maintainer workflows.
- More real-backend compatibility smoke coverage.
- Documentation for Codex App / CLI usage and real-world workflow reports.
