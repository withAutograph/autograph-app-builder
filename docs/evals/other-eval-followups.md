# Other eval follow-ups — 2026-09-14

Follow-ups from the expanded audit of main `f65f36ebd6ff14df4d282dcf13dab8312aeba941`. The audit below is the frozen starting point; the repair ledger records subsequent work and its evidence. See [the cross-eval assessment](cross-eval-regression-2026-09-14.md) and [self-reproduction handoff](self-reproduction-handoff.md) for the related evidence and boundaries.

## Evidence and regression baseline

The normal `mise run test:agent` passed all 14 scenarios / 168 gates, plus 11 product unit tests and two browser cases. An additional explicit-name run exercised 26 scenarios: 14 passed and 12 failed (302 passing gates, 28 failing gates). Thus 40 deterministic scenarios ran: **28 passed, 12 failed**. Missing infrastructure and unexecuted cases do not count as passing.

The same 26 additional scenarios on pre-repair `04dbe04823b95c975d5483b635c8d8ed44010908` produced seven passes and 19 failures. Seven scenarios improved and no passing scenario became failing. All 12 current failures also failed before, sometimes at an earlier boundary. This comparison does not establish preservation of deeper behavior that neither run reached.

[Main CI run 34839386059](https://github.com/withAutograph/autograph-app-builder/actions/runs/34839386059) passed. The broader audit is recorded in [PR #442](https://github.com/withAutograph/autograph-app-builder/pull/442). Green CI covers its selected lanes, not every checked-in scenario.

Local evidence is `/private/tmp/other-evals-20260914/{index.html,assessment.md,assessment.json,comparison.json}`. Raw logs: `/private/tmp/eval-other-main-agent-20260914.log`, `/private/tmp/eval-other-extra-main-20260914.log`, and `/private/tmp/eval-other-toolchain-20260914.log`. Before-repair results combine `/private/tmp/eval-other-extra-before-20260914.log`, `/private/tmp/eval-extra-before-failed-target-validation.log`, and `/private/tmp/eval-extra-before-remaining-20260914.log`. The initial interrupted case is not counted as failed; its completed rerun supplies the terminal result. These machine-local paths may disappear; this document preserves the findings and reproduction scope without credentials or private preview authority.

## Frozen findings from the audit

These statuses describe the starting audit. Current repairs and closure evidence are recorded in the repair ledger below.

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

## Repair ledger — cross-eval milestone

The deterministic repair is based on main `84ae04988cb7d70e352fe674ce6c7205f0abd660`.

| Group                     | Repair                                                                                                                                                           | Evidence and remaining gate                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EVAL-01                   | `e14983b1`: both snapshots use the actual shared `sourceIdentityDigest(headSha, headTree)` producer; canonical tool names restored in six scenarios.             | Genuine Git/source-receipt agreement and changed-HEAD rejection regression passed. Six branch scenarios passed all 68 gates in completed focused runs. Integrated acceptance and exact-head CI are recorded below.                                                         |
| EVAL-02                   | `7847175f`: mock review results are scoped after current validation; obsolete `expectedValidationDigest` is removed from the strict `change_set_status` request. | Mock-history regressions pass; integrated `accept-app-spec` passes 108/108, including intentional stale-proposal negatives. Production review routing is unchanged.                                                                                                        |
| EVAL-03                   | `7847175f`, `acd951e2`, `5d5450d5`: answer ordinary apply approvals, scope subsequent approval assertions, and inject an actual fixture command timeout.         | Failure, interruption and partial-apply cases reach their actual states. The timeout case records `validation_failed` / `command-timeout` and recovery required; this proves honest failure and explicit retry behavior, not successful recovery from a timed-out command. |
| EVAL-05                   | `7847175f`, `acd951e2`: explicit dependency-state assertions.                                                                                                    | Verify a recorded dependency digest, unchanged workflow state, no extra approval, and no apply/planning mutation. Incidental response wording is not the acceptance criterion.                                                                                             |
| EVAL-04, EVAL-06, EVAL-07 | Separate Sandbox/coverage PR.                                                                                                                                    | Remain open until real Sandbox execution, design browser interaction, and all five supported integration scenarios pass.                                                                                                                                                   |

The original EVAL-01 eight-versus-twelve-path diagnosis was incomplete. Inspection of the actual V3 receipt producer showed that it uses the source SHA/tree identity, so the repair shares that producer rather than introducing another file-list digest.

`evals/scenario-inventory.json` is the checked-in selection authority: 39 deterministic scenarios, five real-Sandbox scenarios, and one retired internal diagnostic. `test:general-evals`, `test:fresh-bootstrap-evals`, and `test:product-evals` select their cases from it with no tag exclusions. The existing required CI lanes therefore exercise the repaired deterministic cases. Real provider execution stays opt-in.

Do not interpret this integration milestone as autonomous self-reproduction. The model is mocked in these contract cases; only the Sandbox execution is real in the separately identified integration group. A new live public-entrypoint self-reproduction run remains the next milestone.

### Deterministic acceptance

`mise run test:agent` on `45fca4b40` passed all **39 scenarios / 547 gates**, plus 11 product unit checks and two browser fixtures. All 28 formerly passing cases and all seven improvements remain passing. The subsequent explicit-state follow-up passed dependency preparation; its first interruption assertion incorrectly counted the entire run. The corrected turn-scoped interruption case passed **23/23 gates**, and the event trace proves one dispatch before the explicit user retry and one afterward. The initial failed assertion is retained as harness evidence, not a product regression.

The integrated TypeScript check and five focused source-contract, mock-review, and inventory tests passed. Local artifacts: `/private/tmp/cross-eval-milestone-20260914/`, `/private/tmp/cross-eval-deterministic-acceptance.log`, `/private/tmp/cross-eval-state-assertions.log`, and `/private/tmp/cross-eval-interruption-scope.log`. Earlier concurrent branch attempts and externally interrupted processes remain recorded in `/private/tmp/cross-eval-branch-contract*.log`; a sequential integrated run passed every branch scenario. [PR #444](https://github.com/withAutograph/autograph-app-builder/pull/444) merged as `e68b28f7f965bc1d4353d82aa965af042b1023c4` after [exact-head CI](https://github.com/withAutograph/autograph-app-builder/actions/runs/34867595052) passed at `81098aaccaf439ed44e706cb309b62b24d1fab0c`. Post-merge auth CI initially failed one session readback; its retry and the stronger same-user/workspace polling regression are tracked in [PR #446](https://github.com/withAutograph/autograph-app-builder/pull/446). These deterministic results do not establish real-Sandbox or self-reproduction success.

### Sandbox repair and acceptance

[PR #446](https://github.com/withAutograph/autograph-app-builder/pull/446) supplies the remaining integration repairs and reporting. The five supported cases use the mock model with actual Vercel Sandbox execution, the existing project-scoped Development OIDC lifecycle, and the unchanged Arrusted checkout `f992cee2f301c57fe3289a26f26e36b15b683d2f`. They perform no external publication.

| Group   | Repair                                                                                                                                                                                                                                                                              | Closure evidence                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EVAL-04 | `542dfbca`, `26fea68f`, `b22f7132`: shared development setup, managed browser executable forwarding, and the current Arrusted `PageTabs` API in the checked-in mock fixture.                                                                                                        | `design-guidance`: **17/17 gates passed**. The real Sandbox compiler produced the HTML; local Playwright observed the All renewals action reveal Mercury Labs, with no browser errors.                                 |
| EVAL-06 | `34dfd6d9`, `542dfbca`, `1e7288a7`, `0a44d530`: managed OIDC for both real profiles, executable forwarding across the trusted launcher, and preserved hosted-artifact source-reader mode.                                                                                           | `sandbox-toolchain`: **10/10 gates passed**, with actual successful bash, git, mise, Bun, and Node commands. Legacy image/cache diagnostics and absent pnpm do not earn readiness credit.                              |
| EVAL-07 | `a1a8a46c`, `6cb0e3e9`, `34d5a248`, `911aae92`, `677ccba9`, `1b10dbb4`, `3b3fb144`: persisted workflow assertions, ordinary apply approval, user-request-bound source inspection, dependency installation for existing-app apply, and immediate failure on unsuccessful validation. | Identity/planning **23/23** and reviewed changes **38/38** passed. Existing iteration failed **14/16** on clean `3d23a6835`; direct diagnostic confirms missing CUE. Shared installation repair is pending acceptance. |

The source selection and edit helper are mock fixtures. They do not add product API or MCP behavior. The existing-app case must bind the requested tax-verification text to the reviewed app-owned source digest, in addition to successful apply, validation, and review receipts. No retained candidate output was repaired manually.

Real existing-app validation initially failed to resolve `path-to-regexp`, despite its declaration in the Arrusted manifest and lockfile. The shared iteration branch returned before Bun installation; it now installs against the resulting source before issuing an applied receipt. Stale preimages prevent writes/install, and installation failures preserve partial-apply recovery evidence. The mock also stops honestly on `validation_failed`; the eval immediately requires an actual validated result before requesting review. Raising the timeout did not repair this defect, and that change was reverted.

Earlier failed and timed-out attempts remain evidence: missing executable resolution, contradictory development flags, unavailable browser executable, obsolete component props, obsolete internal-call assertions, unsuitable source selection, and the six-minute timeout. After that timeout, Eve did not exit and blocked a subsequent launch; the coordinator verified and terminated that eval's process before retrying. This cleanup limitation is recorded rather than hidden by a passing rerun.

Local sanitized evidence is `/private/tmp/cross-eval-milestone-20260914/{index.html,assessment.md,assessment.json,summary-inputs.json,milestone-notes.json}`, with every imported attempt in `annotated-summaries/`. A complete batch at clean `3d23a6835` passed design **17/17**, identity **23/23**, reviewed changes **38/38**, and toolchain **10/10**; existing iteration failed **14/16**. Earlier runs against evolving checkouts retain their unresolved provenance rather than being relabeled with this revision.

After dependency installation was repaired, actual Rust compilation exposed missing `cc`. Shared setup now installs the native compiler through the image's package manager (`apt-get`/`build-essential` or `dnf`/`gcc`). The first `dnf`-only attempt failed on the current Ubuntu image and remains recorded. The next existing-app failure was obscured by Arrusted's compiler wrapper, which drops captured stderr. A fresh structured diagnostic in the retained failed Sandbox reported `cue import` missing. That diagnostic is not an eval pass and did not edit candidate source. CUE preparation is being repaired through the existing source-declared Mise configuration.

The report preserves all 28 originally passing scenarios and the seven demonstrated improvements, separates raw runner verdicts from assessment findings, and identifies the retired internal diagnostic separately. Use the [scenario coverage guide](scenario-coverage.md) to reproduce the 39 deterministic and five opt-in Sandbox cases and generate reports. A fresh public-entrypoint live self-reproduction baseline remains the next milestone.

Post-merge auth CI exposed two different issues. `457b5c20` verifies the same established user/workspace after provider callbacks; the cause of the earlier missing session read remains unconfirmed. The reciprocal-link failure exposed a real pre-hydration product defect: enabled links initially used the default callback. `46a0395e` resolves reciprocal callbacks on the server under Suspense and adds raw-response HTML coverage without executing hydration scripts. The readiness-only test wait was removed and the original browser assertions remain. `f6cc7ed4` restores the full auth loading shell under Suspense. All required checks passed at `0e2df4097` in [CI run34882441032](https://github.com/withAutograph/autograph-app-builder/actions/runs/34882441032), including auth and all39 deterministic cases. Subsequent repair revisions require their own green CI before merge.

The CUE follow-up at `aebac734` timed out before validation: setup took 223 seconds and completed workspace/inspection/AppSpec calls each took roughly 29–31 seconds. The prior run also spent 22–24 seconds per call, so repeated CUE setup is not established as the cause of that overhead. Existing-app integration now allows ten minutes for cold setup plus actual validation, while still failing immediately on an unsuccessful validation receipt. This is separate from the earlier ineffective timeout increase that masked a mock review loop. Direct diagnostic commands remain diagnostic evidence only.
