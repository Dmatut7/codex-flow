const FindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["area", "likelyCause", "evidenceToCheck", "confidence"],
  properties: {
    area: { type: "string" },
    likelyCause: { type: "string" },
    evidenceToCheck: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
};

const SummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["topCause", "nextAction", "summary"],
  properties: {
    topCause: { type: "string" },
    nextAction: { type: "string" },
    summary: { type: "string" },
  },
};

export default async function workflow(ctx: any) {
  const { agent, parallel, phase, log } = ctx;
  const bug = "Users are intermittently logged out after refreshing the page.";
  const areas = [
    "session persistence and cookie configuration",
    "token refresh / expiry handling",
    "frontend auth state hydration",
    "server-side auth middleware and redirects",
  ];

  const findings = await phase("parallel bug investigation", async () => parallel(areas.map((area) => async () => {
    const result = await agent(
      `Investigate this bug area in the current repository.\n\nBUG: ${bug}\nAREA: ${area}\n\nReturn the likely cause, concrete evidence to check, and confidence from 0 to 1.`,
      {
        schema: FindingSchema,
        cwd: process.cwd(),
        sandbox: "read-only",
        nodeKey: `bug:${area}`,
      },
    );
    return result.output;
  })));

  const completed = findings.filter(Boolean);
  const solid = completed.filter((finding: any) => finding.confidence >= 0.5);
  log("solid findings", solid);

  const summary = await phase("synthesize", async () => agent(
    `Synthesize these parallel bug findings into one maintainer action plan.\n\n${JSON.stringify(solid, null, 2)}`,
    {
      schema: SummarySchema,
      kind: "judge",
      pure: true,
      nodeKey: "bug:synthesis",
    },
  ));

  return summary.output;
}
