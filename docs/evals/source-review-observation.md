# Owner source-review observation

`scripts/observe-source-review-events.mts` is a local, read-only observer of
already retained owner workflow steps. It never invokes agent tools, resumes a
session, queries providers, or supplies findings to generation.

Run with the repository's managed Node runtime and tsx, supplying
`--owner-store <private-workflow-data-directory>`, one or more explicit
`--run-id <owner-run-id>` arguments, `--original-request-file <original-brief>`,
and `--output-dir <new-external-directory>`. The output directory must be new
and outside the checkout and owner store. JSON and Markdown reports are written
with owner-only permissions. Do not supply another user's store or run IDs.

The observer supports retained zstd/devl plain-data step encoding. Unsupported
or unreadable records are counted, and tagged classes are never instantiated.
Tool inputs and results are paired only by matching tool name and call ID;
missing IDs remain separate fragments. The output allowlist contains hashed
call IDs, original-request digest, implementation-file count, result status,
source-assessment status/model/usage/digests and hashed citation paths with line
numbers and excerpt digests. Source, request text, explanation text, tool
arguments, credentials, URLs and messages remain private.

A supplied original-request digest is a binding to that supplied file, not
proof that an owner event received identical text. Record ordering, validation
writes and a later review digest establish an observable sequence, not causal
proof that a finding prompted a repair. The observer does not award runtime,
independence, generation or product correctness credit. Missing assessments
remain unassessed, including sessions generated before source review existed.
