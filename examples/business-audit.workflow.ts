// Business-defect audit — the deep "code runs fine but violates business intent" shape.
// 5 phases: reconstruct intent -> multi-lens fan-out -> cross-artifact contradictions ->
// end-to-end flow trace -> adversarial verify + impact rank.
// Import-free + fail-closed (failed/skipped upstream output aborts) so it runs anywhere and under the fake backend.

const BaselineSchema = {
  type: "object",
  additionalProperties: false,
  required: ["invariants", "moneyRules", "authzRules", "stateTransitions", "flows", "oracleQuality"],
  properties: {
    invariants: { type: "array", items: { type: "string" } },
    moneyRules: { type: "array", items: { type: "string" } },
    authzRules: { type: "array", items: { type: "string" } },
    stateTransitions: { type: "array", items: { type: "string" } },
    flows: { type: "array", items: { type: "string" } }, // named business flows to trace in phase 4
    oracleQuality: { type: "string", enum: ["strong", "weak", "none"] }, // honest: did we find a real "should"?
  },
};

const LensFindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lens", "defects"],
  properties: {
    lens: { type: "string" },
    defects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "ruleViolated", "ruleLocation", "codeLocation", "why", "trigger"],
        properties: {
          title: { type: "string" },
          ruleViolated: { type: "string" },
          ruleLocation: { type: "string" }, // file:line of the intended rule / spec / test
          codeLocation: { type: "string" }, // file:line of the code that violates it
          why: { type: "string" },
          trigger: { type: "string" }, // concrete condition that makes the defect happen
        },
      },
    },
  },
};

const ContradictionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["contradictions", "unenforcedRules"],
  properties: {
    contradictions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["conflict", "artifacts", "location"],
        properties: {
          conflict: { type: "string" },
          artifacts: { type: "string" }, // which artifacts disagree (spec/test/code/schema)
          location: { type: "string" },
        },
      },
    },
    unenforcedRules: { type: "array", items: { type: "string" } }, // intended rules with no enforcing code
  },
};

const FlowTraceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["flow", "weaknesses"],
  properties: {
    flow: { type: "string" },
    weaknesses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "problem", "kind"],
        properties: {
          step: { type: "string" },
          problem: { type: "string" },
          kind: { type: "string", enum: ["skippable", "reorderable", "replayable", "missing-guard", "other"] },
        },
      },
    },
  },
};

const VerdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verified", "dismissed"],
  properties: {
    verified: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "impact", "trigger", "location", "maintainerAction"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          impact: { type: "string" }, // money loss / data exposure / privilege escalation / corruption
          trigger: { type: "string" },
          location: { type: "string" },
          maintainerAction: { type: "string" },
        },
      },
    },
    dismissed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "reason"],
        properties: { title: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

// Fixed business-defect lenses (NOT files). Each compares code to the intended rules.
const LENSES = [
  "money / amount / tax / rounding / refunds",
  "authorization / privilege escalation / tenant isolation",
  "state-machine & lifecycle (illegal transitions, missing guards, double-submit)",
  "concurrency / idempotency / double-spend (TOCTOU, races, retries)",
  "boundary / hostile input & trust (validation, injection, mass-assignment)",
];

function agentOutput(result: any, label: string) {
  if (!result || result.status !== "ok") {
    throw new Error(`business audit ${label} failed or was skipped; inspect the journal before trusting empty results`);
  }
  return result.output;
}

function requiredValue(value: any, label: string) {
  if (value === null || value === undefined) {
    throw new Error(`business audit ${label} failed or was skipped; inspect the journal before trusting empty results`);
  }
  return value;
}

export default async function workflow(ctx: any) {
  const { agent, parallel, pipeline, phase, log, budget } = ctx;

  // Audits cost many sub-agents — cap it so it never balloons on a large repo.
  budget.configure({ maxTokens: 600_000, maxNodes: 60, onExceeded: "skip" });

  // EDIT THIS: what to audit. The skill fills this in from the user's request.
  const target = "the checkout, pricing, and refund flow";

  // ---- Phase 1: reconstruct intent (the "should" oracle) ----
  const baseline = await phase("intent", async () => agent(
    `Reconstruct the INTENDED business rules for: ${target}.\n` +
    "Read specs, README/docs, tests (their assertions ARE intent), data models, DB schemas, migrations, and type definitions in this repo. " +
    "Emit invariants, money/tax rules, who-may-do-what (authz), legal state transitions, and the named business flows to trace. " +
    "Set oracleQuality honestly: 'strong' if real specs/tests exist, 'weak' if you only inferred from schemas/types, 'none' if there is no oracle (say so rather than guessing).",
    { schema: BaselineSchema, cwd: process.cwd(), sandbox: "read-only", nodeKey: "audit:baseline" },
  ));
  const should = agentOutput(baseline, "intent");
  log("intent baseline", { oracleQuality: should?.oracleQuality ?? "none", flows: should?.flows ?? [] });

  // ---- Phase 2: multi-lens fan-out (parallel), each compares code to the baseline ----
  const lensResults = await phase("lenses", async () => parallel(LENSES.map((lens) => async () => {
    return agent(
      `Audit "${target}" through the "${lens}" lens.\n` +
      `Compare the ACTUAL code to these intended rules:\n${JSON.stringify(should)}\n` +
      "Find places where the code RUNS FINE but VIOLATES business intent (not crashes/null-derefs). " +
      "For each defect cite file:line for BOTH the violated rule and the violating code, and a concrete trigger condition. " +
      `Set lens="${lens}". If nothing real, return an empty defects array.`,
      { schema: LensFindingSchema, cwd: process.cwd(), sandbox: "read-only", nodeKey: `audit:lens:${lens}` },
    );
  })));
  const lensOutputs = lensResults.map((r: any, idx: number) => agentOutput(r, `lens ${LENSES[idx]}`));
  const lensDefects = lensOutputs
    .flatMap((l: any) => (l?.defects ?? []).map((d: any) => ({ source: "lens", lens: l?.lens, ...d })));
  log("lens defects", { count: lensDefects.length });

  // ---- Phase 3: cross-artifact contradiction hunt ----
  const contradictions = await phase("contradictions", async () => agent(
    "Hunt CONTRADICTIONS across artifacts for the audited area.\n" +
    `Intended rules:\n${JSON.stringify(should)}\nLens defects so far:\n${JSON.stringify(lensDefects)}\n` +
    "Find where spec says X, a test asserts Y, the code does Z, and the schema/DB allows W and these disagree. " +
    "Also list intended rules that have NO enforcing code. Cite locations.",
    { schema: ContradictionSchema, cwd: process.cwd(), sandbox: "read-only", nodeKey: "audit:contradictions" },
  ));
  const contradictionOutput = agentOutput(contradictions, "contradictions");
  const contradictionDefects = (contradictionOutput?.contradictions ?? []).map((c: any) => ({
    source: "contradiction",
    title: c?.conflict,
    location: c?.location,
    why: c?.artifacts,
  }));

  // ---- Phase 4: end-to-end flow trace (pipeline over named flows) ----
  const flows = (should?.flows ?? []).slice(0, 4);
  const flowTraces = await phase("flows", async () => pipeline(flows, async (flow: string) => {
    const r = await agent(
      `Trace the business flow "${flow}" END-TO-END across files (entry -> authz check -> validation -> state change -> persistence -> response). ` +
      "Find steps that are skippable, reorderable, or replayable, or that are missing a guard — defects invisible when reading one file at a time. " +
      `Set flow="${flow}".`,
      { schema: FlowTraceSchema, cwd: process.cwd(), sandbox: "read-only", nodeKey: `audit:flow:${flow}` },
    );
    return agentOutput(r, `flow ${flow}`);
  }));
  const flowOutputs = flowTraces.map((f: any, idx: number) => requiredValue(f, `flow ${flows[idx]}`));
  const flowDefects = flowOutputs
    .flatMap((f: any) => (f?.weaknesses ?? []).map((w: any) => ({ source: "flow", flow: f?.flow, title: w?.problem, location: w?.step, kind: w?.kind })));

  // ---- Phase 5: adversarial verify + impact rank ----
  const candidates = [...lensDefects, ...contradictionDefects, ...flowDefects];
  const verdict = await phase("verify", async () => agent(
    "You are an ADVERSARIAL verifier. For EACH candidate business defect below, TRY TO REFUTE it: " +
    "find the guard/test/code path that already prevents it, or demand a concrete reproduction/trigger. " +
    "Move refuted ones to 'dismissed' with a reason (never silently drop). " +
    "Rank survivors by BUSINESS IMPACT (money loss / data exposure / privilege escalation / corruption) with a severity and a concrete maintainer action. Do NOT trust self-reported confidence.\n\n" +
    `CANDIDATES:\n${JSON.stringify(candidates)}\n\nINTENDED RULES:\n${JSON.stringify(should)}`,
    { schema: VerdictSchema, cwd: process.cwd(), sandbox: "read-only", nodeKey: "audit:verify" },
  ));
  const verdictOutput = agentOutput(verdict, "verify");

  return {
    target,
    oracleQuality: should?.oracleQuality ?? "none",
    candidatesConsidered: candidates.length,
    verified: verdictOutput?.verified ?? [],
    dismissed: verdictOutput?.dismissed ?? [],
    unenforcedRules: contradictionOutput?.unenforcedRules ?? [],
  };
}
