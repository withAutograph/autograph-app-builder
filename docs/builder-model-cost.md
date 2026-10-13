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

## Review scheduling

Intermediate `validate_app_creation` runs fresh repository commands, runtime
preparation, release capture and applicable persistent-backend browser tests.
It returns deferred/unassessed source evidence without starting paid independent
review. This is not a technical failure and should not cause another validation
attempt merely to obtain an assessment.

When implementation and required product QA are ready, `accept_change_set`
observes current source and performs the independent assessment. This final
review is required for private preview completion as well as publication.
Matching completed assessments are reused; interrupted matching reviews resume
journaled work. Concrete review findings are repaired through the supported
implementation/validation path before another final acceptance. Technical checks
are not cached or skipped by this scheduling change.

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
  browser task and deferred source evidence.
- `agent/tools/accept_change_set.ts`: final independent assessment, matching
  evidence reuse and change receipt.

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

## Measuring the next public build

Measure through the supported web workflow or five public MCP tools. Preserve the
original session, cursors, ordinary product replies and approvals. The evaluator
observes the product flow; it does not force internal stages or repair a generated
app manually. Keep the accepted app QA scope unchanged, including its declared
actors, tenants, roles and independent readbacks. Cost optimization must not
narrow the accepted actor/tenant matrix or drop product scenarios.

For an authorized next build, collect these measurements privately:

1. Record the deployed source revision and measurement window. Correlate the
   public build with its native runtime session and review tool-call identifiers.
2. Count fresh `requestAttempts` and `successfulRequests` by review invocation.
   Keep `journalReuses` and historical judgment coverage separate from these
   generation counts. Validation should emit deferred source evidence without
   new independent review requests.
3. Sum fresh provider-reported input/output tokens and cache-read/cache-write
   tokens from allowlisted per-request observations. Report incomplete usage and
   rejected or truncated responses rather than assuming they cost nothing.
4. Use authorized read-only Gateway generation lookup to obtain available
   generation costs and cache details. Reconcile these with the same session and
   window; account totals or a model name alone cannot identify one app's spend.
5. Report request count, token usage, measured generation cost and final product
   QA separately. A batching estimate or local test does not establish live
   savings or review quality.

No paid custom reporting tags are required. Keep account costs, session IDs,
journal aggregates and financial observations out of public repository content.
Use protected task evidence for measurement results; this guide defines the
procedure without publishing a private run's data.

## Remaining process work

The following changes are prospective and require shared workflow implementation:

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
