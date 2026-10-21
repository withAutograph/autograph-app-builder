# Builder model use and cost accounting

Builder uses model calls for app authoring and independent review. This guide
explains application-level review, build phases and fresh-usage accounting.

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

When implementation and required product QA are ready, ordinary
`accept_change_set` prepares the independent review. Builder follows its opaque
reference through blocking `review-current-product-source`, then ordinary
`accept_change_set` finalizes the result. The final independent review attempt
is required; an unavailable/interrupted assessment remains truthfully unassessed
and does not gate private preview/publication or require another technical
validation. Concrete findings use the normal repair path and existing approvals.
Matching completed assessments are reused. The same native workflow resumes
committed provider/tool rounds; an in-flight uncommitted round can repeat, and a
separate new workflow call has no prior-continuation guarantee. Technical checks
are not cached or skipped by this scheduling change.

Here, current source means the applied checkout at
`state.applyReceipt.applyRoot`. A later GitHub draft reconciliation uses a
different `candidate.root`; the earlier applied-source assessment does not assess
that candidate. PR #945 clarifies this provenance: do not rerun
`accept_change_set` to obtain a candidate assessment or repeat paid review of the
earlier source. Continue deterministic candidate diff review and normal approved
publication, reporting any unavailable candidate assessment honestly. No extra
paid review, human Continue reply or review gate is introduced. Preserve requested
app-authored behavior checks and their results; unavailable hosted behavior stays
unverified until it can be exercised after delivery.

## Source review optimization

The final reviewer assesses the application against the exact original request,
chronological product changes and complete accepted AppSpec. Read-only evidence
tools expose requirements and relevant source paths, including unchanged imports.
The reviewer can inspect related files together and must support findings with
mechanically checked requirement quotes and source citations.

This replaces the previous Cartesian method: every selected source page was
paired with every requirements excerpt, then pairs shared bounded requests.
Batching reduced request fanout but still multiplied judgments, repeated context
and journal operations. The application reviewer has no mandatory page × excerpt
matrix. It retains the selected review model and separate runtime acceptance;
there is no model downgrade, arbitrary app/request/spend quota, or skipped
original requirements.

Only a completed application assessment is stored in the existing immutable
owner/session journal. Matching complete evidence reuses without fresh
generation after current authorization. Native per-round continuation is
separate from this sanitized completed journal; it does not guarantee exactly-once
billing. Legacy fragment records retain their provenance and cannot establish
application-level completion. Normal source or requirements changes create
ordinary cache misses under the exact source/diff/input binding.

The current context retains first full distinct evidence and the newest parallel
read group; older exact duplicates can reference a still-visible full result.
Unique pages can still grow context. Actual provider context/output rejection
uses immutable evidence references or smaller evidence submissions while
preserving access to complete originals and validated findings. Transport paging
is not a workload ceiling.
No savings multiplier is assumed before an equivalent run is measured.

Implementation pointers:

- `lib/agent/application-source-review.ts`: independent app reviewer, read-only
  tools, checked evidence, provider recovery and request accounting.
- `lib/agent/product-source-review.ts`: shared assessment validation/sanitization
  and legacy fragment-review provenance.
- `lib/agent/product-source-review-journal.ts`: closed completed-app record.
- `lib/agent/review-applied-product-source.ts`: observed source, current authority,
  exact completed-assessment reuse and final source observation.
- `lib/agent/product-source-review-state.ts`: original request and clarification
  retention.
- `agent/tools/validate_app_creation.ts`: technical validation and deferred source
  evidence.
- `agent/tools/accept_change_set.ts`: parent preparation and final receipt.
- `agent/tools/review-current-product-source.ts` and
  `lib/agent/application-review-workflow.ts`: blocking per-round continuation.

## Accounting and evidence

Historical assessment `usage` is the token total attached to review evidence.
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
| `journalReuses`               | Completed review records replayed from the journal.                                                                                                |
| `splits`                      | Provider-capacity recovery steps in this invocation; legacy reviews report batch or singleton splits.                                              |
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
credentials. Stable requirements and reviewer instructions can form a provider-cache prefix.
Provider prompt caching is distinct from reuse of a completed assessment.
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
   QA separately. A source-derived estimate or local test does not establish live
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
- Preserve the distinction between authorization decisions and product requirement
  clarifications; pure effect approvals must not create new product requirements.
- Complete approved deployment/submission through supported delivery capabilities;
  report operator or provider blockers through the original public session.

Do not bypass validation through an unproven cache, impose arbitrary request or
spend quotas, or repair generated apps manually as a substitute for fixing the
Builder workflow. Keep the public five-tool contract and original session,
cursors, product replies and approvals.
