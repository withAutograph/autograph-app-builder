# Central machine source capture

Before offering a new central setup or publishing its source, the native
composition runs a read-only capture using the pinned central worker. The plan
must already freeze the reviewed source, worker executable hashes, build-receipt
hash, Gateway/Integrations graph, and explicit deployment-profile value. Those
expected values are compared with actual source-owned artifact observations;
they are never returned as observations merely because a caller supplied them.

The existing framed Sandbox transport uses the distinct `central_source_capture`
context and `central-integration-source-capture` subcommand. It receives the full
canonical plan and no database connection, credential file or mutation callback.
The source worker verifies the immutable build receipt and actual source, graph
and executable bytes. The returned receipt and its canonical checksum must match
the entire frozen tuple. Current owner, call cancellation and source scope are
checked before dispatch, during read-only protocol checks and after readback.

The protocol's fresh inspection epoch is not a database fence or installer
approval. Read-only mode rejects authorization/checkpoint requests, database
files and execute mode. Capture cannot mark any resource/schema/provider effect
applied. A successful capture is source qualification only; it does not establish
a clean provider environment, loaded hosted configuration or functional behavior.

Packaging must retain the source-owned receipt and exact compiled worker files
in the immutable worker filesystem. Pinning a raw TypeScript hash cannot replace
pinning the executable. A missing receipt or mismatch remains a prerequisite;
neither Git branch names nor current HEAD elect a deployed application.

For maintainer release packaging, build the source-owned receipt and all three
workers with Arrusted's `central-source build-receipt --output-root` outside the
live planning checkout. Then run `mise run source:central-worker-bundle` with
`--source-root`, `--artifact-root`, a new `--destination`, the explicitly reviewed
`--reviewed-source-sha` and independently recorded `--receipt-sha256`. This offline
operation copies only Git-inventoried bytes and the exact three executable files;
it excludes local credentials, dependencies and Git metadata. Existing destinations
are never overwritten. Failed staging directories remain for scoped inspection.

The output contains `repository/` and a bounded `bundle.json` descriptor. Each
worker has its Bun shebang and executable mode before its hash is pinned. A fresh
Linux Sandbox base must independently prove Bun availability and direct execution
of these files before a code-only snapshot can be used by the operator. Do not
snapshot an installer run containing database state or credentials. These are
release artifact checks, not prerequisites for ordinary local Builder iteration.

This bundle is additive, not a complete replacement for the operator's existing
installer filesystem. Build the release snapshot from a fresh instance of its
trusted worker base, add the reviewed central files, and independently verify
the union of executable paths, hashes and required runtimes for every selected
catalog. Include Auth proposal/bootstrap, access, memberships, ordinary resource
workers and any selected export/managed-runtime workers. A fresh universal image
plus these three scripts does not supply those existing executables.

Inventory both the base `PROTECTED_HOSTED_OPERATOR_CONFIGURATION.sandbox` and
each selected `PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES` configuration's
`sandbox`. Standard app setup uses the resource profile's filesystem; changing
the base configuration alone does not update it. Preserve legacy paths and
frozen operation meanings. Select the qualified code-only snapshot explicitly
in each intended configuration, before any SQL or credential files enter it.
