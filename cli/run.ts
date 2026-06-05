import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runWorkflow } from "../engine/index.ts";
import type { EngineConfig } from "../engine/types.ts";

function valueAfter(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
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
    console.error("usage: codex-flow run <workflow.ts> [--backend codex-sdk|codex-exec|fake] [--journal <path>]");
    process.exit(2);
  }
  const abs = path.resolve(file);
  if (!existsSync(abs)) {
    console.error(`codex-flow: workflow not found: ${abs}`);
    process.exit(2);
  }

  const name = path.basename(abs).replace(/\.(ts|js|mjs|cjs)$/, "").replace(/\.workflow$/, "");
  const backend = valueAfter(argv, "--backend") ?? "codex-sdk";
  const journalPath = valueAfter(argv, "--journal") ?? path.join(process.cwd(), ".codex-flow", "journal", `${name}.jsonl`);
  mkdirSync(path.dirname(journalPath), { recursive: true });

  // Optional per-project overrides at .codex-flow/config.json
  const cfgPath = path.join(process.cwd(), ".codex-flow", "config.json");
  const fileCfg: Partial<EngineConfig> = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};

  const config: EngineConfig = {
    autoRoute: false,
    ...fileCfg,
    defaultBackend: backend as EngineConfig["defaultBackend"],
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
