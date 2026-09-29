# Builder build limits and recovery inventory

This inventory records the limit's source, its effect on an app build, and the
recovery path. A page or chunk size controls memory for one operation; it is not
a ceiling on the total number of files, events, or retry attempts.

| Boundary                           | Basis                                                      | Behavior                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub repository enumeration      | Provider pagination                                        | Default hosted target access checks request the selected repository directly. Legacy adapters that lack target access proof still enumerate and accumulate IDs; durable cursor and streamed compatibility work remains open. |
| Repository candidate names         | GitHub name availability                                   | Generate names lazily. Only a confirmed collision advances to another name; permission, validation, quota, and service failures retain their distinct diagnostics.                                                           |
| GitHub recursive trees             | Provider 100,000-entry or 7 MB recursive response boundary | On `truncated`, walk nonrecursive subtrees. A truncated individual directory fails with repository, revision, and path; it is never accepted as complete.                                                                    |
| GitHub files                       | Provider 100 MiB per-file ceiling                          | Report the rejected operation and path. Suggest a smaller source file or a user-approved storage alternative; do not silently redesign storage.                                                                              |
| Eve event messages                 | Transport envelope                                         | Size each artifact chunk against the serialized envelope, including escaping and metadata. Continue with another chunk; do not impose a total artifact ceiling.                                                              |
| Model review context               | Provider context capacity                                  | Review source in scoped, digest-verified pages. Report the path and line when the smallest page is rejected.                                                                                                                 |
| Postgres checkpoint stage          | Database transaction and memory pressure                   | Write immutable 64 KiB byte chunks and publish the manifest atomically with the session pointer. The chunk size limits one read or write, not history length.                                                                |
| Hosted session compute lease       | Cleanup and stale-writer fencing                           | Compute can be released after idle or lifetime expiry. The public session and its durable progress remain available for continuation.                                                                                        |
| Hosted Eve read deadline           | Stalled provider response recovery                         | A single read times out after 30 seconds and returns a recoverable error. A later read can continue the same durable session; this is not a total session or history limit.                                                  |
| Eve Sandbox duration               | Eve inherited default                                      | Keep the current 30-minute default. Restart compute from durable progress when possible.                                                                                                                                     |
| Untrusted requests and identifiers | Authentication, integrity, and provider naming             | Keep finite request body, credential, path, identifier, and per-call page bounds. These do not set a total app or session workload quota.                                                                                    |

## Live and compatibility paths

Hosted reads and mutations use streamed Eve observation and paged checkpoints
for sessions whose installed actions require no prototype receipt readback.
The `start` call stores a provisional empty session; the next read stages its
durable history under that tenant session. Each checkpoint publishes its
manifest with the session pointer in one transaction, leaving the prior
checkpoint usable if staging fails. New hosted HTML previews and design
decisions use tenant-bound immutable chunks once the additive schema is
present. The Browser validates their complete manifest and digest before
streaming HTML. Identical retries of existing v1 artifacts retain their v1
receipts. Valid v1 Markdown AppSpec actions do not require Browser prototype
readback, so they can coexist with a paged v2 HTML session. Incremental Eve
readback also carries a verified legacy HTML prototype into paged metadata;
the Postgres store chunks that metadata, preserving all pending requests and
events without the older 512-event, 32-request, or 512 KiB inline checkpoint
bounds. Same-session adapter replacement stages its new history and publishes
the adapter generation and checkpoint pointer in one transaction. The old
checkpoint remains active if staging, digest verification, or publication
fails. Unresolved or malformed legacy HTML actions still use the inline
compatibility checkpoint, which retains those three bounds. The materialized
snapshot validator no longer imposes a 100,000-event ceiling, though that
compatibility path still holds the provider result in memory. Historical
events discarded by an older checkpoint cannot be reconstructed; its
truncation marker remains visible during recovery.

New hosted `app-spec.md` writes use the same immutable v2 chunks as other
prototype artifacts. Acceptance verifies the complete manifest, scans the
canonical headings and terminal handoff incrementally, and saves a versioned
artifact reference, digest, and acceptance walkthrough without a second copy
of the full AppSpec in workflow state. V2 requires canonical LF and the exact
status-only handoff bytes; noncanonical drafts must be rewritten before
acceptance. Existing v1 receipts and accepted snapshots retain their original
normalisation and readback behavior. Planning writes verified chunks through
the sandbox's streamed file API. Independent source review reopens verified
chunks for bounded requirement excerpts against each source page. The public
AppSpec tool readback remains paged by exact digest and revision. See
[the streamed AppSpec contract](app-spec-stream-contract.md).

Automatic provisioning retries cover settled transient failures with a known
outcome and a durable next retry time. An expired in-flight lease with an
uncertain provider write runs a read-only reconciliation first. A verified,
owned GitHub result can settle successfully. Ambiguous GitHub or Vercel results
pause with recovery instructions; a missing resource after an uncertain write
is not treated as authoritative absence. This preserves the no-duplicate
outward-effect rule.

The default hosted GitHub connection, existing-source, and publication source
flows use a provider-verified target proof, so they do not enumerate every
selected repository. Legacy v2 publication proposals and receipts bind the
digest of the complete selected-repository inventory. The provider adapter
deduplicates IDs as pages arrive, but those v2 authority and readback contracts
still retain the full list in memory. Replacing them requires versioned
publication proposals, journal and receipt validation, readback, and existing
draft update support. The emulated test harness also retains v2.

Large hosted HTML and UI-preview content uses the v2 writer, public reference,
tool readback, and authenticated Browser route. The v1 compatibility projector
now consumes events incrementally, but retains the complete HTML required by
its public result. Its bounded checkpoint remains necessary for older sessions.

The post-#515 buffering audit also found whole-result reads in
`captured-process-output.ts` (a compatibility helper that reopens temporary
stdout as a `Buffer`), `node-fresh-bootstrap.ts` (whole-byte compatibility
source and overlay adapters), `node-branch-worktree-publication.ts` (the
contract-shaped proposal changes array and per-directory listing),
`supported-template.ts` and
`arrusted-template.ts` (some source and command reads), and
`same-origin-http.ts` (complete v1 HTML projection). The default fresh-bootstrap
source, overlay, Git tree, Git object, and Git blob paths now stream with digest
and size verification. Publication base-tree, worktree-state, approved-path,
and overlay-byte verification also stream; a digest-only command caller uses
streaming hashing. The remaining
call sites need caller-specific streaming contracts. This is an implementation
inventory, not evidence that those paths are safe at arbitrary size.

The local Preview provider emulator retains an 8 MiB state-document limit
because its persistence adapter loads and parses the state as one JSON value.
It is local test infrastructure, not the hosted Builder source or publication
path. Removing that limit safely requires a paged emulator state format.

Validation command diagnostics remain a separate incomplete path. The sandbox
command API returns complete stdout and stderr as strings, and validation
persists only sanitized matching lines in its receipt. The receipt now marks
that filtering as truncation. Complete sanitized output is not yet retrievable
after the sandbox is released. Closing this gap needs streaming command output,
tenant-scoped durable log chunks, and an authenticated paged read API; removing
the excerpt flag alone would hide lost information.
