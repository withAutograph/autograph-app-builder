# Self-reproduction live baseline, 2026-09-13

This record covers the first live run after adding complete candidate export,
evaluator-owned parity receipts, and independent Vercel Sandbox startup. It does
not replace the retained machine reports under the external evidence directory.

## Outcome

The live generation ran for 908,787 ms and failed before producing a reviewed
candidate. The model requested `apply_app_creation` with an empty implementation
file list. After the fixed approval response, the next model request was rejected
by the gateway because that function call had no matching tool output. The eval
therefore reported all 38 candidate requirements failed due missing output and all
38 reference requirements unassessed. No candidate runtime or paired capture was
claimed.

The run is retained locally at
`/private/tmp/app-builder-self-reproduction-true-eval-20260913-r10`. This path is
diagnostic evidence and is not checked into the source tree.

## Confirmed harness repairs

- Parity assessment now accepts only evaluator-produced runtime and capture
  receipts and assigns stable reason codes for passed, failed, blocked, and
  unassessed results.
- A candidate runtime can reconstruct the complete tracked Arrusted workspace in
  a fresh project-scoped Vercel Sandbox, install pinned Bun, resolve the disposable
  overlay without saving a lockfile, run the repository-owned app build, and probe
  the production server from inside the sandbox.
- Reviewed export now includes the complete app tree, including scaffold-owned
  `hk.pkl`; the older retained candidate correctly remains non-runnable because
  its historical export omitted that file.
- Approval-response turns are now retained as first-class evidence and fail the
  eval immediately when their continuation fails, preventing a later model turn
  from inheriting a dangling function call.

## Remaining assessment work

Trusted per-side browser adapters are still required for authentication, durable
draft readback, provider success and denial returns, creation, preview access,
cancellation, retry, recovery, and the one-child independence proof. The same
adapters must prepare and capture panel resize, keyboard, loading, empty, and
error states at all three desktop viewports. Instant navigation needs executed
`@next/playwright` assertions; framework configuration alone receives no credit.

The earlier retained `r5` candidate remains useful diagnostic evidence. It uses
server actions and filesystem persistence, but source inspection confirms that
its “child app” is only a stored record and preview route rather than generated
source, its tenant is hard-coded, its provider return is not a callback/state
replay flow, and two route roots are client components. Those are candidate
quality gaps, not passes or infrastructure blockers.
