# Parallel-fix method (reference)

Turn a findings list into landed fixes faster by parallelizing the analysis/patch-writing and serializing only the integration.

## 1. Triage the list first

Before fanning out, split the findings:
- **Independent** (different files/subsystems, no shared lines) → the parallel batch.
- **Overlapping** (same file/region, or one depends on another's change) → either chain them in a `pipeline`, or fix serially.
- **High-risk** = concurrency / races / semaphore, resume / cacheKey / journal, budget accounting, determinism. **Do NOT blind-parallel these.** Recommend the user fix each with single TDD (write a reproducing test → minimal fix → verify). Parallel-blind fixes regress exactly here, because the failure mode is timing/ordering, not a local edit.

## 2. Propose phase (parallel, read-only)

One agent per finding, `sandbox: "read-only"`, `cwd: process.cwd()`. Each:
- reads only what it needs,
- returns the **smallest correct unified diff** (`diff`), the touched `files`, a `rationale`, and a `risk`.
- does NOT edit the tree — read-only fixers can safely share one `cwd` (the engine only guards *writable* concurrent cwds).

Keep diffs minimal and localized — small patches conflict less at apply time.

## 3. Apply + verify phase (serial, one writable agent)

A single agent, `sandbox: "workspace-write"`, `cwd: process.cwd()`:
- applies diffs in a conflict-minimizing order (independent files first),
- on a real conflict (same lines), applies the safer patch and records the other id under `conflicted` — **never force a merge**,
- runs the project's **full test suite + typecheck once**,
- reports `applied` / `conflicted` / `skipped` and `testPassed` honestly, with the command used in `notes`.

This step is the serial bottleneck by design: you can't make "all tests green together" parallel.

## 4. If you need true parallel editing (per-fix tests in parallel)

The default (read-only propose → serial apply) covers most cases. If a batch is large and you want each fix to also *run its own tests* in parallel, give each fixer a **disjoint git worktree** as its `cwd` (`git worktree add` per fix → distinct path satisfies the engine's writable-cwd guard → `sandbox: "workspace-write"` there), then cherry-pick/merge the worktree branches back and run the full suite once. Heavier (worktree setup + merge conflicts); only worth it when per-fix test time dominates.

## 5. Always report honestly

- A fix is "done" only when it's applied AND the suite passes. Anything else is `conflicted`/`skipped` with a reason.
- Surface high-risk items you deliberately kept out of the batch, so the user fixes them carefully.
- Give the journal path so the run is resumable/auditable.
