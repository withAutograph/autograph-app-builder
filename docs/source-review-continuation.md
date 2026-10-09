# Durable source review continuation

Changed-source review still visits every selected source page and every original
request, clarification, and accepted AppSpec context. Completed, mechanically
validated page/context judgments are written to the source review journal before
the next model call. A retry in the same authenticated session reuses matching
completed work and resumes remaining pairs. Provider context-size split plans
are retained separately; a split plan is not completed evidence.

Keys identify the exact source page bytes and position, requirement context,
omissions, review binding, model, and rubric. Normal input changes create new
keys. Results aggregate in the original order with the same citation digests,
findings, runtime-check set, and judgment usage. Concurrent retries consume the
same canonical first stored decision. Interrupted, invalid, or provider-failed
judgments are not recorded as completed work.

Hosted storage uses the dedicated `product_source_review_journal` table and
additive migration `0028_product_source_review_journal`. Every operation verifies
current workspace membership and ownership of the native Eve session. Local
development uses the verified server-owned private state directory. Neither
adapter shares records across owners or sessions. Journal records contain
sanitized opinions and evidence digests, never source page bytes, request text,
quoted source/requirements, or credentials.

Apply the migration through the supported database lifecycle and verify the
hosted storage contract before qualifying hosted continuation. A source-only
deployment does not establish table availability. Source judgments remain
advisory; their completion does not prove runtime behavior or hosted readiness.
