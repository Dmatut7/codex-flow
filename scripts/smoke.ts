#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createEngine, type AgentResult, type BackendName } from "../engine/index.ts";

type RealBackend = "codex-sdk" | "codex-exec" | "openai-responses";

const REAL_BACKENDS = new Set<RealBackend>(["codex-sdk", "codex-exec", "openai-responses"]);

function parseBackend(argv: string[]): RealBackend {
  const flagIndex = argv.indexOf("--backend");
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : "codex-sdk";
  if (!REAL_BACKENDS.has(value as RealBackend)) {
    console.log(`SMOKE_SKIPPED invalid backend: ${value ?? "<missing>"}`);
    console.log("usage: npx tsx scripts/smoke.ts --backend codex-sdk|codex-exec|openai-responses");
    process.exit(0);
  }
  return value as RealBackend;
}

function codexCliAvailable(): boolean {
  const check = spawnSync("codex", ["--version"], { encoding: "utf8" });
  return check.status === 0;
}

function usageTotal(usage: AgentResult["usage"]): number {
  return usage.input_tokens + usage.cached_input_tokens + usage.output_tokens + (usage.reasoning_output_tokens ?? 0);
}

function unavailableHint(backend: RealBackend): string {
  if (backend === "codex-exec") return "Install/login to codex CLI, or provide CODEX_API_KEY.";
  if (backend === "openai-responses") return "Set OPENAI_API_KEY, or configure adapters.openaiResponses with credentials.";
  return "Login to codex CLI or provide CODEX_API_KEY for @openai/codex-sdk.";
}

async function main(): Promise<void> {
  const backend = parseBackend(process.argv.slice(2));
  if (backend === "codex-exec" && !codexCliAvailable()) {
    console.log("SMOKE_SKIPPED codex-exec unavailable: codex CLI not found or not runnable.");
    console.log(unavailableHint(backend));
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-smoke-"));
  const journalPath = path.join(dir, `${backend}.jsonl`);
  const PongSchema = z.object({ pong: z.boolean() }).strict();
  const engine = createEngine({
    defaultBackend: backend as BackendName,
    autoRoute: false,
    journalPath,
    timeoutMs: 60_000,
  });

  const result = await engine.run(async ({ agent }) => agent<{ pong: boolean }>(
    'Return only JSON matching this exact shape: {"pong":true}.',
    {
      backend,
      kind: "extract",
      pure: true,
      sandbox: "read-only",
      schema: PongSchema,
      timeoutMs: 60_000,
      retries: 1,
    },
  ));

  if (result.status !== "ok") {
    console.log(JSON.stringify({
      status: "SMOKE_SKIPPED",
      reason: "backend returned no valid structured result",
      backend: result.backend,
      threadId: result.threadId ?? null,
      usage: result.usage,
      journalPath,
      hint: unavailableHint(backend),
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    status: "SMOKE_OK",
    backend: result.backend,
    threadId: result.threadId ?? null,
    output: result.output,
    usage: result.usage,
    usageTotal: usageTotal(result.usage),
    replayed: result.replayed,
    journalPath,
  }, null, 2));
}

main().catch((error) => {
  const backendArg = process.argv[process.argv.indexOf("--backend") + 1];
  const backend = REAL_BACKENDS.has(backendArg as RealBackend) ? backendArg as RealBackend : "codex-sdk";
  console.log(JSON.stringify({
    status: "SMOKE_SKIPPED",
    reason: error instanceof Error ? error.message : String(error),
    backend,
    hint: unavailableHint(backend),
  }, null, 2));
  process.exit(0);
});
