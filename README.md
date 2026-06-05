# Codex Dynamic Workflow Engine

A backend-agnostic dynamic workflow engine for Codex-style agents.

You write one workflow with `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, and `budget`. The engine handles keyed replay, dependency edges, soft budgets, deterministic helpers, schema validation/repair, concurrency limits, writable-cwd protection, and backend selection.

Default backend: `@openai/codex-sdk`. Optional backends: `codex-exec` and `openai-responses`.

## Install

```bash
npm install
```

Run the no-network fake example:

```bash
npm run example
```

Expected shape:

```json
{
  "ship": true,
  "summary": "ship guarded timeout fix"
}
```

## Run a workflow

For a workflow module that exports `default async function workflow(ctx)`, run this no-network CLI example:

```bash
npx tsx engine/cli.ts run examples/pong.workflow.ts --journal /tmp/codex-workflow-pong.jsonl
```

For real Codex work, use the same form with `--backend codex-sdk` and your workflow path.

CLI flags:

- `--backend name`: override `defaultBackend` for this run.
- `--config path`: read an engine config JSON file. Defaults to `codex.config.json`.
- `--journal path`: choose the replay journal. Existing journals are reused automatically.

`codex-engine run` is also exposed as the package bin when this project is linked or installed as a package.

## Config

Example `codex.config.json`:

```json
{
  "defaultBackend": "codex-sdk",
  "autoRoute": true,
  "concurrency": 4,
  "seed": 123456,
  "estimatedTokensPerCall": 1000,
  "budget": {
    "maxTokens": 400000,
    "maxNodes": 50,
    "onExceeded": "throw"
  },
  "adapters": {
    "codexSdk": {},
    "codexExec": {},
    "openaiResponses": {}
  }
}
```

Common fields:

- `defaultBackend`: `codex-sdk`, `codex-exec`, `openai-responses`, or `fake`.
- `autoRoute`: when true, pure schema-only nodes may route to `openai-responses`.
- `concurrency`: max active backend calls.
- `hardMaxConcurrency`, `providerRateBudget`: inputs to default concurrency when `concurrency` is omitted.
- `journalPath`: default journal path. CLI `--journal` overrides it.
- `seed`: seed for deterministic `ctx.now()` / `ctx.random()` and shadowed workflow globals.
- `defaultModel`: model passed to real adapters when a node does not set `model`.
- `estimatedTokensPerCall`: soft-budget reservation before an adapter call.
- `timeoutMs`: default per-agent timeout.
- `transientRetries`, `transientBaseMs`: transient 429/5xx/network retry policy.
- `budget.maxTokens`, `budget.maxNodes`, `budget.onExceeded`: soft budget behavior. `onExceeded` is `throw`, `skip`, or `downgrade`.
- `adapters.codexSdk`: passed to `new Codex(...)`.
- `adapters.codexExec`: supports adapter options such as `codexPath`, `env`, and `graceWindowMs`.
- `adapters.openaiResponses`: passed to `new OpenAI(...)`.
- `adapters.fake`: scripted fake responses for tests.

## Write a workflow

```ts
import { z } from "zod";
import type { WorkflowContext } from "./engine/index.ts";

