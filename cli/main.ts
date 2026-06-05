import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installCodex } from "./install-codex.ts";
import { run } from "./run.ts";

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `dongt — dynamic workflow engine for Codex

Usage:
  dongt install-codex [--dir <skills-dir>]   Install the Codex skill (default: $CODEX_HOME/skills)
  dongt run <workflow.ts> [--backend <name>] [--journal <path>]
                                             Run a workflow (default backend: codex-sdk, resumes on re-run)
  dongt --version
  dongt --help

After install-codex + restarting Codex, just tell Codex (in any project):
  「用动态工作流帮我…」 / "use a dynamic workflow to … in parallel"
and it generates + runs the workflow for you.`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "install-codex":
      await installCodex(rest);
      break;
    case "run":
      await run(rest);
      break;
    case "-v":
    case "--version":
      console.log(version());
      break;
    case undefined:
    case "-h":
    case "--help":
      console.log(HELP);
      break;
    default:
      console.error(`dongt: unknown command "${cmd}"\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
