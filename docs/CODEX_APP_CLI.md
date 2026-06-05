# Use codex-flow in Codex App or Codex CLI

This is the main path: install once, restart Codex, then ask in natural language. You do not hand-write workflow files.

## 1. Install the CLI

Install from npm:

```bash
npm install -g codex-flow
```

GitHub fallback if npm is unavailable:

```bash
npm install -g github:Dmatut7/codex-flow
```

Verify:

```bash
codex-flow doctor
```

You should see checks for the CLI, Node, fake backend, Codex CLI, and Codex skill status.

## 2. Install the Codex skill

```bash
codex-flow install-codex
codex-flow doctor
```

Restart Codex App or Codex CLI after installing the skill.

## 3. Update the installed skills later

If `codex-flow` releases updated skills, users who already installed it should run:

```bash
npm install -g codex-flow@latest
codex-flow install-codex
codex-flow doctor
# restart Codex App or Codex CLI
```

`npm install -g` updates the package. `codex-flow install-codex` is still required because Codex uses copied files under `~/.codex/skills`.

## 4. Use it in any project

Open the target repository in Codex and say one of these:

```text
用动态工作流帮我排查这个 bug，拆成多个方向并行分析，最后合并成根因和下一步。
```

```text
use a dynamic workflow to investigate this bug across the repo in parallel, then merge the findings into one root cause and next action
```

Codex should:

1. generate `.codex-flow/generated/<task>.workflow.ts`,
2. run `codex-flow run .codex-flow/generated/<task>.workflow.ts`,
3. write `.codex-flow/journal/<task>.jsonl`,
4. summarize the parallel branches and result.

## 5. Resume after interruption

Run the same command again:

```bash
codex-flow run .codex-flow/generated/<task>.workflow.ts
```

Completed nodes replay from the journal. Only unfinished or changed nodes call Codex again.

## 6. Try without network first

```bash
codex-flow try
```

`try` creates a starter workflow in the current project and forces the fake backend, so this works without Codex login or network.

## 7. Membership vs API key

Default backend: `codex-sdk`.

That uses your logged-in Codex / ChatGPT account. No OpenAI API key is needed for the default path.

Only the optional `openai-responses` backend needs `OPENAI_API_KEY`.

## 8. If Codex does not start a workflow

Use a direct trigger phrase:

```text
请使用 dynamic-workflow skill，用 codex-flow 生成并运行一个动态工作流来处理这个任务。
```

Then check:

```bash
command -v codex-flow
codex-flow doctor
```

If the skill is missing, reinstall it:

```bash
codex-flow install-codex
```

Restart Codex and try again.

## 9. If the workflow fails

Most failures are in the generated workflow, not the engine. Ask Codex to fix the generated file and rerun the same command.

Useful checks:

```bash
codex-flow doctor
codex-flow run .codex-flow/generated/<task>.workflow.ts --backend fake
codex-flow smoke --backend codex-sdk
```

## 10. When to use it

Use `codex-flow` for tasks that can be split:

- bug investigation across several files or hypotheses,
- PR review passes,
- issue triage batches,
- release smoke checks,
- large refactor planning.

Do not use it for a one-line answer or a tiny single edit. Ask Codex directly for those.
