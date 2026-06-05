import { existsSync } from "node:fs";
import { init, STARTER_WORKFLOW_PATH } from "./init.ts";
import { run } from "./run.ts";

export async function tryStarter(_argv: string[]): Promise<void> {
  console.log("codex-flow try");
  console.log("");
  if (existsSync(STARTER_WORKFLOW_PATH)) {
    console.log(`Using existing starter workflow: ${STARTER_WORKFLOW_PATH}`);
  } else {
    await init([]);
  }
  console.log("");
  console.log("Running starter workflow with fake backend...");
  console.log("");
  await run([STARTER_WORKFLOW_PATH, "--backend", "fake"]);
  console.log("");
  console.log("Next:");
  console.log("  codex-flow install-codex");
  console.log("  codex-flow doctor");
  console.log("  codex-flow run .codex-flow/generated/starter.workflow.ts --backend codex-sdk");
}
