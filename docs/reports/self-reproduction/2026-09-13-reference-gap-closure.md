# Reference workflow and lifecycle gap closure

The isolated handwritten reference now passes **14 browser assertions across five
workflows** and **six controlled-service assertions backed by PostgreSQL**. These
results improve reference coverage; they do not establish generated-app parity or
successful independent app generation.

## Browser proof

The final reference run exercised authentication (three assertions), durable
drafts (three), successful provider return (three), denied provider return and
replay (three), and documentation (two). Authentication restored an actual saved
draft after fresh OAuth, rejected signed-out access, and rejected a distinct
signed-in passkey user's access to an owner-readable handoff. Provider effects
used local emulators.

The original denial run preserved the draft and rejected replay but displayed no
GitHub failure notice. Commit `62df29da` repaired reference notice handling. The
final runtime was the original isolated reference snapshot plus that commit's
three-file overlay; the generated candidate was untouched. The final 14
assertions passed after the overlay.

Implementation:

- `6425f980`: authenticated draft restoration and cross-user isolation fixture.
- `3d10365f`: isolated fixture paths and current ChatGPT / Codex control.
- `a302e15c`: actual provider denial and callback replay fixture.
- [Workflow adapter](../../../evals/self-reproduction/workflow-adapter.ts).

## Controlled-service proof

The evaluator called the production hosted Eve session service with its actual
PostgreSQL store and an evaluator-controlled transport. It checked cancellation
acknowledgement, persisted terminal state, late completion after cancellation,
service recreation, continuation idempotency, and persisted completion.

Before repair, five assertions passed and late completion revived a cancelled
session. Commit `193ba829` made cancellation terminal under the store's existing
PostgreSQL row lock and returned the retained checkpoint from the service.
Explicit resume still creates a new child session. All six assertions passed
against the isolated PostgreSQL database after repair. A concurrent delayed-read
regression also verified cancellation wins over an already-pending response.

Implementation:

- `7f52f7b9`: [durable-service diagnostic](../../../evals/support/self-reproduction-reference-lifecycle.ts).
- `193ba829`: [session service](../../../lib/eve/hosted-service.ts) and atomic store repair.

These are direct service checks, not browser workflow receipts or live model
generation evidence. The controlled late snapshot demonstrates service-boundary
handling; it does not establish that the live engine produces that race.

## Local evidence and validation

Artifacts remain outside the reference checkout under
`/private/tmp/self-reproduction-reference-workflows-20260913/`:

- `summary.json`: original reference workflow observations, including the absent denial notice.
- `after-62df29da/summary.json`: final browser observations, 14 assertions passed.
- `lifecycle/reference-lifecycle.json`: original service diagnostic, five of six passed.
- `lifecycle-cancel-fix/reference-lifecycle.json`: repaired service diagnostic, six of six passed.
- `assessment.md`: local evidence summary.

These local paths are diagnostic records, not portable CI artifacts. Focused
workflow coverage passed 12 tests; the final service/store/lifecycle test run
passed 68 tests. Scoped lint and TypeScript checks passed.

The completed manual reference launcher was stopped and its dedicated database
container `self-reproduction-4fd9be45-3b91-47e9-9ec2-6c91cc81c687` was confirmed
removed. No other eval runtime was stopped.

## Remaining scope

Browser app creation, preview authorization, cancellation, retry, session
recovery, and independent child creation still need executable fixtures. The
handwritten web handoff does not substitute for generation lifecycle evidence.
Candidate behavior and visual/framework comparison require a working candidate
runtime and corresponding evaluator-owned fixtures. Anonymous entry remains
outside this follow-up. Hosted publication and provisioning remain unverified.
