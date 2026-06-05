# codex-flow engine API (for generating workflows)

A workflow is a single file that **exports a default async function** taking `ctx`. It is run by `codex-flow run <file>`. **No imports.** Structured output uses **plain JSON Schema objects**.

## ctx surface

```
ctx.agent(prompt: string, opts?): Promise<AgentResult>
ctx.parallel(thunks: Array<() => Promise<R>>): Promise<Array<R|null>>     // BARRIER fan-out; failed item -> null
ctx.pipeline(items: any[], ...stages): Promise<Array<any|null>>           // per-item multi-stage, no barrier between stages
ctx.phase(title: string, body: () => Promise<R>): Promise<R>              // named scope / barrier point
ctx.log(msg: string, data?): void
ctx.now(): number      // deterministic clock — use instead of Date.now()
ctx.random(): number   // deterministic RNG — use instead of Math.random()
ctx.budget.configure({ maxTokens?, maxNodes?, onExceeded?: "throw"|"skip"|"downgrade" })
```

### agent() opts (all optional)
- `schema`: a plain JSON Schema object → forces structured JSON output (auto-parsed into `result.output`).
- `sandbox`: `"read-only"` (default) | `"workspace-write"` | `"danger-full-access"`.
- `cwd`: directory for the sub-agent. Required when `sandbox` is writable; use `process.cwd()`.
- `model`, `timeoutMs`, `retries`, `nodeKey`. Leave `backend` unset → uses the default `codex-sdk` (membership).

### AgentResult
`{ output, raw, usage, backend, replayed, status }` — `status:"error"` means that sub-agent failed (it becomes `null` inside parallel/pipeline). `output` is the parsed object when a `schema` was given.

## JSON Schema rules (strict mode)
- Root MUST be `{ "type": "object", ... }` (wrap arrays as `{ items: [...] }`).
- Every object: `"additionalProperties": false` and EVERY property listed in `"required"`. Model an optional field as a null-union type, e.g. `{ "type": ["string","null"] }`.
- Keep it small: ≤100 properties, ≤5 levels deep, ≤500 enum values.

## parallel vs pipeline
- **parallel**: independent tasks you want all results of (review N files, test M hypotheses). Returns results in input order; a failed one is `null`.
- **pipeline**: each item flows through stages (e.g. diagnose → propose-fix), items overlap across stages (no waiting for the slowest at each stage).
- **phase**: wrap a group when the next step needs everything in it finished.

## Copy-paste template (import-free, JSON Schema, codex-sdk)

```ts
export default async function workflow(ctx) {
  const { agent, parallel, phase, log } = ctx;

  const FindingSchema = {
    type: "object",
    additionalProperties: false,
    required: ["file", "suspect", "confidence"],
    properties: {
      file: { type: "string" },
      suspect: { type: "string" },
      confidence: { type: "number" },
    },
  };

  const files = ["src/auth/login.ts", "src/auth/session.ts", "src/api/client.ts"];

  const findings = await phase("investigate", async () =>
    parallel(files.map((file) => async () => {
      const r = await agent(
        `Investigate ${file} for the cause of login failures. ` +
        `Read the file and report the most likely suspect line/function and a 0..1 confidence.`,
        { schema: FindingSchema, sandbox: "read-only" }   // backend defaults to codex-sdk (membership)
      );
      return r.output;
    }))
  );

  const solid = findings.filter((f) => f && f.confidence >= 0.5);
  log(`found ${solid.length} likely suspects`, solid);
  return { suspects: solid };
}
```

Run: `codex-flow run .codex-flow/generated/login-bug.workflow.ts` (resumes on re-run).
