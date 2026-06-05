import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STARTER_WORKFLOW_PATH = ".codex-flow/generated/starter.workflow.ts";

const STARTER = `export default async function workflow(ctx) {
  const { agent, parallel, phase, log } = ctx;

  const items = ["README first impression", "install path", "developer experience"];

  const findings = await phase("starter parallel check", async () =>
    parallel(items.map((item) => async () => {
      const result = await agent(
        "Review this project aspect and return one concise finding: " + item,
        {
          sandbox: "read-only",
          nodeKey: "starter:" + item
        }
      );
      return result.output;
    }))
  );

  log("starter findings", findings);
  return { findings };
}
`;

export async function init(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  const dir = path.join(process.cwd(), path.dirname(STARTER_WORKFLOW_PATH));
  const file = path.join(dir, "starter.workflow.ts");

  mkdirSync(dir, { recursive: true });
  if (existsSync(file) && !force) {
    console.error(`codex-flow: ${file} already exists. Use --force to overwrite.`);
    process.exit(2);
  }

  writeFileSync(file, STARTER, "utf8");
  console.log("✓ Created starter workflow");
  console.log(`  ${file}`);
  console.log("");
  console.log("Try it without network:");
  console.log("  codex-flow run .codex-flow/generated/starter.workflow.ts --backend fake");
  console.log("");
  console.log("Then try it with your Codex membership:");
  console.log("  codex-flow run .codex-flow/generated/starter.workflow.ts --backend codex-sdk");
}
