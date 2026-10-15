# Durable source review continuation

Final `accept_change_set` owns independent source review. Intermediate technical
validation returns deferred/unassessed source evidence without paid review.
Continue in the same saved session; repeat technical validation only for changed
implementation or a concrete technical failure.

## Completed application records

The application reviewer uses the existing immutable owner/session journal.
A closed `application-completed` record contains the validated, sanitized
application assessment. Its key identifies the review protocol/model/rubric,
complete requirements and accepted spec, observed source snapshot and normalized
intended diff. A matching completed record avoids fresh model generation.
Concurrent retries consume the canonical first stored completed decision.

Only complete application assessments are checkpointed by this implementation.
An interrupted application review can rerun its incomplete model work; there is
no durable per-tool transcript, group-progress workflow, or mutable checkpoint
index. Do not describe incomplete application work as fully resumable.
Previously stored fragment judgments and split plans stay readable and retain
their original provenance. They cannot satisfy application-review completion.

Ordinary source or product-input changes create new keys. They do not trigger a
new infrastructure prerequisite or invalidate an already sealed publication
approval. The current source observation and existing publication contracts
still govern a newly reviewed result.

## Authority and storage

Hosted storage uses the existing `product_source_review_journal` table and
migration `0028_product_source_review_journal`; application records require no
new migration. Every journal read and write verifies current workspace
membership and native-session ownership. Aggregate reuse must go through the
same live-authorized journal read. The multi-step reviewer rechecks that existing
authority before subsequent provider calls and private evidence reads; revocation
stops later model work, private reads and completion retention. Local storage remains in the verified
server-owned private state directory. Records are never shared across owners
or sessions.

Records contain sanitized conclusions and evidence digests, never raw source,
whole requests, quoted excerpts, model transcripts, or credentials.
Cancellation and revoked authority prevent completion publication. Invalid or
provider-failed results are not stored as completed assessments.

The existing storage lifecycle must establish journal availability; a source
deployment alone is not proof of hosted storage. Source judgments remain
advisory and cannot prove runtime behavior or hosted readiness.

## Accounting

Historical assessment `usage` describes retained review provenance, not fresh
spend on every retry. Invocation counters report fresh requests and reported
tokens separately from journal reuse. Missing usage from an interrupted or
rejected provider request cannot establish zero cost. See
[model cost accounting](builder-model-cost.md#accounting-and-evidence).
