# Codex for Open Source application prep

Official form: https://openai.com/form/codex-for-oss/

Current repo: https://github.com/Dmatut7/codex-flow
Maintainer role: primary maintainer

## Current readiness

Ready now:

- Public GitHub repository.
- MIT license.
- Clear README with install and usage path.
- Local verification: typecheck, tests, pack dry-run.
- Real Codex smoke command for `codex-sdk` and `codex-exec`.
- Project directly targets maintainer automation: bug investigation, PR review, issue triage, release smoke workflows.

Need stronger signals before applying if possible:

- Publish npm package `codex-flow`.
- Add a real screen-recorded demo video/GIF and 2-3 more workflow-gallery examples.
- Get early users/stars/issues from real usage.
- Tag a GitHub release.
- Add GitHub Actions CI after refreshing `gh` with the `workflow` scope.
- Add examples for PR review, bug triage, and release checks.

## Form fields

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
