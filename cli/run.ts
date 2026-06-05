import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runWorkflow } from "../engine/index.ts";
import type { EngineConfig } from "../engine/types.ts";

function valueAfter(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    console.error(`codex-flow: ${name} requires a value`);
    process.exit(2);
  }
  return value;
}

const VALUE_FLAGS = new Set(["--backend", "--journal", "--cwd", "--seed"]);

function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i++; // skip its value
      continue;
    }
    return a;
  }
  return undefined;
}

/** `codex-flow run <workflow.ts> [--backend codex-sdk] [--journal path]` */
export async function run(argv: string[]): Promise<void> {
  const file = firstPositional(argv);
  if (!file) {
    console.error("usage: codex-flow run <workflow.ts> [--backend codex-sdk|codex-exec|fake] [--journal <path>] [--cwd <dir>] [--seed <n>]");
    process.exit(2);
  }
  const cwdArg = valueAfter(argv, "--cwd");
  if (cwdArg) {
    const runCwd = path.resolve(cwdArg);
    if (!existsSync(runCwd)) {
      console.error(`codex-flow: cwd not found: ${runCwd}`);
      process.exit(2);
    }
    process.chdir(runCwd);
  }
  const abs = path.resolve(file);
  if (!existsSync(abs)) {
    console.error(`codex-flow: workflow not found: ${abs}`);
    process.exit(2);
  }

  const name = path.basename(abs).replace(/\.(ts|js|mjs|cjs)$/, "").replace(/\.workflow$/, "");
  const backend = valueAfter(argv, "--backend") ?? "codex-sdk";
  const seedRaw = valueAfter(argv, "--seed");
  const seed = seedRaw === undefined ? undefined : Number(seedRaw);
  if (seedRaw !== undefined && !Number.isInteger(seed)) {
    console.error(`codex-flow: --seed must be an integer, got: ${seedRaw}`);
    process.exit(2);
  }
  const journalPath = valueAfter(argv, "--journal") ?? path.join(process.cwd(), ".codex-flow", "journal", `${name}.jsonl`);
  mkdirSync(path.dirname(journalPath), { recursive: true });

  // Optional per-project overrides at .codex-flow/config.json
  const cfgPath = path.join(process.cwd(), ".codex-flow", "config.json");
  const fileCfg: Partial<EngineConfig> = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};

  const config: EngineConfig = {
    autoRoute: false,
    ...fileCfg,
    defaultBackend: backend as EngineConfig["defaultBackend"],
    ...(seed !== undefined ? { seed } : {}),
    journalPath,
  };

  try {
    const result = await runWorkflow(abs, config);
    console.log(JSON.stringify(result, null, 2));
    console.error(`\n(journal: ${journalPath} — re-run the same command to resume)`);
  } catch (error) {
    console.error(`codex-flow run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