export default async function workflow(ctx: WorkflowContext) {
  const { agent, parallel, pipeline, phase, log, budget } = ctx;

  budget.configure({ maxTokens: 100_000, maxNodes: 20, onExceeded: "throw" });

  const Pick = z.object({ files: z.array(z.string()) }).strict();
  const Finding = z.object({ file: z.string(), notes: z.string() }).strict();
  const Summary = z.object({ file: z.string(), summary: z.string() }).strict();

  const triage = await phase("triage", async () => agent<{ files: string[] }>(
    "Pick two files to inspect. Return JSON.",
    { schema: Pick, pure: true, kind: "classify" },
  ));

  log("triage complete", triage.output);

  const findings = await parallel(triage.output.files.map((file) => async () => (
    await agent(`Inspect ${file}. Return finding JSON.`, {
      schema: Finding,
      cwd: process.cwd(),
      sandbox: "read-only",
    })
  ).output));

  return pipeline(findings.filter(Boolean),
    async (finding) => (await agent(`Summarize ${JSON.stringify(finding)}.`, {
      schema: Summary,
      pure: true,
      kind: "judge",
    })).output,
  );
}
```

Important node options:

- `schema`: Zod or JSON Schema. The model receives a strict adapter schema; local Ajv validates the full schema.
- `backend`: pin a node to one backend.
- `pure: true` / `kind: "extract" | "classify" | "judge"`: explicit signal that a schema-only node may use the cheap route.
- `cwd`: real working directory for file-aware nodes.
- `sandbox`: `read-only`, `workspace-write`, or `danger-full-access`.
- `threadId`: backend-local hot resume handle.
- `timeoutMs`, `retries`, `nodeKey`: per-node controls.

Use `ctx.now()` and `ctx.random()` for workflow control flow. Do not use wall-clock time or ambient RNG to decide which nodes exist.

## Backends and routing

- `codex-sdk`: default, in-process SDK thread. Best for normal Codex agent work.
- `codex-exec`: spawns `codex exec --json`. Best when you want process isolation.
- `openai-responses`: direct Responses API with strict JSON schema. Best for pure extraction/classification/judging.
- `fake`: deterministic test adapter. No network.

Routing order:

1. `opts.backend` wins.
2. If `autoRoute !== false`, pure schema-only nodes may route to `openai-responses`.
3. Otherwise `config.defaultBackend` is used.

The engine never infers “pure” from a missing `cwd`. Mark pure nodes explicitly.

## Resume / replay

Resume is automatic. If the journal exists and the manifest matches, completed terminal nodes are replayed by `cacheKey`.

The key includes prompt, validation schema, model, resolved cwd, sandbox, structural position, and dependency `prevKey`. It excludes backend identity, thread id, signal, timestamps, jitter, env, wall-clock, and repair text.

Replayed nodes do not call the backend and do not charge budget again.

## Budget

Budgets are best-effort soft limits:

1. reserve an estimate before taking a backend slot;
2. run the adapter;
3. reconcile with actual usage.

Billable input is `input_tokens - cached_input_tokens`. `downgrade` is only valid for schema-only nodes.

## Determinism boundary

During `engine.run()`, the workflow gets seeded shadows for `Date`, `Date.now`, `Math.random`, `performance.now`, `process.hrtime`, `crypto.randomUUID`, and `crypto.getRandomValues` where available.

This is best-effort. Dependencies that captured real globals at import time can still leak nondeterminism. Workflow authors should keep control flow on `ctx.now()` and `ctx.random()`.

## Real backend smoke checks

Run one real backend smoke test:

```bash
npx tsx scripts/smoke.ts --backend codex-sdk
```

Other backends:

```bash
npx tsx scripts/smoke.ts --backend codex-exec
npx tsx scripts/smoke.ts --backend openai-responses
```

Missing credentials or a missing CLI prints `SMOKE_SKIPPED` and exits 0.

For a real replay demo with `codex-sdk`:

```bash
RUN_DIR=$(mktemp -d /tmp/codex-workflow-e2e-run-XXXXXX)
npx tsx scripts/e2e.ts --run-dir "$RUN_DIR" --pause-after-parallel
# Press Ctrl-C after READY_FOR_INTERRUPT.
npx tsx scripts/e2e.ts --run-dir "$RUN_DIR"
```

The second run prints completed parallel nodes with `replayed:true` and only calls the backend for unfinished nodes.

## Testing with FakeAdapter

Unit tests use `FakeAdapter`; real backends are not part of the default test suite.

```bash
npm run typecheck
npm test
```

Fake adapter config example:

```ts
const engine = createEngine({
  defaultBackend: "fake",
  autoRoute: false,
  adapters: {
    fake: {
      responses: [{ ok: true }],
    },
  },
});
```

Current regression suite covers keyed replay, dependency invalidation, schema repair, transient retry, writable cwd protection, deterministic shadows, soft budget skip, and crash-residue journal loading.
