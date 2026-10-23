# Fixed plan: finish the core App Builder flow

## Objective

Make the already-built **Spend Review Requests** app usable through its saved public Builder workflow: connect the existing intended account, open the protected app, and save exactly one approved synthetic request that survives independent readback and reload.

Read [the state handoff](app-builder-core-reset-handoff-20261022.md) first. A fresh **Codex session** resets coordination; preserve the existing public Builder session, owned app source, resources and approvals.

## Frozen scope

Only two currently observed failure surfaces enter the repair plan:

- **401:** the existing account signs in normally, but the automatic saved-build connection POST fails.
- **403:** the actual fresh app document returns `TRUSTED_SOURCES_ENVIRONMENT_MISMATCH`.

They may share a cause. Explain both before writing fixes. Existing source and CI repairs are merged; PR1018 final CI is green. The final target is a hosted user journey, not a framework upgrade or expanded test suite.

## Execution sequence

### 1. Take over the checkpoint

The fresh session is the sole delivery coordinator, publisher, provider mutator and public-session writer. The previous delivery goal is confirmed paused at its handoff checkpoint. This user-authorized fresh session takes over execution of this plan; keep the old sessions paused and avoid competing writers.

Read the same saved public session once and reconcile already-issued requests. Cursor119/turn47 and the old invitation are snapshots, not current instructions. The invitation may have expired naturally. Reuse the original CIDs to reconcile uncertain outcomes; do not replace the app or manufacture a fresh run. Preserve any confirmed-live handle until its actual disposition is known.

Use the handoff's already-proved state as the starting point. No fresh install, broad audit, historical-app recertification, new account, migration, cleanup or new app generation is a prerequisite.

**Deliverable:** a short current-state entry naming ownership, saved session, pending/consumed actions and the two failure boundaries.

### 2. Diagnose both boundaries in parallel, then decide the patch set

**Lane A — account connection, one owner:** Use existing observations around the captured autoPOST. Find the matching Builder callback arrival/status and existing `realm_identity_callback_failure` stage/code. Distinguish sender signing/OIDC/transport, receiver validation/staging, and final original-owner browser handoff/nonce consumption. A successful account login or callback200 alone is insufficient. Do not reset credentials or add a second login procedure.

**Lane B — protected document, one owner:** Compare the effective caller/receiver environment and approved trust context for the actual failing document hop. Review the already-merged PR1654 header-overlay fix against the deployed4a source. Determine whether it is the necessary correction, or whether the effective workload/token/environment binding is wrong. Do not broaden trust policy or assume “latest framework” is the solution.

Compare the two findings for a common deployment/identity-context cause before splitting implementation. Read existing logs first. New instrumentation is justified only if the existing closed diagnostics cannot distinguish the specific boundary.

**Deliverable:** one concise cause/evidence/minimum-change proposal for each failure, or one shared cause covering both. List the exact owned files and expected behavioral outcome. Uncertainty stays explicit.

### 3. Freeze and implement the minimum patch set

The coordinator records the agreed patch list before implementation. Delegate only independent file scopes in isolated checkouts. Shared Builder/Arrusted framework repairs may be edited directly in their source repositories; generated app changes and adoption of shared framework fixes must go through the public App Builder, on the same owned app PR/branch.

Use an existing suitable fix rather than inventing another abstraction. Integrate the bounded changes and perform only a focused source check needed for the concrete repair. Existing exact-head CI supplies broad verification in parallel; Step5 supplies the hosted behavioral proof. New tests, broad local suites, fresh installs and repeated builds are outside this plan. Do not add assertions about arbitrary app roles, shape, source versions or layout, quotas, speculative gates, paid intermediate reviews or repeated full walkthroughs.

Carry authorized PRs through normal merge without waiting for pending CI; track the final CI outcome. Keep security and actual effect approvals intact.

**Deliverable:** integrated, reviewed source addressing only the diagnosed causes, with exact publication evidence and any remaining uncertainty.

### 4. Deliver through the supported workflow

Let Builder publish/reconcile the owned source, retain its publication association, propose the concrete plan and perform approved provider effects. Reuse standing approval for the same actors/effects; obtain approval only where scope is genuinely new.

If account linking needs the corrected Gateway before full app preparation, deliver that prerequisite first, complete normal account linking, then prepare/deliver the app. This is one dependency-aware delivery sequence, not a series of unrelated repair projects.

Observe the exact served source and stable aliases after the workflow finishes. READY is an intermediate observation; the existing Gateway effect already owns alias assignment and readback. Do not manually override generated app files, source pointers or aliases to manufacture success.

**Deliverable:** the current app/Gateway deployments and the normal saved-build account connection are bound to the approved source and resources.

### 5. Demonstrate one user journey

Use the existing intended account through normal sign-in. Open the fresh app and confirm its ordinary queue/details/activity load. Submit exactly the one approved record named in the handoff, once. Confirm the resulting status, fields and activity; independently read the same record through the existing authorized path and hard-reload it.

If the save result is uncertain, read/reconcile before retrying. Preserve the record identifier and proof. No purchases, reviewer decisions, extra users or additional seed records.

**Deliverable:** one coherent authenticated entry → save → confirmation/readback → reload receipt, associated with the actual served source. This is user behavior evidence, not a new CI admission gate.

### 6. Close the core milestone and stop

Record final exact-head CI and the scoped hosted proof. Separate passed, failed, deferred and unassessed items. Hand the user a usable address and safe login guidance without exposing credentials.

Stop implementation when the objective above is met. Export, reviewer workflows, restart/fault drills, signup/recovery, IaC, polish, general optimization and broader self-reproduction belong to later work.

## Rule that prevents another expanding loop

If a newly observed issue is directly explained by an agreed cause and falls inside the frozen patch scope, finish that repair. If completion requires a different root cause, new feature, expanded provider effect or materially different implementation, **stop adding changes**. Report the evidence and a bounded plan amendment for user review. Do not silently turn discovery into another implementation lane.

A failed diagnostic or timeout is not permission to restart a live operation, weaken an assertion, broaden access or repeat a potentially committed write.

## Timing

Retire previous rolling completion estimates. The callback401 root cause and document403 correction are not yet established. Give the first new completion estimate after Step2 identifies the minimum patch set, including a measured provider rollout allowance and a separate allowance for the single user journey. Report actual elapsed time by step; update only the affected remaining work when evidence changes.

## Fresh-session kickoff

> Read `app-builder-core-reset-handoff-20261022.md` and execute this fixed plan. First establish sole delivery ownership and reconcile the same saved public Builder session. Diagnose the recorded account-connection401 and app-document403 jointly before changing code, using bounded parallel agents for the two source/log contracts. Freeze the minimum patch set; implement and deliver only that scope. All generated-app changes go through Builder on its existing owned PR. Prove normal existing-account entry and exactly one approved $1 save/readback/reload, collect final CI, and stop. Preserve credentials, approvals, tenant boundaries, original CIDs and live handles. Report a plan amendment instead of adding improvements or unrelated fixes on the fly.
