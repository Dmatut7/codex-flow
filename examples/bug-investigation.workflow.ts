import { z } from "zod";
import type { WorkflowContext } from "../engine/index.ts";

const Finding = z.object({
  area: z.string(),
  likelyCause: z.string(),
  evidenceToCheck: z.array(z.string()),
  confidence: z.number(),
}).strict();

const Summary = z.object({
  topCause: z.string(),
  nextAction: z.string(),
  summary: z.string(),
}).strict();

export default async function workflow({ agent, parallel, phase, log }: WorkflowContext) {
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
        schema: Finding,
        cwd: process.cwd(),
        sandbox: "read-only",
        nodeKey: `bug:${area}`,
      },
    );
    return result.output;
  })));

  const completed = findings.filter(Boolean) as Array<z.infer<typeof Finding>>;
  const solid = completed.filter((finding) => finding.confidence >= 0.5);
  log("solid findings", solid);

  const summary = await phase("synthesize", async () => agent(
    `Synthesize these parallel bug findings into one maintainer action plan.\n\n${JSON.stringify(solid, null, 2)}`,
    {
      schema: Summary,
      kind: "judge",
      pure: true,
      nodeKey: "bug:synthesis",
    },
  ));

  return summary.output;
}
