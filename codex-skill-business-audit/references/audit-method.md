# Business-defect audit method (reference)

The deep half of finding defects: **build a "should", then find where the code's "does" disagrees.** Crashes are not the target — *correct-looking code that violates intent* is.

## Phase 1 — the "should" baseline: what to read

In priority order (stop describing what isn't there; flag `oracleQuality`):

- **Tests** — assertions ARE encoded intent (`expect(total).toBe(...)`, fixtures, golden files).
- **Specs / RFCs / PRDs / ADRs / issue + PR descriptions** — stated rules and "why".
- **Data model**: DB schema, migrations, constraints, enums, unique/foreign keys, default values, nullability — these encode invariants (e.g. `balance >= 0`, a status enum = a state machine).
- **Types / interfaces / API contracts / OpenAPI** — shape + who-calls-what.
- **Config / feature flags / permission tables / role definitions** — authz intent.
- **Comments & naming** — weakest oracle; use only to corroborate.

Emit: invariants, money/tax rules, authz rules (who may do what, on whose data), legal state transitions, and the **named business flows** to trace in Phase 4. Set `oracleQuality`: `strong` (real specs/tests), `weak` (only inferred from schema/types), `none` (no oracle — findings are low-confidence).

## Phase 2 — the lens catalog (one agent per lens, given the baseline)

Each lens looks for *code that runs fine but violates intent*, with file:line for the rule and the code, plus a trigger.

- **Money / amount / tax / rounding / refunds**: tax applied to the wrong base; discount stacking; rounding direction/precision (banker's vs half-up); currency/unit mismatch; refund > original; negative/zero quantities; proration; double-charging; off-by-one on inclusive ranges; signed-amount confusion.
- **Authorization / privilege / tenant isolation**: missing ownership check (horizontal: acting on another user's/tenant's record); role check missing or wrong (vertical); IDOR (object id taken from request, not session); admin-only path reachable; permission checked on the wrong object; "can read" used where "can write" is needed.
- **State-machine & lifecycle**: illegal transition allowed (e.g. ship a cancelled order; refund an unpaid one); missing guard before a transition; double-submit / re-entrancy; terminal state mutated; status set without the side effect (or vice-versa); time-based transitions that skip steps.
- **Concurrency / idempotency / double-spend**: check-then-act (TOCTOU) without a lock/atomic op; non-idempotent endpoint that retries (double charge); race on balance/inventory/counter; missing unique constraint letting duplicates through; webhook/callback replay; lost update.
- **Boundary / hostile input & trust**: trusting client-supplied price/total/role/userId; mass-assignment (binding the whole request body to a model); missing validation that a business rule depends on; injection where input reaches a query/command; empty/huge/negative inputs; trusting an external service's response without checks.

## Phase 3 — cross-artifact contradiction matrix

Look for disagreement between any two of: **spec**, **test**, **code**, **schema/DB**. Examples: schema allows NULL but code assumes present; test asserts behavior the code doesn't implement; spec says "admins only" but code checks `isLoggedIn`; an enum has a value no code handles. Also list **intended rules with no enforcing code anywhere** (the rule exists only in prose).

## Phase 4 — end-to-end flow trace

For each named flow, follow it across files: `entry → authn → authz → validation → business rule → state change → persistence → external calls → response`. At each step ask: can it be **skipped** (call a later endpoint directly)? **reordered**? **replayed** (retry/duplicate)? is a **guard missing**? Per-file reading cannot see these; the trace can.

## Phase 5 — adversarial verify + impact rank

For each candidate: **try to refute it** — is there a guard, constraint, middleware, or test that already prevents it? Can you state a concrete trigger/repro? If you cannot make it real, move it to `dismissed` **with the reason** (keep it visible). Rank survivors by **business impact**: `critical` (direct money loss / data breach / privilege escalation / data corruption) > `high` > `medium` > `low`. Each survivor: severity, impact type, trigger condition, file:line, and a concrete maintainer action. Never rank by the finder's self-reported confidence.
