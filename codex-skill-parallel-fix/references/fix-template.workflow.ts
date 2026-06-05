// Parallel fix — speed up the SLOW half of an audit→fix loop by generating every fix
// concurrently (read-only diff generation), then applying + verifying ONCE, serially.
//
// Why this shape: the bottleneck is "analyze the finding + write the correct patch", which is
// independent per finding and parallelizes cleanly. Editing the real tree is NOT parallel-safe
// (two writers race), so the fixers stay read-only and only PROPOSE diffs; a single apply step
// integrates them and runs the suite. Import-free + null-safe so it also runs under the fake backend.

const FixSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "files", "diff", "rationale", "risk"],
  properties: {
    id: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    diff: { type: "string" }, // a unified diff; the fixer does NOT edit files, only proposes
    rationale: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
  },
};

const ApplySchema = {
  type: "object",
  additionalProperties: false,
  required: ["applied", "conflicted", "skipped", "testPassed", "notes"],
  properties: {
    applied: { type: "array", items: { type: "string" } }, // finding ids that landed
    conflicted: { type: "array", items: { type: "string" } }, // ids that need manual reconciliation
    skipped: { type: "array", items: { type: "string" } },
    testPassed: { type: "boolean" },
    notes: { type: "string" },
  },
};

// The skill replaces this with the real audit finding list. Each item is one independent fix.
const FINDINGS = [
  { id: "F1", title: "example finding 1", location: "src/foo.ts:10", fix: "describe the intended fix" },
  { id: "F2", title: "example finding 2", location: "src/bar.ts:42", fix: "describe the intended fix" },
];

export default async function workflow(ctx: any) {
  const { agent, parallel, phase, log, budget } = ctx;
  budget.configure({ maxTokens: 800_000, maxNodes: 80, onExceeded: "skip" });

  // ---- Phase 1: PARALLEL, READ-ONLY — one agent per finding proposes a diff (the slow part) ----
  // Read-only means many fixers can share the same cwd safely (no write race).
  const proposals = await phase("propose", async () => parallel(FINDINGS.map((f) => async () => {
    const r = await agent(
      "Produce the SMALLEST correct fix for this finding as a unified diff. " +
      "Read the relevant files to get it right, but DO NOT edit anything — return the diff only. " +
      "If the fix is high-risk (concurrency, resume/journal, budget, determinism), say so in `risk` and keep the diff minimal.\n" +
      `FINDING: ${JSON.stringify(f)}`,
      { schema: FixSchema, cwd: process.cwd(), sandbox: "read-only", nodeKey: `fix:${f.id}` },
    );
    return r?.status === "ok" ? r.output : null;
  })));
  const diffs = proposals.filter(Boolean);
  log("proposed fixes", { proposed: diffs.length, of: FINDINGS.length });

  // ---- Phase 2: SERIAL, WORKSPACE-WRITE — integrate all diffs + verify ONCE ----
  // Runs alone (after the parallel phase), so there is no concurrent writer on this cwd.
  const apply = await phase("apply-and-verify", async () => agent(
    "Apply these proposed fixes to the working tree in an order that minimizes conflicts. " +
    "If two patches touch the same lines, apply the safe one and record the other id under `conflicted` for manual review — never force a risky merge. " +
    "Then run the project's full test suite + typecheck and report testPassed honestly with the command in `notes`.\n" +
    `FIXES:\n${JSON.stringify(diffs)}`,
    { schema: ApplySchema, cwd: process.cwd(), sandbox: "workspace-write", nodeKey: "fix:apply" },
  ));
  const applied = apply?.status === "ok" ? apply.output : null;

  return {
    findings: FINDINGS.length,
    proposed: diffs.length,
    applied: applied?.applied ?? [],
    conflicted: applied?.conflicted ?? [],
    skipped: applied?.skipped ?? [],
    testPassed: applied?.testPassed ?? null,
    notes: applied?.notes ?? (diffs.length === 0 ? "no fixes proposed (sub-agents unavailable)" : "apply step did not complete"),
  };
}
