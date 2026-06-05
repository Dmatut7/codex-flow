# Examples

These examples show what `codex-flow` is meant to unlock for Codex users.

## `hello.workflow.ts`

A minimal real Codex structured-output call.

```bash
codex-flow run examples/hello.workflow.ts --backend codex-sdk
```

## `pong.workflow.ts`

A tiny fake-backend workflow for local smoke testing without network or Codex login.

```bash
codex-flow run examples/pong.workflow.ts --backend fake
```

## `triage.workflow.ts`

A larger workflow shape for maintainer-style investigation: split a problem, run parallel branches, collect structured findings, and resume from the journal if interrupted.

```bash
codex-flow run examples/triage.workflow.ts --backend codex-sdk
```

## Natural-language mode

After installing the bundled Codex skill:

```bash
codex-flow install-codex
```

Restart Codex, open any project, and say:

> use a dynamic workflow to investigate this bug in parallel

Codex should generate a temporary `.codex-flow/generated/*.workflow.ts`, run it, and summarize the journaled results.
