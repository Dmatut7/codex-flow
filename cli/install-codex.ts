import { cpSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "dynamic-workflow";

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function valueAfter(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Copy the bundled codex-skill/ folder into the user's Codex skills dir. */
export async function installCodex(argv: string[]): Promise<void> {
  const source = fileURLToPath(new URL("../codex-skill", import.meta.url));
  if (!existsSync(source)) {
    console.error(`dongt: bundled skill not found at ${source}`);
    process.exit(1);
  }

  const explicitDir = valueAfter(argv, "--dir");
  const skillsDir = explicitDir ?? path.join(codexHome(), "skills");
  const target = path.join(skillsDir, SKILL_NAME);

  mkdirSync(skillsDir, { recursive: true });
  cpSync(source, target, { recursive: true });

  console.log("✓ Installed Codex skill: dynamic-workflow");
  console.log(`  ${target}`);
  console.log("");
  console.log("Now restart Codex, then in ANY project just say, e.g.:");
  console.log('  「用动态工作流帮我排查登录失败的问题」');
  console.log('  "use a dynamic workflow to investigate this bug in parallel"');
  console.log("");
  console.log("Codex will generate + run the workflow for you (uses your Codex membership; no API key).");
}
