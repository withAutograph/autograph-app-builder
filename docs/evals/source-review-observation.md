# Owner source-review observation

`scripts/observe-source-review-events.mts` is a local, read-only observer of
already retained owner runtime streams. It never invokes agent tools, resumes a
session, queries providers, or supplies findings to generation.

Run with the repository's managed Node runtime and tsx, supplying
`--owner-store <private-workflow-data-directory>`, one or more explicit
`--run-id <owner-run-id>` arguments, `--original-request-file <original-brief>`,
and `--output-dir <new-external-directory>`. The output directory must be new
and outside the checkout and owner store. JSON and Markdown reports are written
with owner-only permissions. Do not supply another user's store or run IDs.

The observer supports installed framed devl Uint8Array stream encoding. Unsupported
or unreadable records are counted, and tagged classes are never instantiated.
Only top-level canonical action.result events from streams named by the owner run mapping qualify. Results are deduplicated by turn, tool name and callId; nested message/input text is never interpreted as runtime evidence. The output allowlist contains hashed
call and turn IDs, event sequence/step coordinates, original-request digest,
runtime completion/failure/rejection separately from tool output status,
source-assessment status/model/usage/digests and hashed citation paths with line
numbers and excerpt digests. Source, request text, explanation text, tool
arguments, credentials, URLs and messages remain private.

A supplied original-request digest is a binding to that supplied file, not
proof that an owner event received identical text. Record ordering, validation
results and a later review digest establish an observable sequence, not causal
proof that a finding prompted a repair. The observer does not award runtime,
independence, generation or product correctness credit. Missing assessments
remain unassessed, including sessions generated before source review existed.

Requested or successful write counts are not established by this observer.

Reports record the observer checkout revision and whether it had uncommitted
changes; unavailable Git metadata remains null. These identify observer code,
not the original generation revision. Preserve the public-run manifest separately.
