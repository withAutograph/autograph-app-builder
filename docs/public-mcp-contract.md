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
transport protocol remain implementation details. If work finishes before cancellation takes effect, Builder reports the actual
outcome once the session settles.

The [complete-app phases](full-app-authoring.md#build-phases-and-delivery) are
initial version and build approval, build, independent review, and requested
delivery. They do not map one-to-one to public tool calls or model API requests.
Polling through `autograph_get` reads progress; model usage must be attributed
from actual generation attempts rather than public request counts. Ordinary
product answers and effect approvals continue through `autograph_send` and
`autograph_respond` in the saved session. The five tools do not expose private
stage forcing, nor does private build approval authorize deployment or publication.

Production setup projects an ordinary approval card for both database-backed
and frontend-only apps. The card describes the selected app, repository, data
setup and access; it does not itself grant consent. Unreadable setup input remains
closed, and execution still requires the actual owner's settlement for the exact
saved setup call.

App access links retain the browser-requested public build handle after recovery.
The authenticated web service resolves that build's verified lineage to its original
app grant and current physical worker, never the owner's most recent unrelated
build. Protected reads and commands keep that canonical grant/artifact scope;
only the returned browser snapshot uses the requested public handle. The service
rechecks ownership before returning the snapshot.

App account linking is an ordinary browser sign-in, not an approval response.
After approved Production setup requests identity, the public stream includes
`auth_identity_invitation` with the safe sign-in URL and expiry. It exposes no
identity proof, provider credentials, or membership data. `callId` retains the
actual emitting tool call; optional `operationRef` identifies the same Production
setup across prepare and read-status calls. A later successful ready result emits
`auth_identity_invitation_resolved` for that operation, so an unrelated status
result cannot dismiss the invitation. Legacy Preview invitations continue to
correlate by their original `callId`. Cursor replay retains one current invitation
per setup. A read-only Production status call also returns the pending link with
its actual recorded expiry and projects a fresh invitation. This restores account
linking when a saved cursor predates the invitation projection, without another
setup approval or expiry extension. The Auth callback resumes approved setup; the event itself neither
verifies identity nor grants access. The saved app's access page remains available
for expiry renewal and app-scoped People controls.

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
A durable `autograph_send` acknowledgement can precede its native turn start.
With the same current owner, adapter binding, and cancellation revision, a complete
native read at the tail returns normal `working` while that saved feedback waits
to start. `autograph_get` retains this state without another send or an extra
user reply. It does not claim a turn started or settle the SEND receipt; only the
matching stamped native start or boundary can do that. Stop, current input,
terminal state, and a replaced adapter take precedence. Missing acknowledgement,
legacy acknowledgement without a saved cancellation baseline, or incomplete
readback cannot establish this queued state.
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

The existing `autograph_start` tool accepts `resumeMode: "recover"` only with
`resumeSessionId`. This explicit owner request transfers a parked hosted native
approval through the existing structured recovery path. An owner may instead
request `resumeMode: "recover-idle"` for a waiting session with a retained
checkpoint. This separate mode admits only a natively verified inbox wait;
pending approvals still require the original recovery mode. Ordinary resume is
unchanged and discovery still returns five tools. Admission requires the complete
retained checkpoint and independently closed native effect steps across the entire
verified handoff lineage. A source with pending approvals retains those exact
requests. A separately proven idle source resumes into its inbox wait without
starting a model turn or replaying an earlier response. After activation, its new
native stream publishes `session.waiting` so clients can observe that inbox wait;
an unactivated candidate publishes nothing. The server derives this resume phase
from native state and verifies it again after stopping the source;
a public status or stale approval control cannot select it.
Builder fences source mutations. A separate opaque read-only preflight may inspect
running handoff ancestors using the retained activation, checkpoint and inbox
proofs. It cannot boot a child. Builder proves effect closure across the complete
verified lineage, stops each active owner from root to current inbox owner, and
independently verifies an operation-bound native cancellation receipt for every
stopped run. Ancestors confirmed terminal by the initial full-lineage preflight
are observed without stopping them or repeating the entire history scan solely
to skip their stop. A fresh full-lineage preflight still precedes every live stop,
and the final full-lineage preflight rechecks all retained state before adoption.
No retained history or effect checks are omitted. Exact retries reconstruct
partial progress from those native receipts. A newly discovered
handoff refuses adoption until the same operation rechecks and quiesces that
lineage. Only terminal-only collection and reconciliation can boot a successor.
Active, cancelled, or unproven failed effect steps cause refusal before stop or
prevent adoption.
Pending approvals retain their original request identity and authority; an earlier
`submission_unknown` response remains retained and is never implicitly resent.
An idle checkpoint does not prove that an absent approval was allowed, denied,
or cancelled; it cannot settle an uncertain response or manufacture a grant.
Any uncertainty, including a refusal after a stop may have occurred, retains the
operation and source fence for exact retry. A verified pre-effect refusal may
reject recovery without stopping an owner.
An authorized GET for a parked source may run a separate advisory native inspection.
It rechecks exact tenant, owner, adapter generation and cancellation coordinates,
then reports only fixed structural categories and counts. Inspection does not
reserve recovery, stop or start execution, authorize approval, or settle the
unknown response; duplicate observations may share diagnostic work. Local
execution returns `session_recovery_unavailable` for this hosted-only mode.

A recovered execution can fail before emitting its first event. The authenticated
native stream may report `x-eve-native-recovery-boot-status: failed` only after
verifying that exact physical recovery entry, its committed activation and the
absence of a later turn or handoff. Builder accepts this fact only with a matching
stream identity and a complete empty native tail. It reports `failed` without
inventing events, changing cursors or clearing retained effects and history.
Missing or unreadable native metadata never establishes terminal failure. The
owner can then use ordinary terminal recovery without a `resumeMode`; the native
collector must still verify the retained checkpoint and original authority.

Failed hosted builds recover from authoritative native checkpoints and their
actual retained delivery and tool results. Public conversation excerpts do not
restore private workflow state or authorize a replacement build. Recovery keeps
the original app, private workspace, logical native identity, and exact approval
scope. A child has its own public handle and physical execution stream; those
new transport addresses do not rewrite the original grant or source ownership.

Builder rechecks current ownership, membership, and cancellation before reading
private checkpoints and before activating recovered work. The existing resume
operation reserves one recovery, and its durable child receipt is saved before
the child can run tools or a model. An exact retry reads that receipt even after
the child's inbox closes. An unknown submission remains reserved until its
outcome is resolved; a new request ID must not start a second recovery.

Reconciliation uses genuine committed state and retained inputs and outcomes.
A handled model failure can leave a native step marked completed, so a native
failure flag alone cannot locate the recoverable input. An emitted tool result
does not by itself prove that corresponding authored state committed. If an
effect's outcome cannot be reconciled, recovery preserves the evidence and
reports uncertainty without replaying that effect or silently starting from a
text summary. Ordinary app edits, layouts, roles, and dependency changes are
not recovery admission criteria. Focused fixtures exercise Builder ownership,
approval, result retention, cancellation, and retry behavior.

Local development has a narrower recovery boundary. A missing local stream or
Eve's explicit inactive-session rejection returns `session_recovery_unavailable`,
preserves the original public identity and any buffered progress, and removes
approval controls. The operator must restore the original development workflow
state or report that run as blocked; it does not start a replacement request.
The local snapshot API proves retained history, not worker liveness. See the
[local lifecycle](local-development-lifecycle.md#interrupted-public-sessions).

Successful hosted `autograph_send` and `autograph_respond` results return a
bounded event page starting at the absolute public-event position captured
before dispatch. They preserve the full checkpoint and the original operation
receipt; without `observationCursor`, an exact idempotent retry returns that
same settled result. `autograph_send` may include the caller's saved
`observationCursor` to read current progress from that absolute position after
its canonical delivery settles. This field changes only the returned observation;
it does not change mutation identity, send again, resume Stop, or recover work.
Pending or unknown delivery remains unknown. Keep the largest cursor seen for
the same session, preserving every returned event page, and continue with
`autograph_get`. A different session starts with its own cursor.

The embedded MCP approval UI may retain a card after its request has already
resolved in the chat session. After a known pre-dispatch `input_batch_changed`
rejection, the server may recover success only for an all-approval response
batch whose exact request IDs and `approve`/`deny` directions match unique,
owner-scoped hosted approval receipts in the same session. It returns the
current session snapshot without resubmitting the approval. The UI then shows
the normal successful response state. The retained receipt schema currently
covers only the hosted runtime preparation and cleanup approvals
(`prepare-app-hosted-runtime` and `cleanup-app-hosted-runtime`). Missing,
ambiguous, conflicting, or unrelated evidence keeps the original error.
Questions, mixed batches, unknown outcomes, and Build, native-target, or
draft-publication approvals without these exact receipts are not inferred
successful.

New hosted checkpoints store the complete public history in tenant-scoped,
digest-verified pages and publish a versioned manifest only after its chunks
are durable. Database reads and staging writes batch checkpoint items and
chunks while retaining tenant ownership, ordered content verification, and
atomic manifest publication. Page size bounds one operation, not total history.
Older inline checkpoints and legacy HTML compatibility paths retain their historical
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
