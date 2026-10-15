# Product source review

Independent source review runs at final `accept_change_set`, after implementation
and technical validation are ready. Intermediate `validate_app_creation` returns
deferred source evidence without a paid independent review:
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

This implementation checkpoints completed application assessments, not every
intermediate model step. An interrupted incomplete application review may rerun.
Legacy fragment judgments and context-split records remain historical evidence;
they do not establish completion of an application-level review. No journal
migration or new provisioning step is introduced. See the
[continuation contract](source-review-continuation.md).

An actual provider context rejection can compact prior read payloads into
immutable evidence references and validated findings, with original documents
still accessible. Actual output-capacity rejection can use smaller evidence
submissions. Neither recovery path drops findings, changes the review model, or
returns to exhaustive fragment pairing. Caller cancellation remains effective
throughout; cancelled work cannot publish a completed assessment.

## Source and runtime evidence

The existing source binding, current-source observation, reviewed receipt,
publication approval and assessment detail references remain authoritative.
A review interruption alone does not require another technical validation.
Concrete implementation repairs use the normal focused validation path.

Source opinions remain advisory. Unavailable or interrupted review is reported
truthfully; it must not become a new admission gate or a fabricated passing
result. A completed review with no cited contradictions still has
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
