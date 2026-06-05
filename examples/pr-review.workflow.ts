import { z } from "zod";
import type { WorkflowContext } from "../engine/index.ts";

const ReviewPass = z.object({
  pass: z.string(),
  risks: z.array(z.string()),
  strengths: z.array(z.string()),
  recommendation: z.enum(["approve", "changes_requested", "needs_more_info"]),
}).strict();

const Verdict = z.object({
  recommendation: z.enum(["approve", "changes_requested", "needs_more_info"]),
  mustFix: z.array(z.string()),
  summary: z.string(),
}).strict();

export default async function workflow({ agent, parallel, phase, log }: WorkflowContext) {
  const passes = [
    "correctness and edge cases",
    "regression risk and backwards compatibility",
    "tests, docs, and developer experience",
    "API/schema/sandbox assumptions",
  ];

  const reviews = await phase("parallel review passes", async () => parallel(passes.map((pass) => async () => {
    const result = await agent(
      `Review the current repository changes from this angle: ${pass}.\n\nInspect the working tree and git diff. Return concrete risks, strengths, and a recommendation.`,
      {
        schema: ReviewPass,
        cwd: process.cwd(),
        sandbox: "read-only",
        nodeKey: `pr-review:${pass}`,
      },
    );
    return result.output;
  })));

  const completed = reviews.filter(Boolean);
  log("review passes", completed);

  const verdict = await phase("merge review", async () => agent(
    `Merge these independent PR review passes into one final maintainer verdict.\n\n${JSON.stringify(completed, null, 2)}`,
    {
      schema: Verdict,
      kind: "judge",
      pure: true,
      nodeKey: "pr-review:verdict",
    },
  ));

  return verdict.output;
}
