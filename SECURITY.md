# Security policy

`codex-flow` runs Codex-backed workflows in local repositories, so reports about sandbox handling, writable cwd isolation, journal replay, backend adapter behavior, or credential leakage are important.

## Supported versions

The latest public release is supported.

## Reporting

Open a GitHub issue with a minimal reproduction unless the report includes secrets or private repository details. For sensitive reports, contact the maintainer through the email on the GitHub profile and include:

- `codex-flow --version`
- backend used: `codex-sdk`, `codex-exec`, `openai-responses`, or `fake`
- the smallest workflow that reproduces the issue
- relevant journal excerpt with secrets removed

Do not include API keys, npm tokens, Codex session data, or private source code in public issues.
