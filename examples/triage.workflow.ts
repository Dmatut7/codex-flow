const TriageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["files", "severity", "rationale"],
  properties: {
    files: { type: "array", items: { type: "string" } },
    severity: { enum: ["low", "med", "high"] },
    rationale: { type: "string" },
  },
};

const FindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "diagnosis", "fixSketch", "confidence"],
  properties: {
    file: { type: "string" },
    diagnosis: { type: "string" },
    fixSketch: { type: "string" },
    confidence: { type: "number" },
  },
};

const PatchPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "diffSketch"],
  properties: {
    file: { type: "string" },
    diffSketch: { type: "string" },
  },
};

const ReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "notes"],
  properties: {
    approved: { type: "boolean" },
    notes: { type: "string" },
  },
};

const VerdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ship", "summary"],
  properties: {
    ship: { type: "boolean" },
    summary: { type: "string" },
  },
};

export default async function workflow(ctx: any) {
  const { agent, parallel, pipeline, phase, log, budget, random } = ctx;
  budget.configure({ maxTokens: 400000, maxNodes: 50, onExceeded: "throw" });

  const triage = await phase("triage", async () => {
    log("classifying the incoming bug report");
    const result = await agent(
      "List up to 5 source files most likely involved, one severity, and one rationale.\n\nREPORT:\nCart checkout intermittently returns 500 when the cart has more than 50 items; logs show pricing timeout.",
      { schema: TriageSchema, pure: true, kind: "classify", nodeKey: "triage:classify" },
    );
    return result.output;
  });
  log(`triage picked ${triage.files.length} files`, { severity: triage.severity });

  const findings = await phase("deep-dive", async () => parallel(triage.files.map((file: string) => async () => {
    const result = await agent(`Inspect ${file} for the checkout timeout root cause. Return diagnosis, fixSketch, and confidence.`, {
      schema: FindingSchema,
      cwd: process.cwd(),
      sandbox: "read-only",
      nodeKey: `triage:deep-dive:${file}`,
    });
    return result.output;
  })));

  const solid = findings.filter((finding: any) => finding && finding.confidence >= 0.5);
  log(`got ${solid.length} confident findings of ${findings.length}`);

  const reviewed = await phase("plan-and-review", async () => pipeline(solid,
    async (finding: any) => (await agent(`Draft a unified diff plan for ${finding.file}. Do not edit files.\n\n${finding.fixSketch}`, {
      schema: PatchPlanSchema,
      cwd: process.cwd(),
      sandbox: "read-only",
      nodeKey: `triage:patch-plan:${finding.file}`,
    })).output,
    async (patch: any) => (await agent(`Review whether this diff plan could regress checkout. Approve only if safe.\n\n${patch.diffSketch}`, {
      schema: ReviewSchema,
      pure: true,
      kind: "judge",
      nodeKey: `triage:review:${patch.file}`,
    })).output,
  ));

  return phase("verdict", async () => {
    budget.guard();
    const approvals = reviewed.filter((review: any) => review && review.approved).length;
    const tieBreak = random();
    const verdict = await agent(`${approvals}/${reviewed.length} plans passed review (tiebreak ${tieBreak.toFixed(3)}). Decide ship or hold and summarize.`, {
      schema: VerdictSchema,
      pure: true,
      kind: "judge",
      nodeKey: "triage:verdict",
    });
    log("verdict", verdict.output);
    return verdict.output;
  });
}
