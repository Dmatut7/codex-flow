const IssueTriageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["issue", "category", "priority", "nextStep", "needsMaintainer"],
  properties: {
    issue: { type: "string" },
    category: { enum: ["bug", "feature", "question", "docs", "maintenance"] },
    priority: { enum: ["low", "medium", "high"] },
    nextStep: { type: "string" },
    needsMaintainer: { type: "boolean" },
  },
};

const TriageSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["topPriority", "batchAction", "summary"],
  properties: {
    topPriority: { type: "string" },
    batchAction: { type: "string" },
    summary: { type: "string" },
  },
};

export default async function workflow(ctx: any) {
  const { agent, parallel, phase, log } = ctx;
  const issues = [
    "Install fails on Node 18 with ESM loader error",
    "Request: add a one-command PR review workflow",
    "Docs: clarify whether OpenAI API key is required",
    "Bug: resume reruns a completed branch after README-only changes",
  ];

  const triaged = await phase("parallel issue triage", async () => parallel(issues.map((issue) => async () => {
    const result = await agent(
      `Triage this OSS issue for a maintainer. Classify category, priority, next step, and whether a maintainer must look now.\n\nISSUE: ${issue}`,
      {
        schema: IssueTriageSchema,
        sandbox: "read-only",
        nodeKey: `issue:${issue}`,
      },
    );
    return result.output;
  })));

  const completed = triaged.filter(Boolean);
  log("triaged issues", completed);

  const summary = await phase("triage summary", async () => agent(
    `Summarize this issue triage batch into one maintainer action.\n\n${JSON.stringify(completed, null, 2)}`,
    {
      schema: TriageSummarySchema,
      kind: "judge",
      pure: true,
      nodeKey: "issue:summary",
    },
  ));

  return summary.output;
}
