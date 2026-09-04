# Execution boundaries

Autograph App Builder is a dynamic generator for changing repositories. A different repository shape, new file, changed template, dependency layout, or working-tree edit is normal. The builder executes requested operations and handles results; it does not predict every possible difference.

## The only reasons to stop

The builder MAY stop before an operation only to prevent an outward effect the user has not approved, disclosure of credentials or another user's session/data, or continuation after an actual provider or repository command failure. Each control MUST name the concrete failure it prevents and a recovery path. Authentication and session ownership protect App Builder's private data; GitHub remains the authority for repository permissions.

## Explicitly not gates

The builder MUST NOT add speculative preconditions based on exact source SHA/tree, repository eligibility, source drift, expected files, package layout, tool versions, manifests, topology, path/mode/symlink/clean-tree state, caches, receipts, digests, readbacks, quotas, timestamps, process state, restart count, or workflow metadata. Checksums may be cheap release metadata but MUST NOT block development or startup. Caches and snapshots are performance features: misses rebuild normally. New and generated files are expected. Inspection is best-effort context; unfamiliar results are not failures.

## Execution model

Use supported Vercel Sandbox APIs and structured commands. Do not add shell wrappers or reverse-engineer provider internals. Let Sandbox, GitHub, and repository commands report actual behavior. Design, planning, dependency setup, prototyping, and workspace writes need no approval. Ask in plain language immediately before repository writes/pushes, draft PRs, deployments, provisioning, releases, or other external effects.

For local development, use `mise run dev` with live code and fast retries. Focused checks are for concrete repairs; broad acceptance belongs at the end of the local loop or in CI, not after every edit.

Any new blocking assertion requires documented user-visible failure, prevented effect, and recovery path. Otherwise it is prohibited.
