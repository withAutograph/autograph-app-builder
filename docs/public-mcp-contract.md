# Public MCP contract

Autograph App Builder exposes one Streamable HTTP MCP endpoint at `/mcp`.
Discovery returns exactly these five tools:

| Public tool         | Internal service operation                     |
| ------------------- | ---------------------------------------------- |
| `autograph_start`   | `EveSessionService.start` or checkpoint resume |
| `autograph_get`     | `EveSessionService.list` or `get`              |
| `autograph_send`    | `EveSessionService.send`                       |
| `autograph_respond` | `EveSessionService.respond`                    |
| `autograph_cancel`  | `EveSessionService.cancel`                     |

The public names are a closed registry, not aliases. The endpoint does not
register the internal runtime's tool names, and there is no versioned or
compatibility endpoint.

All five tools use the existing session schemas and the same request-scoped
service implementation. That shared implementation owns durable session IDs,
cursor pagination, sanitized errors, complete approval-batch validation,
tenant and audience isolation, idempotent mutation retries, unknown-submission
handling, lost-response recovery, and cooperative cancellation settlement.
The internal Eve routes, adapter session identifiers, storage records, and
transport protocol remain implementation details.

`autograph_get` without `sessionId` or `clientRequestId` returns a tenant-scoped
paginated recent session index. With `sessionId`, it retains absolute-cursor
event pagination. With the original start's `clientRequestId`, it
reads only that start operation for the exact issuer, audience, workspace, and
user, and returns the saved session's current progress. The two lookup fields
are mutually exclusive. This read never resubmits the start. An unresolved
submission directs the caller to preserve the original ID and input for an
exact retry; an unknown result must not lead to a replacement start ID.
This covers prompt, prepared handoff, and resume starts. Prepared handoffs save
an original-request alias to their canonical start before dispatch; distinct
original request IDs for one handoff recover the same bound session. Healthy
resumes save a receipt for the existing handle. Checkpoint and adapter-recovery
resumes retain their durable operation receipt. Older handoffs whose original
ID was never saved require an exact original start retry to establish the alias.
The alias uses the existing caller-scoped operation journal, so no SQL migration
is required. Deploy its closed-record reader with its writer; older readers do
not accept the added alias field. No historical original IDs are fabricated.
If the durable Eve stream cannot be read within 30 seconds, `autograph_get`
returns the last saved checkpoint with `session_read_delayed`, identifies it as
stale, and instructs the caller to retry the same session and cursor. A delayed
read does not declare the build failed and never exposes checkpoint approval
controls. After an accepted `autograph_respond` whose settlement cannot be
observed within 30 seconds, Builder reports `submission_unknown`; callers must
read the same session before taking further action and must not replay that
response.
Unknown hosted submissions emit server-only `[builder:hosted-submission]`
diagnostics with the failing lookup, reservation, transport, settlement, or
recovery phase. SHA-256 hashes of the original request, operation, and observed
adapter IDs correlate logs without exposing their values. Only allowlisted
SQLSTATE codes and fixed categories are recorded; prompts, caller identities,
URLs, SQL, credentials, and arbitrary error text are excluded. A candidate
adapter hash in a transport confirmation failure does not prove ownership.
These logs are observations, not receipts or permission to replay. A missing
storage schema must be verified against the exact deployed database before an
operator separately approves any migration.
`autograph_start` accepts exactly one of a new prompt, an opaque `handoffId`,
or `resumeSessionId`.
Healthy active sessions retain their public handle. A terminal or interrupted
session resumes from its last durable checkpoint as a child session, while a
missing adapter for otherwise-active work is fenced by adapter generation before
the same public handle continues. User-visible sessions do not expire with
their short-lived compute leases.

Local development has a narrower recovery boundary. A missing local stream or
Eve's explicit inactive-session rejection returns `session_recovery_unavailable`,
preserves the original public identity and any buffered progress, and removes
approval controls. The operator must restore the original development workflow
state or report that run as blocked; it does not start a replacement request.
The local snapshot API proves retained history, not worker liveness. See the
[local lifecycle](local-development-lifecycle.md#interrupted-public-sessions).

New hosted checkpoints store the complete public history in tenant-scoped,
digest-verified pages and publish a versioned manifest only after its chunks
are durable. Page size bounds one operation, not total history. Older inline
checkpoints and legacy HTML compatibility paths retain their historical
ceilings; recovery reports their truncation marker and preserves exact
outstanding requests. Events already discarded by an older writer cannot be
reconstructed. See the [limit and recovery inventory](builder-build-limits-inventory.md)
for the remaining compatibility boundaries.

Hosted authorization advertises the matching `autograph:*` scopes. A caller
must hold `autograph:session` before the request-scoped tenant service is
constructed; operation-specific scope checks remain inside the shared service.

Large response batches use one complete direct submission. Oversized resumable
response uploads are deferred; `autograph_respond` has no staging modes. Do not
split a question batch into ordinary response calls: the pinned Eve version can
resolve the batch and mark omitted answers ignored. Preserve the existing
uncertain-submission recovery behavior described above. The
[released-feature findings and transport decision](plans/2026-09-29-resumable-response-transport.md)
assume no new upstream Eve features. Bounded pending-request readback is separate
work and does not solve complete-batch response submission.
