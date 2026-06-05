import { z } from "zod";
import type { WorkflowContext } from "../engine/index.ts";

const SmokeCheck = z.object({
  check: z.string(),
  status: z.enum(["pass", "warn", "fail"]),
  evidence: z.array(z.string()),
  suggestedCommand: z.string(),
}).strict();

const ReleaseVerdict = z.object({
  ready: z.boolean(),
  blockers: z.array(z.string()),
  summary: z.string(),
}).strict();

export default async function workflow({ agent, parallel, phase, log }: WorkflowContext) {
  const checks = [
    "package metadata and install command",
    "README first-run experience",
    "CLI smoke path and examples",
    "release notes, license, and contribution docs",
  ];

  const results = await phase("release smoke checks", async () => parallel(checks.map((check) => async () => {
    const result = await agent(
      `Run a read-only release-readiness review for: ${check}.\n\nInspect this repository and return pass/warn/fail, concrete evidence, and the exact command a maintainer should run next.`,
      {
        schema: SmokeCheck,
        cwd: process.cwd(),
        sandbox: "read-only",
        nodeKey: `release:${check}`,
      },
    );
    return result.output;
  })));

  log("smoke results", results);

  const verdict = await phase("release verdict", async () => agent(
    `Decide whether this release is ready based on these smoke checks.\n\n${JSON.stringify(results.filter(Boolean), null, 2)}`,
    {
      schema: ReleaseVerdict,
      kind: "judge",
      pure: true,
      nodeKey: "release:verdict",
    },
  ));

  return verdict.output;
}
