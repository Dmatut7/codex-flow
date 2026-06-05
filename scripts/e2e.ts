#!/usr/bin/env tsx
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createEngine, type AgentResult } from "../engine/index.ts";

interface Args {
  runDir?: string;
  pauseAfterParallel: boolean;
}

function parseArgs(argv: string[]): Args {
  const runDirIdx = argv.indexOf("--run-dir");
  return {
    runDir: runDirIdx >= 0 ? argv[runDirIdx + 1] : undefined,
    pauseAfterParallel: argv.includes("--pause-after-parallel"),
  };
}

async function ensureFixture(runDir?: string): Promise<{ runDir: string; repoDir: string; files: string[] }> {
  const resolvedRunDir = runDir ? path.resolve(runDir) : await mkdtemp(path.join(tmpdir(), "codex-workflow-e2e-"));
  const repoDir = path.join(resolvedRunDir, "repo");
  await mkdir(repoDir, { recursive: true });
  const sources = new Map([
    ["alpha.ts", "export function alpha(value: number) { return value + 1; }\n"],
    ["beta.ts", "export function beta(name: string) { return name.trim().toLowerCase(); }\n"],
  ]);
  for (const [file, source] of sources) await writeFile(path.join(repoDir, file), source, "utf8");
  return { runDir: resolvedRunDir, repoDir, files: [...sources.keys()] };
}

function usageTotal(result: AgentResult): number {
  return result.usage.input_tokens + result.usage.cached_input_tokens + result.usage.output_tokens + (result.usage.reasoning_output_tokens ?? 0);
}

async function pauseForCtrlC(): Promise<never> {
  console.log("READY_FOR_INTERRUPT parallel phase completed; send Ctrl-C now.");
  return new Promise(() => {
    setInterval(() => {}, 60_000);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixture = await ensureFixture(args.runDir);
  const journalPath = path.join(fixture.runDir, "journal.jsonl");
  const Triage = z.object({ file: z.string(), kind: z.string(), summary: z.string() }).strict();
  const Action = z.object({ file: z.string(), nextStep: z.string() }).strict();
  const nodeResults: Array<{ node: string; replayed: boolean; threadId: string | null; usageTotal: number }> = [];

  function record(node: string, result: AgentResult): void {
    const event = { node, replayed: result.replayed, threadId: result.threadId ?? null, usageTotal: usageTotal(result) };
    nodeResults.push(event);
    console.log(`NODE_RESULT ${JSON.stringify(event)}`);
  }

  const engine = createEngine({
    defaultBackend: "codex-sdk",
    autoRoute: false,
    journalPath,
    timeoutMs: 120_000,
    concurrency: 2,
  });

  const output = await engine.run(async ({ agent, parallel, pipeline, phase }) => {
    const triage = await phase("parallel-triage", async () => parallel(fixture.files.map((file) => async () => {
      const source = await readFile(path.join(fixture.repoDir, file), "utf8");
      const result = await agent(
        `Classify this TypeScript file and return concise JSON.\nFILE: ${file}\nSOURCE:\n${source}`,
        {
          backend: "codex-sdk",
          cwd: fixture.repoDir,
          sandbox: "read-only",
          schema: Triage,
          nodeKey: `triage:${file}`,
          timeoutMs: 120_000,
          retries: 0,
        },
      );
      record(`triage:${file}`, result);
      return result.output;
    })));

    if (args.pauseAfterParallel) await pauseForCtrlC();

    const firstTriage = triage.filter(Boolean).slice(0, 1);
    return phase("pipeline-plan", async () => pipeline(firstTriage,
      async (item: any) => {
        const result = await agent(
          `Given this triage JSON, return one nextStep JSON.\nTRIAGE:\n${JSON.stringify(item)}`,
          {
            backend: "codex-sdk",
            cwd: fixture.repoDir,
            sandbox: "read-only",
            schema: Action,
            nodeKey: `plan:${item.file}`,
            timeoutMs: 120_000,
            retries: 0,
          },
        );
        record(`plan:${item.file}`, result);
        return result.output;
      },
    ));
  });

  const newBackendCalls = nodeResults.filter((node) => !node.replayed).length;
  console.log(`SUMMARY ${JSON.stringify({ runDir: fixture.runDir, journalPath, newBackendCalls, nodeResults, output })}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
