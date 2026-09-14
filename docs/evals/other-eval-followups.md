# Other eval follow-ups — 2026-09-14

Open follow-ups from the expanded audit of main `f65f36ebd6ff14df4d282dcf13dab8312aeba941`. These are outstanding work, not completed repairs. See [the cross-eval assessment](cross-eval-regression-2026-09-14.md) and [self-reproduction handoff](self-reproduction-handoff.md) for the related evidence and boundaries.

## Evidence and regression baseline

The normal `mise run test:agent` passed all 14 scenarios / 168 gates, plus 11 product unit tests and two browser cases. An additional explicit-name run exercised 26 scenarios: 14 passed and 12 failed (302 passing gates, 28 failing gates). Thus 40 deterministic scenarios ran: **28 passed, 12 failed**. Missing infrastructure and unexecuted cases do not count as passing.

The same 26 additional scenarios on pre-repair `04dbe04823b95c975d5483b635c8d8ed44010908` produced seven passes and 19 failures. Seven scenarios improved and no passing scenario became failing. All 12 current failures also failed before, sometimes at an earlier boundary. This comparison does not establish preservation of deeper behavior that neither run reached.

[Main CI run 34839386059](https://github.com/withAutograph/autograph-app-builder/actions/runs/34839386059) passed. The broader audit is recorded in [PR #442](https://github.com/withAutograph/autograph-app-builder/pull/442). Green CI covers its selected lanes, not every checked-in scenario.

Local evidence is `/private/tmp/other-evals-20260914/{index.html,assessment.md,assessment.json,comparison.json}`. Raw logs: `/private/tmp/eval-other-main-agent-20260914.log`, `/private/tmp/eval-other-extra-main-20260914.log`, and `/private/tmp/eval-other-toolchain-20260914.log`. Before-repair results combine `/private/tmp/eval-other-extra-before-20260914.log`, `/private/tmp/eval-extra-before-failed-target-validation.log`, and `/private/tmp/eval-extra-before-remaining-20260914.log`. The initial interrupted case is not counted as failed; its completed rerun supplies the terminal result. These machine-local paths may disappear; this document preserves the findings and reproduction scope without credentials or private preview authority.

## Open work

### EVAL-01 — Branch publication rejects unchanged reviewed source

**Priority P1; failed; shared repository workflow; confirmed cause.** Each scenario reached 4/5 gates:

- `branch-worktree-publication`
- `branch-worktree-publication-lost-response`
- `branch-worktree-publication-negative`
- `branch-worktree-publication-recovery`
- `branch-worktree-publication-stale`
- `pre-journal-branch-worktree-publication`

`branch_worktree_publication_status` rejects the source/review identity before the intended publication approval. In [node-branch-worktree-publication.ts](../../lib/repository/node-branch-worktree-publication.ts), both snapshot calculations use the eight `SUPPORTED_REPOSITORY_CONTRACT.requiredPaths`; [source-receipt.ts](../../lib/repository/source-receipt.ts) defaults to twelve `SUPPORTED_TEMPLATE_INPUT_PATHS`. The resulting contract digests differ for an unchanged checkout and [branch-worktree-publication.ts](../../lib/repository/branch-worktree-publication.ts) rejects them.

**Next action:** align producer and consumer contract inputs using the existing shared contract. Preserve credential isolation, approval, and actual mutation checks; do not add new speculative source/version gates or weaken assertions to accept arbitrary digests.

**Close when:** a genuine source receipt and unchanged checkout pass the branch boundary; changed approved inputs still fail the existing relevant checks; all six scenarios reach and verify their intended approval, cancellation, stale-state, lost-response, and recovery outcomes through simulated external effects.

### EVAL-02 — Completed changes cannot be reviewed

**Priority P1; failed; layer unconfirmed.** `accept-app-spec` passes 106/108 gates. Its review step lacks the expected `change_set_status` call and reports that completed changes cannot be prepared for review. See [accept-app-spec.eval.ts](../../evals/accept-app-spec.eval.ts).

**Next action:** inspect the scoped review-turn events and [agent/agent.ts](../../agent/agent.ts) mock routing. Cumulative tool-result reuse is a hypothesis, not a confirmed cause. The malformed publication proposal later in the log is an intentional stale-review negative probe; it is not evidence of this failure's cause.

**Close when:** review uses the current workflow state, calls the expected status tool, exposes the current completed changes, and the entire scenario passes while retaining its negative assertions.

### EVAL-03 — Apply/validation cases leave ordinary approvals unanswered

**Priority P1; failed harness; intended product behavior unassessed.** The unmodified scenarios park on apply approval and later time out:

- `failed-target-validation`: 4/8 gates.
- `interrupted-target-validation`: 4/8 gates.
- `partial-target-apply`: 2/7 gates.

**Next action:** update the scenario drivers to answer the normal apply approval before proceeding. Scope no-approval assertions to operations that are actually approval-free. Keep these internal contract scenarios distinct from the public-entrypoint dogfooding benchmark.

**Close when:** tests reach the injected validation failure, interruption, or partial apply; verify the intended state and recovery effects; and preserve separate approval for consequential actions. Removing timeouts or merely changing expected final prose is insufficient.

### EVAL-04 — Design-guidance preview cannot execute in the eval runtime

**Priority P1; infrastructure blocked; runner failed 11/17 gates.** `record_ui_preview` reports `bash: bun: command not found` in the `just-bash` profile, and downstream preview/recovery expectations fail. See [design-guidance.eval.ts](../../evals/design-guidance.eval.ts). This does not establish a live generated-product regression.

**Next action:** determine the supported execution contract for this scenario and ensure the shared runtime/profile supplies it. Do not introduce eval-specific hosting, fake preview success, offline package enforcement, or manually repaired candidate output.

**Close when:** the recorded preview executes in the supported environment and the existing design/recovery assertions pass. Also make the case's selection explicit: `test:general-evals` names it but excludes its `product-quality` tag, so that task does not currently execute it.

### EVAL-05 — Dependency preparation asserts obsolete wording

**Priority P2; failed harness; 9/10 gates.** `cancel-dependency-preparation` expects “already available” while the actual reply says “already recorded for planning.” See [cancel-dependency-preparation.eval.ts](../../evals/cancel-dependency-preparation.eval.ts).

**Next action:** establish the intended product behavior and assert that behavior or the current product-facing contract, rather than an incidental sentence.

**Close when:** dependency preparation and approval/mutation boundaries are verified and the scenario passes without suppressing unrelated assertions.

### EVAL-06 — Standalone toolchain eval lacks managed OIDC context

**Priority P1; blocked; no successful toolchain proof.** `mise run test:sandbox-toolchain` was attempted. Vercel Sandbox lookup failed because the entrypoint did not have an available project OIDC context; the runner emitted 3/9 passing gates and a failed result. This differs from CI's passing backend unit-contract lane.

**Next action:** inspect the supported entrypoint and existing managed project-OIDC lifecycle. Reuse shared setup and credential boundaries; do not add static provider keys, new eval hosting, or count an infrastructure probe as generated-app proof.

**Close when:** the existing entrypoint obtains project-scoped credentials through supported setup and completes an actual toolchain inspection, with its configured/unconfigured coverage stated honestly.

### EVAL-07 — Three image/source proof cases remain unassessed

**Priority P2; unassessed; no execution attempted.** Required legacy image/source inputs were unavailable for:

- `sandbox-identity-planning`
- `sandbox-reviewed-change-set`
- `sandbox-existing-iteration`

**Next action:** determine which assertions still apply to the current Vercel/shared workflow and migrate them to its supported entrypoints where needed. Do not resurrect retired execution infrastructure solely to make old tests green. Record any retired assertions and their replacements explicitly.

**Close when:** still-supported identity/planning, apply/review, and existing-app iteration outcomes have executable evidence, with unavailable or retired coverage explicitly distinguished. No configured flag or existing fixture alone earns hosted execution credit.

## Integration and closure rules

Fix shared workflow defects in the shared implementation and fixture/driver defects in the harness. Do not manually patch generated apps or feed evaluator findings into a live generation. Retain passed/failed/blocked/unassessed distinctions and separate mock-model contract evidence from live product proof.

After a focused repair, rerun its affected scenarios, then the supported `mise run test:agent` and all required exact-head CI lanes before merging. Expand routine CI only once repaired scenarios execute reliably within their intended deterministic scope; do not hide failures by deleting cases, weakening assertions, or presenting the 45-file inventory as passing coverage.

The seven improved cases to preserve are `failed-journal-recovery`, `interrupted-local-publication`, `local-publication-overlap`, `pre-journal-local-publication`, `precondition-failed-publication`, `published-local-workflow-boundary`, and `succeeded-journal-recovery`. The retired internal `self-reproduction.eval.ts` was excluded; the supported public-driver self-reproduction benchmark and its outstanding product gaps remain separate.
