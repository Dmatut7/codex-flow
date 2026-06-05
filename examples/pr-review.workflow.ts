const ReviewPassSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "risks", "strengths", "recommendation"],
  properties: {
    pass: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
    recommendation: { enum: ["approve", "changes_requested", "needs_more_info"] },
  },
};

const VerdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["recommendation", "mustFix", "summary"],
  properties: {
    recommendation: { enum: ["approve", "changes_requested", "needs_more_info"] },
    mustFix: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};

export default async function workflow(ctx: any) {
  const { agent, parallel, phase, log } = ctx;
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
        schema: ReviewPassSchema,
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
      schema: VerdictSchema,
      kind: "judge",
      pure: true,
      nodeKey: "pr-review:verdict",
    },
  ));

  return verdict.output;
}
