# Codex for Open Source application prep

Official form: https://openai.com/form/codex-for-oss/

Current repo: https://github.com/Dmatut7/codex-flow
Maintainer role: primary maintainer

## Official fit

OpenAI says the program is for maintainers of active public OSS projects with meaningful usage, ecosystem importance, or evidence of real maintenance work. Selected maintainers may receive 6 months of ChatGPT Pro, API credits for core OSS work, and possible Codex Security access.

`codex-flow` should position itself as a Codex maintainer-workflow project: it helps maintainers triage issues, review PRs, investigate bugs, and run release smoke checks in parallel with resumable journals.

## Current readiness

- Public GitHub repository.
- Public release: https://github.com/Dmatut7/codex-flow/releases/tag/v0.2.2
- MIT license.
- Clear README with install and usage path.
- CLI install path: `npm install -g codex-flow`. GitHub fallback: `npm install -g github:Dmatut7/codex-flow`.
- Codex skill install path: `codex-flow install-codex`, then users can ask Codex to use a dynamic workflow in any project.
- Local verification: `npm run typecheck`, `npm test`, GitHub Actions CI, and public npm install smoke.
- Published package readiness: `codex-flow` is public on npm, root JS import works, root TypeScript declarations work, `prepublishOnly` gates publish with typecheck + tests.
- Real Codex smoke verified on 2026-06-05:
  - `codex-flow smoke --backend codex-sdk` → `SMOKE_OK`, `pong:true`, non-zero usage.
  - `codex-flow smoke --backend codex-exec` → `SMOKE_OK`, `pong:true`, non-zero usage.
  - `codex-flow smoke --backend openai-responses` with no API key → `SMOKE_SKIPPED`, exit 0.
- Maintainer workflow examples included: bug investigation, PR review, issue triage, release smoke.
- Project directly targets maintainer automation, not generic task management.

Remaining weaker signal:

- Adoption signals are still early: collect stars, issues, outside-user feedback, and usage examples after launch.

## Form fields

Email:

```text
Use the email associated with the ChatGPT account.
```

GitHub username:

```text
Dmatut7
```

Repository URL:

```text
https://github.com/Dmatut7/codex-flow
```

Role:

```text
Primary maintainer
```

OpenAI Organization ID:

```text
Fill from the OpenAI dashboard when applying.
```

Why does this repository qualify? (max 500 chars)

```text
codex-flow is an open-source workflow orchestrator for Codex. It helps maintainers split complex OSS work into parallel, resumable Codex sub-agents for bug triage, PR review, issue investigation, and release checks. It includes journaling, keyed replay, schema validation, real Codex backends, and a Codex skill so users can trigger workflows with natural language.
```

How will you use API credits for your project? (max 500 chars)

```text
Use credits to run and test Codex-backed maintainer workflows: PR review fan-out, issue triage, release smoke checks, adapter compatibility tests, and example workflows for OSS users. Credits would also help validate real Codex behavior across codex-sdk, codex-exec, and Responses without pushing cost onto early contributors.
```

Anything else we should know? (max 500 chars)

```text
This project is built specifically around Codex maintainer automation. It turns Codex App/CLI into a natural-language workflow driver with parallel execution, resumable journals, deterministic replay, soft budgets, and real workspace-write safeguards, so maintainers can use Codex on larger OSS tasks without losing auditability or restartability.
```
