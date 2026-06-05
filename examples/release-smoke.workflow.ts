const SmokeCheckSchema = {
  type: "object",
  additionalProperties: false,
  required: ["check", "status", "evidence", "suggestedCommand"],
  properties: {
    check: { type: "string" },
    status: { enum: ["pass", "warn", "fail"] },
    evidence: { type: "array", items: { type: "string" } },
    suggestedCommand: { type: "string" },
  },
};

const ReleaseVerdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ready", "blockers", "summary"],
  properties: {
    ready: { type: "boolean" },
    blockers: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};

export default async function workflow(ctx: any) {
  const { agent, parallel, phase, log } = ctx;
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
        schema: SmokeCheckSchema,
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
      schema: ReleaseVerdictSchema,
      kind: "judge",
      pure: true,
      nodeKey: "release:verdict",
    },
  ));

  return verdict.output;
}
