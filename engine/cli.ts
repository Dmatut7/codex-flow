#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runWorkflow } from "./index.ts";
import type { EngineConfig } from "./types.ts";

async function main(): Promise<void> {
  const [command, scriptPath, ...rest] = process.argv.slice(2);
  if (command !== "run" || !scriptPath) {
    console.error("Usage: codex-engine run <workflow.ts> [--backend name] [--config codex.config.json] [--journal path] [--resume]");
    console.error("Resume is automatic when the journal exists; --resume is a compatibility placeholder and does not change behavior.");
    process.exit(2);
  }
  const configFlag = valueAfter(rest, "--config") ?? "codex.config.json";
  const config = await loadConfig(configFlag);
  const backend = valueAfter(rest, "--backend");
  const journalPath = valueAfter(rest, "--journal");
  if (backend) config.defaultBackend = backend;
  if (journalPath) config.journalPath = journalPath;
  const result = await runWorkflow(path.resolve(scriptPath), config);
  console.log(JSON.stringify(result, null, 2));
}

function valueAfter(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function loadConfig(file: string): Promise<EngineConfig> {
  try { return JSON.parse(await readFile(path.resolve(file), "utf8")); }
  catch { return {}; }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
