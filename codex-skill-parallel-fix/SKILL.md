---
name: parallel-fix
description: Use to FIX or implement a LIST of mostly-independent changes faster by doing them concurrently instead of one-at-a-time. Triggers on "并行修复 / 并行修这份清单 / 批量修复 / 把审计结果(清单)修了 / 并行开发 / 一起改", and "parallel fix / fix this audit list in parallel / apply these findings / batch-fix / implement these tasks concurrently". Best right after a business-defect-audit or any review that produced a findings list. NOT for a single change (just do it directly), and NOT a license to blindly parallelize tightly-coupled work — high-risk concurrency/resume/budget/determinism fixes are flagged for careful single-fix TDD instead.
metadata:
  short-description: Parallel-apply a list of fixes (propose concurrently, integrate once)
---

# Parallel Fix

Speed up the **fix/implement** half of the loop. A normal agent fixes a list serially (explore → fix → test → commit, repeat) — slow. This skill generates every fix **concurrently**, then integrates + verifies **once**.

**Engine / backend / sandbox / journal mechanics: reuse the `dynamic-workflow` skill.** This skill carries only the method.

## The key idea (and its honest limit)

The slow, parallelizable part is **"analyze each finding + write the correct patch"** — independent per finding. So fixers run **in parallel but READ-ONLY**, each returning a unified **diff** (not editing the tree — parallel writers to one repo race and the engine will reject them). A **single serial step** then applies the diffs, resolves conflicts, and runs the full suite once.

Honest limits — say these to the user, don't hide them:
- **Integration + verify is serial** (one suite run on the merged result) — that's the bottleneck you can't parallelize away.
- **Overlapping fixes** (same file/lines) can't be blindly merged — the apply step puts conflicts in a `conflicted` list for manual handling.
- Parallel fixers **don't see each other**, so a fix may assume code another changed — the single full-suite verify catches breakage; a reconciliation pass may be needed.
- Realistic speedup ≈ **2–4×** (more independent findings → more speedup), NOT N×.

## Steps

Generate `.codex-flow/generated/<slug>.fix.workflow.ts` from `references/fix-template.workflow.ts` (import-free, plain JSON Schema), set `FINDINGS` to the real list (from the audit / the user), then `codex-flow run` it. The phases:

1. **Propose (`parallel`, `sandbox: "read-only"`)** — one agent per finding. Each reads the code and returns the **smallest correct unified diff** + a `risk` rating. Read-only ⇒ safe to share one `cwd`. **Route `risk: "high"` items (concurrency / resume / budget / determinism) out of the blind-parallel path** — recommend the user fix those with single careful TDD (a reproducing test first), because that's where parallel-blind fixes regress.
2. **Apply + verify (`phase`, single agent, `sandbox: "workspace-write"`, `cwd: process.cwd()`)** — apply the diffs in a conflict-minimizing order; record un-mergeable ones under `conflicted`; run the project's **full test + typecheck once**; report `testPassed` honestly.

## Rules

- Fixers are **read-only and only propose diffs** — they never edit files in parallel.
- Exactly **one** writable apply step, run alone (no concurrent writer on the same `cwd`).
- **Never claim a fix landed without the suite passing.** Report `applied` / `conflicted` / `skipped` and `testPassed` truthfully.
- High-risk fixes → recommend single-fix TDD, don't fold them into the blind batch.
- Summarize for the user: what landed, what conflicts need manual work, whether tests pass, and the journal path.

Full method (grouping, diff format, conflict handling, when to fall back to serial): `references/fix-method.md`.
