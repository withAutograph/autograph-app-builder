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

## Live-writer migration blockers

The staged checkpoint tables are additive and are not a replacement for the
current writer until the Eve adapter streams events into them. The adapter
currently assembles the complete installed event stream in memory. Therefore
the live snapshot still has a 100,000-event validation bound and the legacy
inline checkpoint still retains at most 512 events, 32 pending input requests,
and 512 KiB. Removing those bounds before streaming would expose the hosted
service to resource exhaustion. Historical events already discarded by an
older checkpoint cannot be reconstructed; its truncation marker is retained
and shown during recovery.

The staged history helper currently requires an existing tenant session row.
The live `start` path settles a new session and operation together, so its
integration must stage under a reserved session identity and publish the
checkpoint pointer in that same settlement transaction. This ordering must be
tested before enabling the paged writer.

Automatic provisioning retries cover settled transient failures with a known
outcome and a durable next retry time. An expired in-flight lease with an
uncertain provider write runs a read-only reconciliation first. A verified,
owned GitHub result can settle successfully. Ambiguous GitHub or Vercel results
pause with recovery instructions; a missing resource after an uncertain write
is not treated as authoritative absence. This preserves the no-duplicate
outward-effect rule.

The default hosted GitHub connection, existing-source, and publication source
flows use a provider-verified target proof, so they do not enumerate every
selected repository. Legacy provider adapters and v2 receipts retain their
full-inventory compatibility path. The emulated test harness also retains v2.

Large prototype and UI-preview content is transferred in verified chunks, but
the installed Eve event readback and some artifact projections still assemble
complete content in memory. Those paths require streaming readers and a
bounded projection before the remaining checkpoint caps can be removed.

The post-#515 buffering audit also found whole-result reads in
`captured-process-output.ts` (temporary stdout reopened as a `Buffer`),
`node-fresh-bootstrap.ts` (some blob, command-output, and Git-index reads),
`node-branch-worktree-publication.ts` (some file and Git-output reads),
`supported-template.ts` and `arrusted-template.ts` (some source and command
reads), and `same-origin-http.ts` (complete Eve event array). A digest-only
caller now uses streaming hashing, but these remaining call sites still need
caller-specific streaming contracts. The file paths are an implementation
inventory, not evidence that the remaining paths are safe at arbitrary size.

The local Preview provider emulator retains an 8 MiB state-document limit
because its persistence adapter loads and parses the state as one JSON value.
It is local test infrastructure, not the hosted Builder source or publication
path. Removing that limit safely requires a paged emulator state format.
