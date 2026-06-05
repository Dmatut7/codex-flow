# codex-flow setup quick reference

Default path uses the logged-in Codex / ChatGPT account. No OpenAI API key is needed unless the user explicitly selects `openai-responses`.

## Install

```bash
npm install -g codex-flow
codex-flow install-codex
codex-flow doctor
```

GitHub fallback if npm is unavailable: `npm install -g github:Dmatut7/codex-flow`.

Restart Codex after `install-codex`.

## Trigger

```text
用动态工作流帮我排查这个 bug
```

```text
use a dynamic workflow to investigate this bug in parallel
```

## Expected behavior

Codex should generate `.codex-flow/generated/<task>.workflow.ts`, run it with `codex-flow run`, write `.codex-flow/journal/<task>.jsonl`, and summarize the result.

## Troubleshooting

```bash
command -v codex-flow
codex-flow doctor
codex-flow try
codex-flow smoke --backend codex-sdk
```

If a generated workflow fails, fix only `.codex-flow/generated/<task>.workflow.ts` and rerun the same command.
