# Examples

These examples show what `codex-flow` is meant to unlock for Codex users: maintainer workflows that are too broad for one linear agent turn.

## Natural-language mode

After installing the bundled Codex skill:

```bash
codex-flow install-codex
```

Restart Codex, open any project, and say:

> use a dynamic workflow to investigate this bug in parallel

Codex should generate a temporary `.codex-flow/generated/*.workflow.ts`, run it, and summarize the journaled results.

## Maintainer workflow gallery

### `bug-investigation.workflow.ts`

Parallel bug investigation over several hypotheses or repository areas, then one synthesized action plan.

```bash
codex-flow run examples/bug-investigation.workflow.ts --backend codex-sdk
```

### `pr-review.workflow.ts`

Fan out PR review into correctness, regression risk, tests/docs, and API/sandbox passes, then merge the verdict.

```bash
codex-flow run examples/pr-review.workflow.ts --backend codex-sdk
```

### `release-smoke.workflow.ts`

Run read-only release checks over package metadata, README, CLI examples, and release docs.

```bash
codex-flow run examples/release-smoke.workflow.ts --backend codex-sdk
```

## Small smoke examples

### `hello.workflow.ts`

A minimal real Codex structured-output call.

```bash
codex-flow run examples/hello.workflow.ts --backend codex-sdk
```

### `pong.workflow.ts`

A tiny fake-backend workflow for local smoke testing without network or Codex login.

```bash
codex-flow run examples/pong.workflow.ts --backend fake
```

### `triage.workflow.ts`

A larger workflow shape for maintainer-style investigation: split a problem, run parallel branches, collect structured findings, and resume from the journal if interrupted.

```bash
codex-flow run examples/triage.workflow.ts --backend codex-sdk
```
