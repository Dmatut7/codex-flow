# FAQ

## Do I need an OpenAI API key?

No for the default path. `codex-flow` defaults to `codex-sdk`, which uses your logged-in Codex / ChatGPT account.

You only need `OPENAI_API_KEY` if you explicitly choose the optional `openai-responses` backend.

## Does this work in Codex App?

Yes. Install the bundled skill once:

```bash
codex-flow install-codex
codex-flow doctor
```

Restart Codex App, open any project, and say:

```text
用动态工作流帮我排查这个 bug
```

Codex should generate a workflow under `.codex-flow/generated/`, run it with `codex-flow`, and summarize the journal.

## Does this work in Codex CLI?

Yes. The same installed skill is for Codex surfaces that read local Codex skills. You can also run workflow files directly:

```bash
codex-flow run .codex-flow/generated/my.workflow.ts
```

## What happens if a workflow is interrupted?

Run the same command again. Completed terminal nodes replay from `.codex-flow/journal/*.jsonl`; unfinished nodes run again.

## Is `codex-flow` an agent framework?

It is intentionally smaller: a local workflow engine plus Codex skill for maintainer workflows. It focuses on parallel fan-out, schema-checked sub-agent outputs, journaling, and resumable replay.

## Can examples run without network?

Yes. Use the fake backend:

```bash
codex-flow try
codex-flow run node_modules/codex-flow/examples/issue-triage.workflow.ts --backend fake
```

The fake backend returns schema-shaped output, so examples can smoke-test without Codex or network.

## Why not just ask Codex directly?

For small tasks, ask Codex directly. Use `codex-flow` when the work is naturally split across files, hypotheses, issues, or review passes and you want parallelism plus replay after interruption.

## Can workflow branches edit files?

Yes, but writable branches must use `sandbox: "workspace-write"` and `cwd`. The engine prevents two concurrent writable agents from sharing the same cwd to avoid collisions. Most analysis/review workflows should stay read-only.
