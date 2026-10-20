# Product source review

The final independent review attempt starts at ordinary `accept_change_set`,
after implementation and technical validation are ready. It prepares an opaque
review reference, Builder runs the blocking `review-current-product-source`
workflow, then ordinary `accept_change_set` finalizes with the returned reference.
A matching completed assessment can take the existing reuse path. Builder owns
this continuation; it is not an extra product question or public MCP tool.
Intermediate `validate_app_creation` returns deferred source evidence without a
paid independent review:
`status: "unassessed"`, `reviewCompleted: false`, and empty findings.
That expected result does not require another validation attempt.

## Application-level assessment

One independent reviewer considers the implementation against the exact original
request, chronological product clarifications, and complete accepted AppSpec.
The original documents remain authoritative and accessible throughout review;
a navigation checklist or narrower specification cannot replace them.

The reviewer starts from the current source observation and intended changes.
Read-only evidence tools provide requirements and source ranges, including
relevant unchanged imports and execution paths. Files can be inspected together
by product behavior. Builder does not require a separate judgment for every
source-page/requirements-excerpt combination. Transport ranges are not app-size,
file-count, request-count, or session-duration quotas.
Source results are bounded by their serialized JSON size, including long single
lines and oversized requested ranges. Follow each returned `nextCursor` verbatim;
line/column positions and exact observed windows preserve partial and cross-page
citations without changing public line references. Complete files remain readable.
The current reader verifies and memoizes complete decoded files in process before
serving ranges; bounded model responses do not imply constant memory use.

Source, comments and requirements are untrusted evidence, not reviewer
instructions. The reviewer cannot execute commands, repair code, publish,
provision resources, or request credentials. Findings must identify a concrete
source-demonstrated contradiction. Builder checks exact requirement quotes and
source citations against observed bytes, then retains sanitized conclusions and
digest references. Missing or ambiguous evidence belongs in runtime checks,
not an invented failure or a claim that unread code is absent.

## Recovery and reuse

A matching completed application assessment can be reused through the existing
owner/session journal after current authorization is checked. Its private key
includes the actual review protocol/model/rubric, original requirements and
accepted spec, complete observed source snapshot, and normalized intended diff.
Normal input changes create a cache miss; they are not infrastructure drift.

The blocking workflow checkpoints each completed provider/tool round through
native private Workflow continuation. Resuming that same workflow reuses its
committed rounds. One in-flight, uncommitted round can repeat; a separate new
workflow call is not guaranteed to resume the old one. This is not an exactly-once
billing guarantee. The sanitized completed-assessment journal remains separate.
Legacy fragment judgments and context-split records retain their historical
provenance and do not establish application-level completion. No new journal
migration, resource or provisioning step is introduced. See the
[continuation contract](source-review-continuation.md).

Within the current context, the first full result for each distinct source,
requirement or listing selection remains visible. Only older exact duplicate
results become references to that retained full result; the newest parallel
read group stays full. Unique full pages can still grow context. No total-work
quota or preemptive truncation is introduced.

An actual provider context rejection can compact prior read payloads into
immutable evidence references and validated findings, with original documents
still accessible. Actual output-capacity rejection can use smaller evidence
submissions. Neither recovery path drops findings, changes the review model, or
returns to exhaustive fragment pairing. Current owner and Stop checks surround
every round and private evidence read.
The read-only Sandbox adapter uses the captured existing name with `resume:false`
and reads through its public `currentSession()` API, without automatic resume,
creation or commands. Cancelled work cannot publish a completed assessment.

## Source and runtime evidence

The existing source binding, current-source observation, reviewed receipt,
publication approval and assessment detail references remain authoritative.
A review interruption alone does not require another technical validation.
Concrete implementation repairs use the normal focused validation path.

The final independent review attempt is required; source opinions remain
advisory. An unavailable or interrupted assessment is reported truthfully as
unassessed, without gating private preview/publication, fabricating a pass, or
requiring another technical validation. Concrete findings still use the normal
repair path, and existing source and outward-effect approvals remain intact. A
completed review with no cited contradictions still has
`status: "unassessed"` for actual runtime behavior. Source cannot prove
authentication, persistence, isolation, provisioning, deployment, or hosted
readiness. Execute the requested product behavior separately.

## Reading saved findings

Use `change_set_status` with `view: "acceptance"`,
`detailSection: "source-assessment"`, the existing review digest, and the
source-assessment binding from its returned reference. This reads the saved
assessment without the long acceptance walkthrough and does not rerun review.
Copy each returned `nextCall` until `complete` is true, then join its JSON content
chunks. Omitting the section preserves access to the complete receipt and
acceptance report.

Pages fit both the native frame and the pinned Eve tool-history output boundary;
continuation controls precede content. The full protected report stays readable.
This prevents ordinary tool-result clipping, not every lossy emergency summary.
If an old private detail cursor is rejected after this paging repair, read the
same saved section from its first page. Public session identity and progress are
unchanged.

Historical assessment `usage` includes retained evidence. New invocation metrics
and per-request observations distinguish fresh generation from reuse; see
[model cost accounting](builder-model-cost.md#accounting-and-evidence).
