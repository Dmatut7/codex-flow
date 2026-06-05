import { z } from "zod";
import { runWorkflow, type WorkflowContext } from "../engine/index.ts";

export default async function workflow({ agent, parallel, pipeline, phase, log, budget, random }: WorkflowContext) {
  budget.configure({ maxTokens: 400_000, maxNodes: 50, onExceeded: "throw" });

  const Triage = z.object({
    files: z.array(z.string()),
    severity: z.enum(["low", "med", "high"]),
    rationale: z.string(),
  }).strict();

  const triage: any = await phase("triage", async () => {
    log("classifying the incoming bug report");
    const r = await agent(
      "列出这份 bug 报告最可能涉及的至多 5 个源文件、一个严重度、一行理由。\n\nREPORT:\n购物车 >50 项时 POST /checkout 间歇 500;日志显示 pricing 超时。",
      { schema: Triage, pure: true, kind: "classify" },
    );
    return r.output;
  });
  log(`triage picked ${triage.files.length} files`, { severity: triage.severity });

  const Finding = z.object({
    file: z.string(), diagnosis: z.string(), fixSketch: z.string(), confidence: z.number(),
  }).strict();
  const findings = await phase("deep-dive", async () => parallel(triage.files.map((file: string) => async () => (
    await agent(`检查 ${file},定位 checkout 超时的根因;给 diagnosis、fixSketch、0..1 confidence。`, {
      schema: Finding,
      cwd: process.cwd(),
      sandbox: "read-only",
    })
  ).output)));
  const solid = findings.filter((f: any) => f && f.confidence >= 0.5);
  log(`got ${solid.length} confident findings of ${findings.length}`);

  const Patch = z.object({ file: z.string(), diff: z.string() }).strict();
  const Review = z.object({ approved: z.boolean(), notes: z.string() }).strict();
  const reviewed = await phase("patch-and-review", async () => pipeline(solid,
    async (f: any) => (await agent(`按 fixSketch 修复 ${f.file},返回 unified diff。\n${f.fixSketch}`, {
      schema: Patch,
      cwd: process.cwd(),
      sandbox: "workspace-write",
    })).output,
    async (patch: any) => (await agent(`审查这个 diff 是否会回归 checkout,只在不会回归时 approve。\n${patch.diff}`, {
      schema: Review,
      pure: true,
      kind: "judge",
    })).output,
  ));

  return phase("verdict", async () => {
    budget.guard();
    const approvals = reviewed.filter((r: any) => r && r.approved).length;
    const tieBreak = random();
    const Verdict = z.object({ ship: z.boolean(), summary: z.string() }).strict();
    const v = await agent(`${approvals}/${reviewed.length} 个补丁通过(tiebreak ${tieBreak.toFixed(3)}),决定 ship 还是 hold 并总结。`, {
      schema: Verdict,
      pure: true,
      kind: "judge",
    });
    log("verdict", v.output);
    return v.output;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkflow(workflow, {
    defaultBackend: "fake",
    autoRoute: false,
    adapters: {
      fake: {
        resolver: ({ prompt }: { prompt: string }) => {
          if (prompt.includes("列出这份 bug 报告")) return { files: ["pricing.ts", "checkout.ts"], severity: "high", rationale: "pricing timeout" };
          if (prompt.includes("检查 pricing.ts")) return { file: "pricing.ts", diagnosis: "timeout", fixSketch: "add deadline", confidence: 0.8 };
          if (prompt.includes("检查 checkout.ts")) return { file: "checkout.ts", diagnosis: "propagation", fixSketch: "pass signal", confidence: 0.7 };
          if (prompt.includes("修复 pricing.ts")) return { file: "pricing.ts", diff: "diff --git a/pricing.ts b/pricing.ts" };
          if (prompt.includes("修复 checkout.ts")) return { file: "checkout.ts", diff: "diff --git a/checkout.ts b/checkout.ts" };
          if (prompt.includes("审查这个 diff")) return { approved: true, notes: "ok" };
          if (prompt.includes("决定 ship")) return { ship: true, summary: "ship guarded timeout fix" };
          return { prompt };
        },
      },
    },
  }).then((result) => console.log(JSON.stringify(result, null, 2)));
}
