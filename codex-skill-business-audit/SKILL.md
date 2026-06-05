---
name: business-defect-audit
description: Use for a deep BUSINESS-LOGIC / INTENT audit — finding defects where the code runs fine, compiles, and may even pass tests, but VIOLATES business intent. Triggers on "业务审计 / 业务缺陷审计 / 审计这个功能 / 深度审计 / 逻辑漏洞 / 越权 / 并发双花 / 状态机缺陷 / 金额(税费)算错", and "business audit / logic audit / audit this feature or codebase / find logic (not crash) bugs / privilege escalation / authorization gap / state-machine defect / money or tax miscalculation / double-spend / idempotency". This is NOT for crashes, null-derefs, or generic "find bugs in file X" — for those use the dynamic-workflow skill. This skill runs an opinionated 5-phase audit (reconstruct intent → multi-lens fan-out → cross-artifact contradictions → end-to-end flow trace → adversarial verify + impact rank) via the codex-flow engine.
metadata:
  short-description: Deep business-logic / intent defect audit
---

# Business-Defect Audit

You are running a deep audit for defects where **the code works but does the wrong thing** relative to business intent — wrong money/tax, missing authz, illegal state transitions, double-spend, trust violations. These are invisible to a normal "find bugs" pass because nothing crashes.

**Engine, backend, sandbox, journal, and run mechanics: reuse the `dynamic-workflow` skill** (it documents `ctx.agent/parallel/pipeline/phase/log`, the codex-sdk membership backend, `sandbox: "read-only"`, `cwd: process.cwd()`, JSON-Schema strict rules, and `codex-flow run … → resume`). This skill carries only the *method*.

## The core idea

A business defect lives in the **gap between "what the code should do" and "what it does."** So you must build a "should" first, then compare — never just read code looking for problems.

## The 5-phase method (generate a workflow that does ALL of these)

Generate `.codex-flow/generated/<slug>.audit.workflow.ts` from the template in `references/audit-template.workflow.ts` (import-free, plain JSON Schema, all agents `sandbox: "read-only"`, `cwd: process.cwd()`), then `codex-flow run` it. Set `target` to the feature/area the user named. The phases:

1. **Reconstruct intent (`phase("intent")`)** — one agent reads specs, docs, **tests (their assertions are intent)**, data models, DB schemas, migrations, and types to emit a structured "should": invariants, money/tax rules, authz rules, legal state transitions, and the named business flows. It must report `oracleQuality` honestly (`strong`/`weak`/`none`) — if there is no oracle, say so, don't silently slide into a scan.
2. **Multi-lens fan-out (`parallel`)** — one agent per **business-defect lens** (NOT per file): money/tax/rounding/refunds; authz/privilege/tenant-isolation; state-machine & lifecycle; concurrency/idempotency/double-spend; boundary/hostile-input/trust. Each gets the Phase-1 baseline and finds where code **runs fine but violates intent**, citing file:line for both the rule and the violating code + a concrete trigger. See the full lens catalog in `references/audit-method.md`.
3. **Cross-artifact contradictions (`phase`)** — one agent hunts disagreements: spec says X, a test asserts Y, code does Z, schema/DB allows W. Also flags intended rules with **no enforcing code**.
4. **End-to-end flow trace (`pipeline` over the named flows)** — trace each business journey across files (entry → authz → validation → state change → persistence → response) to find steps that are skippable, reorderable, replayable, or missing a guard. These are invisible when reading one file at a time.
5. **Adversarial verify + impact rank (`phase`)** — one verifier tries to **refute** each candidate (find the guard/test that prevents it; demand a concrete trigger), moves refuted ones to a `dismissed` list **with reasons** (never silently drop), and ranks survivors by **business impact** (money loss / data exposure / privilege escalation / corruption) with severity + a maintainer action. Do **not** trust self-reported confidence.

## Rules

- **Read-only.** Every audit agent uses `sandbox: "read-only"` + `cwd: process.cwd()`. An audit never edits files.
- **No oracle = say so.** If Phase 1 finds no specs/tests/schemas, report `oracleQuality: "none"` and that findings are low-confidence — do not pretend a scan is an audit.
- **Cost-aware.** Audits run ~10+ sub-agents. The template sets `budget.configure(...)` and caps lenses/flows. Keep it.
- **Summarize for the user**: the ranked verified defects (impact + trigger + location + next action), what was dismissed and why, the oracle quality, and the journal path. Don't paste the whole script.

Full lens catalog, the "should"-baseline checklist, the contradiction matrix, and the impact rubric: `references/audit-method.md`.
