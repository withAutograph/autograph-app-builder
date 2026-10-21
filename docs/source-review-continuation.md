# Durable source review continuation

Ordinary `accept_change_set` prepares final independent review from the parent
session's applied checkout at `state.applyReceipt.applyRoot` and returns an opaque
reference. Builder follows it through the blocking
`review-current-product-source` workflow, then calls ordinary
`accept_change_set` with the returned reference to finalize. Matching completed
assessments can be reused directly. Intermediate technical validation returns
deferred/unassessed source evidence without paid review.

The final review attempt is required. An unavailable or interrupted assessment
remains truthfully unassessed and does not gate private preview/publication or
require a technical-validation rerun. Concrete findings and existing approval
boundaries remain authoritative.

A later reconciled GitHub draft uses a separate `candidate.root`, so the earlier
applied-source assessment does not assess that candidate. PR #945 clarifies that
`accept_change_set` must not be rerun to obtain a candidate assessment or repeat
old-source paid reviews. The deterministic candidate diff review remains usable
for normal approved publication. Report an unavailable independent candidate
assessment honestly and continue; no new paid feature, human Continue reply or
review prerequisite is added. Preserve requested app-authored behavior checks;
unavailable hosted behavior remains unverified until exercised after delivery.

## Completed application records

The application reviewer uses the existing immutable owner/session journal.
A closed `application-completed` record contains the validated, sanitized
application assessment. Its key identifies the review protocol/model/rubric,
complete requirements and accepted spec, observed source snapshot and normalized
intended diff. A matching completed record avoids fresh model generation.
Concurrent retries consume the canonical first stored completed decision.

## Native continuation

Each completed provider/tool round is a native private Workflow step checkpoint.
Resuming the same workflow restores its model continuation and checked evidence
progress rather than replaying all committed model calls. An in-flight round
that did not commit can repeat. A separate new workflow call has no guarantee
of resuming a prior incomplete review, and this is not exactly-once billing.

First full distinct source, requirement and listing results remain visible in
the current model context. Only older exact duplicates become references to a
still-retained identical full result; the newest parallel group remains full.
Unique pages can accumulate. Actual provider capacity rejection can replace the
context while preserving checked findings and continued access to originals;
references do not assert evidence remains visible after that replacement.

Previously stored fragment judgments and split plans retain their original
provenance. They cannot satisfy application-review completion.

Ordinary source or product-input changes create new keys. They do not trigger a
new infrastructure prerequisite or invalidate an already sealed publication
approval. The current source observation and existing publication contracts
still govern a newly reviewed result.

## Authority and storage

The completed-assessment journal uses the existing
`product_source_review_journal` table and migration
`0028_product_source_review_journal`. Every journal read/write and each subsequent
provider round or private evidence read checks current workspace/session
ownership and Stop. Local storage remains in the verified server-owned private
state directory. Records are never shared across owners or sessions.

Prepared parent evidence and terminal outcomes use the existing owner/session/app
protected operator chunk store, under its private `source-review-context` kind.
The prepared descriptor contains complete requirement text and captured source
metadata; the outcome binds its assessment to that descriptor and can honestly
record incomplete advisory work. These private chunks are access-controlled,
not application-encrypted. The descriptor/outcome format does not serialize model transcripts, runtime credentials or authentication envelopes.
No new storage resource or migration is introduced.

Raw model continuation lives in native Workflow step inputs/outputs, separate
from the sanitized completed journal and the private descriptor/outcome store.
Native I/O encryption depends on the configured World and available run key;
source wiring alone does not establish hosted encryption or recovery proof.

Completed journal records contain sanitized conclusions and evidence digests,
never raw source, whole requests, quoted excerpts, model transcripts or
credentials. Cancellation and revoked authority prevent completed publication;
provider-failed or incomplete work is not stored as a completed assessment.
Read-only evidence reconstruction looks up the captured existing Sandbox with
`resume:false`, then uses public `currentSession()` file reads. It never creates,
resumes, rebuilds or commands a Sandbox; an actual unavailable read stays
unavailable.

The existing storage lifecycle must establish journal availability; a source
deployment alone is not proof of hosted storage. Source judgments remain
advisory and cannot prove runtime behavior or hosted readiness.

## Accounting

Historical assessment `usage` describes retained review provenance, not fresh
spend on every retry. Invocation counters report fresh requests and reported
tokens separately from journal reuse. Missing usage from an interrupted or
rejected provider request cannot establish zero cost. See
[model cost accounting](builder-model-cost.md#accounting-and-evidence).
