# Builder model use and cost accounting

Builder uses model calls for app authoring and independent review. This guide
explains request batching, build phases and how to account for fresh usage.

## Four business phases

The intended journey is initial version and build approval → build → independent
review → requested delivery. Deployment and submission belong to the requested
outcome when included in the brief. These are business phases, not a guarantee
of exactly four API requests. Public progress reads, deterministic tool calls,
model generations and provider billing are separate quantities.

Current private build approval covers implementation and validation. Publishing,
provisioning, deployment and activation retain their existing effect approvals.
The workflow currently supplies private preview and separately approved
publication; Production activation remains an operator handoff. Automatic
end-to-end delivery has not been implemented by this cost change.

## Source review optimization

Previously, each selected source page and each chronological requirements excerpt
formed its own model request. With `P` source pages and `C` requirements excerpts,
one complete review started `P × C` requests before provider context splits.
Four concurrent calls reduced elapsed time but did not reduce that request count.
Coverage still includes every pair, but pending
pairs now share a serialized JSON prompt bounded to 128 KiB; rubric instructions
and output schema are outside that JSON budget. The review model, rubric,
mechanical citation checks and per-pair durable journal remain authoritative.
Provider context rejection triggers smaller batches or singleton page/context
splits. There is no arbitrary app quota, model downgrade or skipped review.

Unchanged later assessments reuse exact evidence. Interrupted retries reuse
completed matching pair records. The full source and requirements binding still
invalidates every pair key after source or clarification changes, so batching
does not provide selective reuse across repairs.

Implementation pointers:

- `lib/agent/product-source-review.ts`: pair coverage, bounded requests, citation
  checking, provider fallback and per-pair journal.
- `lib/agent/review-applied-product-source.ts`: observed overlay binding and exact
  assessment reuse.
- `lib/agent/product-source-review-state.ts`: original request and clarification
  retention.
- `agent/tools/validate_app_creation.ts`: repository checks, persistent backend
  browser task and automatic independent assessment.
- `agent/tools/accept_change_set.ts`: change receipt and shared assessment reuse.

## Accounting and evidence

Historical assessment `usage` is the token total attached to review judgments.
It includes retained or journaled evidence and must not be counted as newly billed
usage every time an assessment is returned. Invocation metrics distinguish newly
attempted provider calls and fresh provider-reported tokens from reuse. Rejected
calls can incur cost without returning usage; missing counters or usage are
unavailable evidence, not proof of zero spend.

The assessment's `invocation` fields describe one invocation:

| Field                         | Meaning                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestAttempts`             | Newly started model requests, including provider context rejections.                                                                               |
| `successfulRequests`          | Accepted provider responses, including responses whose citations fail validation.                                                                  |
| `requestsWithIncompleteUsage` | Started requests without complete reported input/output/total token usage; their cost remains incompletely accounted.                              |
| `journalReuses`               | Completed pair judgments replayed from the journal.                                                                                                |
| `splits`                      | Provider context fallback batch or singleton splits taken in this invocation.                                                                      |
| `freshUsage`                  | Newly provider-reported `inputTokens`, `outputTokens` and `totalTokens`, including responses whose structured output or citations fail validation. |

A retained exact assessment needs no new generation; report its fresh invocation
usage accordingly rather than carrying its historical attempts into a new call.

Runtime session and tool-call identifiers correlate source-review progress with
a saved build. Gateway request IDs, when returned, support per-generation lookup;
this change does not configure Dashboard sessions or paid Custom Reporting.
Each completed provider request logs only allowlisted generation/response IDs,
when supplied,
and input, output, cache and reasoning token counts. These correlate a provider
cost lookup with one review invocation without logging source, messages or
credentials. Requirements precede changing source in batch prompts so repeated
requirements can form a stable provider-cache prefix. This is provider prompt
caching, not reuse of a stale review judgment.
Use actual invocation counters and provider billing records to reconcile spend;
public polling counts and workflow phase counts cannot substitute for that
attribution. Provider usage and local source evidence still need exact deployed
version and dashboard-window readback before claiming measured savings.

## Remaining process work

The following changes are prospective and require shared workflow implementation:

- Separate focused repair checks from the final independent assessment so each
  technically successful intermediate repair does not automatically launch a
  complete paid review. The current validation tool still runs source assessment
  after successful technical checks.
- Reuse executed behavioral evidence for matching source and runtime inputs; run
  missing scenarios rather than repeating already covered browser journeys.
- Drain deterministic diff paging, command sequencing and receipt handling in
  supported workflow code, preserving complete reads and approval boundaries.
- Separate authorization decisions from product requirement clarifications and
  design safe selective judgment reuse before changing global review bindings.
- Complete approved deployment/submission through supported delivery capabilities;
  report operator or provider blockers through the original public session.

Do not bypass validation through an unproven cache, impose arbitrary request or
spend quotas, or repair generated apps manually as a substitute for fixing the
Builder workflow. Keep the public five-tool contract and original session,
cursors, product replies and approvals.
