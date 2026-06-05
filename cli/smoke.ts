import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createEngine, type AgentResult } from "../engine/index.ts";
import type { BackendName } from "../engine/types.ts";

type RealBackend = "codex-sdk" | "codex-exec" | "openai-responses";

const REAL_BACKENDS = new Set<RealBackend>(["codex-sdk", "codex-exec", "openai-responses"]);

function valueAfter(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    console.error(`SMOKE_FAILED ${name} requires a value`);
    console.error("usage: codex-flow smoke --backend codex-sdk|codex-exec|openai-responses");
    process.exit(2);
  }
  return value;
}

function parseBackend(argv: string[]): RealBackend {
  const value = valueAfter(argv, "--backend") ?? "codex-sdk";
  if (!REAL_BACKENDS.has(value as RealBackend)) {
    console.error(`SMOKE_FAILED invalid backend: ${value ?? "<missing>"}`);
    console.error("usage: codex-flow smoke --backend codex-sdk|codex-exec|openai-responses");
    process.exit(2);
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

export function unavailableHint(backend: RealBackend): string {
  if (backend === "codex-exec") return "Install/login to codex CLI, or provide CODEX_API_KEY.";
  if (backend === "openai-responses") return "Set OPENAI_API_KEY, or configure adapters.openaiResponses with credentials.";
  return "Login to Codex CLI/Codex App with your Codex membership; no OpenAI API key is needed for @openai/codex-sdk.";
}

function unavailableReason(message: string): boolean {
  return /api.?key|OPENAI_API_KEY|CODEX_API_KEY|auth|login|not logged|unauthori[sz]ed|forbidden|401|403|credentials|quota|codex CLI not found|not runnable|ENOENT|spawn .*ENOENT/i.test(message);
}

export async function smoke(argv: string[]): Promise<void> {
  const backend = parseBackend(argv);
  if (backend === "codex-exec" && !codexCliAvailable()) {
    console.log("SMOKE_SKIPPED codex-exec unavailable: codex CLI not found or not runnable.");
    console.log(unavailableHint(backend));
    return;
  }

  let dir: string;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "codex-flow-smoke-"));
  } catch (error) {
    console.log(JSON.stringify({
      status: "SMOKE_SKIPPED",
      reason: `temporary directory unavailable: ${error instanceof Error ? error.message : String(error)}`,
      backend,
      hint: "Fix TMPDIR/TMP/TEMP permissions, then rerun codex-flow smoke.",
    }, null, 2));
    return;
  }
  const journalPath = path.join(dir, `${backend}.jsonl`);
  const PongSchema = z.object({ pong: z.boolean() }).strict();
  const engine = createEngine({
    defaultBackend: backend as BackendName,
    autoRoute: false,
    journalPath,
    timeoutMs: 60_000,
  });

  try {
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
      const reason = result.raw || "backend returned no valid structured result";
      const status = unavailableReason(reason) ? "SMOKE_SKIPPED" : "SMOKE_FAILED";
      console.log(JSON.stringify({
        status,
        reason,
        backend: result.backend,
        threadId: result.threadId ?? null,
        usage: result.usage,
        journalPath,
        hint: unavailableHint(backend),
      }, null, 2));
      if (status === "SMOKE_FAILED") process.exitCode = 1;
      return;
    }

    if (result.output.pong !== true || usageTotal(result.usage) <= 0) {
      console.log(JSON.stringify({
        status: "SMOKE_FAILED",
        reason: result.output.pong !== true ? "backend returned the wrong structured output" : "backend returned zero usage",
        backend: result.backend,
        threadId: result.threadId ?? null,
        output: result.output,
        usage: result.usage,
        usageTotal: usageTotal(result.usage),
        journalPath,
      }, null, 2));
      process.exitCode = 1;
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const status = unavailableReason(reason) ? "SMOKE_SKIPPED" : "SMOKE_FAILED";
    console.log(JSON.stringify({
      status,
      reason,
      backend,
      hint: unavailableHint(backend),
    }, null, 2));
    if (status === "SMOKE_FAILED") process.exitCode = 1;
  }
}
