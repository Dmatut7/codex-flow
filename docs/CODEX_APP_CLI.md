# Use codex-flow in Codex App or Codex CLI

This is the main path: install once, restart Codex, then ask in natural language. You do not hand-write workflow files.

## 1. Install the CLI

Until the npm package is published, install from GitHub:

```bash
npm install -g github:Dmatut7/codex-flow
```

After npm publish, this becomes:

```bash
npm install -g codex-flow
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

## 3. Use it in any project

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

## 4. Resume after interruption

Run the same command again:

```bash
codex-flow run .codex-flow/generated/<task>.workflow.ts
```

Completed nodes replay from the journal. Only unfinished or changed nodes call Codex again.

## 5. Try without network first

```bash
codex-flow try
```

Or run a packaged example with the fake backend:

```bash
codex-flow run node_modules/codex-flow/examples/issue-triage.workflow.ts --backend fake
```

The fake backend returns schema-shaped output, so this works without Codex login or network.

## 6. Membership vs API key

Default backend: `codex-sdk`.

That uses your logged-in Codex / ChatGPT account. No OpenAI API key is needed for the default path.

Only the optional `openai-responses` backend needs `OPENAI_API_KEY`.

## 7. If Codex does not start a workflow

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

## 8. If the workflow fails

Most failures are in the generated workflow, not the engine. Ask Codex to fix the generated file and rerun the same command.

Useful checks:

```bash
codex-flow doctor
codex-flow run .codex-flow/generated/<task>.workflow.ts --backend fake
codex-flow smoke --backend codex-sdk
```

## 9. When to use it

Use `codex-flow` for tasks that can be split:

- bug investigation across several files or hypotheses,
- PR review passes,
- issue triage batches,
- release smoke checks,
- large refactor planning.

Do not use it for a one-line answer or a tiny single edit. Ask Codex directly for those.
