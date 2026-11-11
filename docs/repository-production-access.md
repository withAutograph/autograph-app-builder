# Builder-owned access for an existing Production repository

Normal delivery into an existing repository uses the protected
`/v1/repository-production` endpoint. It does not need a prepared synthetic
runtime or an isolated Preview enrollment. The older Preview operations keep
their existing contracts.

Builder uses `REPOSITORY_PRODUCTION_OPERATOR_URL` for this endpoint. The
existing `HOSTED_RUNTIME_OPERATOR_URL` continues to identify the historical
Preview operator; a Production rollout does not redirect or reconfigure that
operator. Both Production ingress paths are explicitly routed by the native
operator service, including `/v1/repository-production/access/complete`.

Production runtime binding accepts Vercel's integration configuration metadata
only when it names the same configured installation whose tenant-bound credential
performs the request. Legacy rows without configuration metadata remain supported.
Both list and detail readback still require the exact app key, operation ownership,
Production scope, recorded row identity and dispatch checkpoint; the value hash
must match before setup reports ready. A foreign installation's row is never
adopted or overwritten, even if its key and operation comment match.

The deployment owns `REPOSITORY_PRODUCTION_CONFIGURATION`. It identifies the
Builder and operator Production workloads, fixed installer workers, managed
Neon connection, protected Vercel credential binding, and authorized mappings
from a Builder workspace and repository to an organization, native app project,
public origin, and shared Auth resource. A mapping covers every app in that
repository; creators do not provide database IDs or connection strings.

Each repository can instead select an explicit deployment-managed Production
connection in its configuration entry:

```json
{
  "authOperatorRole": "arrusted_app_access_operator",
  "connection": {
    "kind": "deployment-secrets",
    "maintenanceUrlEnvironment": "ARRUSTED_PRODUCTION_MAINTENANCE_URL",
    "authOperatorEnvironment": "ARRUSTED_PRODUCTION_AUTH_OPERATOR_URL",
    "authRuntimeEnvironment": "ARRUSTED_PRODUCTION_AUTH_RUNTIME_URL"
  }
}
```

These fields name environment variables on the protected Production operator;
they never contain URL values. The platform operator binds the three approved
direct Neon credentials there. The shared Auth operator and runtime bindings
must use their distinct configured roles, and the maintenance binding must use
the configured maintenance database and role. Current Production OIDC remains
required. Every URL must match the configured direct endpoint, database, role
and TLS policy; read-only SQL verifies the actual database and role before any
worker receives credentials. Connection values and driver error details stay
private. This path does not reuse a synthetic Preview connector or credential.
Automatic invitation callbacks first read exact durable enrollment completion
before starting the short background-work response budget. An applied invitation
and enrollment with its bound actor, or an applied creator setup with its bound
creator frame, can acknowledge completion using fresh canonical owner/workspace,
configured destination, saved intent/approval and pending-operation checks alone.
This read-only acknowledgement loads no release capture, takes no lease, writes
nothing and never proves current app permissions; Gateway access remains fresh.
Pending removal, role change or cancellation for that actor/invitation stays
pending without replaying enrollment. Unknown completion continues normally.

Incomplete callbacks try the existing nonblocking physical app slot before
resolving the full capture. Busy callbacks return pending without repeating that
content work. Current owner, setup approval and pending-operation boundaries are
still checked under the held slot before lease writes or any access effect.

Within a single protected request, management may reuse a fully verified immutable
generated-release capture after rereading the exact current selection and its
release/manifest binding. Reuse is bound to the complete app/session authority,
physical owner generation and exact artifact, release, manifest and schema hashes.
It never caches owner authorization, setup approval, saved intent, role or pending
operation checks. Every reuse checks current ownership before and after awaiting
content; rejected reads are evicted. Returned Buffers and descriptions are isolated
copies. Separate requests share no capture state and introduce no positive TTL.

Connection diagnostics also record only fixed authority, OIDC and SQL-identity
phase names, started/completed/failed state and nonnegative elapsed milliseconds.
Clock or logging failures do not affect the original result, error or cancellation;
no connection values, identifiers, provider payloads or error text enter timings.

Internal failure diagnostics distinguish authority, workload OIDC, each connection
binding and SQL identity, encrypted credential decoding and Sandbox creation.
Setup preparation (including the physical lease and reconciliation) and the final
access projection have separate failure phases. Diagnostics retain only fixed
phase/code/reason labels, allowlisted SQLSTATEs and numeric HTTP status. Reasons
classify exact known setup/lease failures and schema-invalid results through own
data properties; arbitrary text, inherited values, accessors and causes are never
serialized. Diagnostics cannot change exceptions, authorization, retries, journal
reconciliation or public responses. Existing typed operator codes and built-in
error kinds remain closed labels; wrapped driver failures contribute only an
allowlisted SQLSTATE through at most four own-data cause nodes. Preparation may
record the request's aborted boolean. Fixed started/completed progress for
connection reads and worker input assembly distinguishes successful phases from
later failures without recording inputs, credentials or exception content.
Production transport failures also retain the existing launcher's last closed
stage, such as worker pin verification, protocol handling or cleanup. This is
stage metadata after the original cleanup, not proof that a provider effect
occurred; the original rejection, authority and cancellation remain unchanged.
People read and mutation failures record only closed web owner/read/recheck,
operator token/transport/projection, protected scope/People, command authority,
lease, journal, reconciliation and execution stages, plus numeric failed
operator HTTP status. Exact source-unavailable and capture-unavailable exceptions have distinct closed
reasons. Known app-access error codes are a separate allowlisted field alongside
existing operator codes, SQLSTATEs and built-in error kinds. These diagnostics
preserve the sanitized response and never include request identities, emails,
provider bodies, URLs, credentials or raw errors.
They observe failures without retrying, allocating an operation or changing the
saved command identity; absent logs do not prove that an invitation was unsent.
Storage setup emits the resource worker's canonical bootstrap envelope before
hashing its authority context, including the canonical resource field order.
The first fence request must bind the same context digest for both execution and
readback; this does not change resource, approval, credential or tenant values.

Production requires an explicit `authOperatorRole` distinct from the Auth schema
owner (`authResource.migratorRole`) and runtime role. Its restricted permissions
support managed invitations, existing-organization membership and app access;
the platform operator prepares the schema and grants separately. Builder does
not persist or pass an Auth schema-owner connection to app setup/access workers.
Separate platform schema maintenance privately resolves its enrolled owner secret
through the protected Auth schema rollout service.
The full approved worker plan binds `authOperatorRole`; generated access
workers receive `authOperator` beside the app and Auth runtime connections.
The Auth resource, realm digest and schema-owner descriptors stay unchanged.
Workers verify the exact login and required restricted permissions before
effects. A schema-owner or runtime URL in the operator binding is rejected.

The existing top-level managed Connect configuration remains supported for
repositories without a per-repository connection. It can be omitted when every
repository has an explicit deployment binding. An invalid or missing selected
binding stops setup; it never falls back to another credential. App creators
continue to provide only the repository and ordinary app requirements.
Managed Connect also obtains the distinct configured operator role, never the
Auth schema owner. Historical Preview configuration remains separate.

The operator independently reads the canonical Builder owner and saved
repository choice, including recovered session lineage. An acquired repository
and a publication destination are separate authorities: a new app built from a
fresh template can use its owner/session/app/spec-bound compiled release's
verified `publishedSource.repositoryId`. The operator resolves that identity
through the exact configured workspace mapping. It does not change the acquired
source. An authenticated existing-repository selection stored in the session’s
`builderDestination` is retained independently of source acquisition or new-resource
provisioning. Production checks that selection against the published app repository
and configured workspace profile; it does not create a new project or infer a
repository from an app name. If an acquired repository is also present, all
repository identities must agree. Missing, foreign, or ambiguous destinations do not authorize setup;
a configured profile alone is insufficient. Frontend-only apps retain the same trusted publication destination through a
generic owner/session/app/spec marker in the existing artifact store; they do
not need a SQL release or source acquisition. Normal publication and retained
reconciliation completion record the marker only after provider success. A
historical static publication can resume that same approved completion to
record its destination. An initial publication may return its retained success
without re-reading the current GitHub head. Its receipt may select the current
workflow's new publication branch, including recovery after a failed first marker
write, but cannot replace a newer recorded head on that same branch. The
publication tool already rejects proposals that no longer match its current
reviewed workflow. A receipt for an already reconciled branch remains available
for exact historical lookup without replacing the selected revision. Publication branches are bound to the sealed proposal's
idempotency key; this does not inspect Git ancestry or select a deployment.
Update and reconciliation completions use their existing fresh provider head
observation to advance the selection. Replaying an already recorded call never
promotes it. Both stores decide whether the receipt is historical inside their
serialized marker write, including concurrent first recording.
Acquired frontend-only apps also retain their existing repository path.

App descriptions and compiled releases come from owner-scoped captured artifacts. The normal plan
operation returns the app's resource and access intent; preparation reads the
actual approval from Builder's private history. A caller-supplied approval ID
alone is insufficient. Source hashes remain diagnostics; the reviewed resource,
schema, organization and role effects determine approval identity.

People, saved setup status and retry resolve the unique approved setup belonging
to the live canonical app owner and original session. A newer private draft does
not replace its scope, roles, database or approved release. Persistent apps read
the exact retained artifact, release and manifest already saved in that setup;
optional publication metadata is not another management gate. Live ownership,
workspace membership, approval and physical fences remain required. New setup
and revision planning still resolve their own reviewed publication destination.
Exact retained-selection queries parse JSON inside the selection-path guard, so
unrelated prototype HTML cannot break the read when PostgreSQL reorders filters.
Frontend-only management allocates no database. A verified current published
description in the same saved scope may supply its routing hint; without one,
People and retry omit Open app, and invitation creation reports the existing
service issue instead of inventing a destination.

For a persistent app, setup records its owned database, roles, and encrypted
credentials in the existing provisioning journal before any provider write.
It allocates the database, prepares and verifies the creator's one-time Auth
identity, installs the checked schema, grants creator membership and app roles,
and binds only that app's encrypted Production runtime variable. Initial schema
installation includes that verified actor in the approved tenant partition; it
does not grant Auth assignment or database actor membership. Later schema
revisions retain the existing runtime scope instead of replaying creator access,
and a revoked scope remains revoked. An interrupted initial schema attempt still
shows the saved sign-in link when identity is required, before reconciliation
continues against the same allocated database. Frontend-only apps use shared Auth and skip app storage. The current captured
description has no explicit anonymous-access contract, so this path defaults
to private access; it does not infer public access from a static backend.
The native deployment provider continues to own deployment and activation.
There is no external product-test or synthetic-data release requirement here.

The creator receives a Builder-managed, one-time invitation. The normal Production
plan accepts an optional `creatorEmail`, includes it in setup consent, and carries
it through protected preparation. Without an explicit choice, an already verified
same-owner account in the same Auth realm is reused with its actual source
invitation email; otherwise delivery defaults to the verified Builder account.
The People page shows the saved account and can choose another email before any
Auth invitation, actor or access grant exists. That authenticated owner command
is delivery intent only. Email never substitutes for the real Auth actor and
verified session returned through the existing callback. Explicitly choosing a
different account cannot borrow another linked account's identity.

A recipient choice is checkpointed under the existing app lock and original
operation. An uncreated historical creator frame can recover through this normal
command after authoritative Auth absence is read back. Its original frame,
database, credentials, approved resource intent and selected destination stay
intact. A lost command reply reuses its request identity. Existing invitations,
actors and grants cannot be replaced; uncertain reads or create dispatches remain
locked to their recorded recipient. New create dispatch is recorded before the
provider write. The existing fixed invitation identity and create-conflict checks
continue to prevent overwriting a concurrently created invitation.

A retained frame without an actual Auth invitation exposes no sign-in URL. Builder
shows Retry setup and resumes the same operation; a generic unauthenticated Auth
page is not evidence that a message was sent. The authenticated callback resumes
the original Builder setup. It grants organization membership only at member
level, plus the app's reviewed roles. Creator access and subsequent invitations
use the same protected Auth and generated-data workers.

Shared Auth invitation and organization-membership workers use `app_id: auth`
with no app `tenant_targets`, and their authorized effect frames use a null
tenant. The target app and organization remain bound in the hashed approved
`authAppAccess.scope` or `authMembership` plan. App schema and access workers
retain their selected organization in `tenant_targets`.

Setup, access changes, and callbacks share one physical lock per repository and
app. Worker effects carry a positive durable fencing generation and are
checkpointed before dispatch. Interrupted writes are read back before retry;
uncertain results remain pending. Revisions retain the database and credentials.
A source-only commit change retains the same setup effects, status, and sign-in
continuation; it does not reinstall the schema or rebind credentials. Setup still
reconciles changed storage, schema, access, and owner-session bindings.
After the initial creator grant finishes, setup never regrants it automatically:
People-page revocations and role changes remain authoritative. When a new
reviewed schema changes creator roles, an existing active creator is updated
through the normal access-management journal under the same app lock. Removed
creators stay removed. Interrupted role updates retain their active preimage
and command identity; conflicting new People commands wait for reconciliation.

When a frontend-only app adds PostgreSQL storage, setup snapshots its active
members under that same app lock after installing the schema. Existing People
operations copy each compatible assignment into the new database with the
same roles, including role-less admission when the app still has no business
roles. Removed users are absent from the snapshot; incompatible roles are never
mapped to broader roles. A separately reviewed creator role change uses the
existing creator-role continuation. Saved per-member request identities survive
interruption so a retry neither enrolls a new actor nor repeats a completed grant.

The runtime binding cannot adopt or overwrite an unrelated existing variable.
Persistent apps bind their plain `<APP>_APP_BOUNDARY` alongside their encrypted
database variable. The app prefix is its uppercase ID with hyphens replaced by
underscores. Public verifier facts reuse the approved Gateway origin/JWKS
projection; runtime facts come from the configured endpoint and saved owned
database/role, independently matched to the restricted credential being bound.
Passwords and migrator details are excluded.
Both variables retain their own dispatch checkpoint and exact owned readback.
An older credential-only receipt resumes only runtime binding to add the missing
metadata, retaining completed schema, resources and access. Status and automatic
completion share that readiness check. Frontend-only apps stay on shared Auth
without allocating storage or fabricating a database boundary.
An earlier delivery path's existing database must be reconciled to its original
ownership before enabling this path for that app. A response lost after binding
creation can be recovered from the owned provider record and expected value.
The provider list must prove the exact owned row, encrypted Production-only scope
and recorded dispatch before its value is read back. [Decrypted detail responses](https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id)
require the key, encrypted type and exact expected value hash; optional identity,
owner or environment metadata must agree when present. Missing values and an
explicit `decrypted: false` never prove a binding. Internal fixed-phase diagnostics
separate list, detail and write HTTP failures from detail grammar, ownership and
value mismatches, without recording provider bodies, validation inputs, URLs,
credentials or values. Reconciliation reuses the existing owned row; it does not
rewrite a conflicting or uncertain variable.

Protected worker failures retain their existing closed lifecycle failure code in
the internal Production diagnostic, together with the fixed operation family and
read-only flag. These distinguish startup rejection from an effect failure and
Auth inspection from access mutation without recording operation IDs, worker
output, SQL, credentials or exception text. Logging does not change the original
failure, cleanup, approval or retry behavior.

The People page and public delivery tools use the same endpoint. Ordinary
invitation completion accepts only an invitation ID from the authorized Auth
workload, reads the stored inviter and verified invitee, and rechecks current
ownership. Neither an email match nor the invitee's possession of a Creator
Builder session is required or sufficient.

People projection overlaps only independent protected read-only workers: creator
invitation with creator membership, and app members with app invitations. Every
read retains its existing scope, owner, fence and lease checks. Both workers
settle before request resources or the shared lease are released; a rejection
preserves the original error and first-read priority. Access writes and their
required ordering remain serialized.

An accepted invitation whose enrollment acknowledgement was interrupted is
reconciled without replaying membership, grant or acceptance writes. The protected
Production adapter reads current Auth membership and app grants plus the owned
app runtime's actor bindings through `kernel_read_actor_binding`. The exact
actor/app/organization/role tuples must be active with matching positive grant
generations, bounded by the current control lease. A historical grant generation
never replaces that lease's authority. Missing or revoked access stays nonready;
unreadable or conflicting readback stays unknown. Frontend-only apps use current
Auth access without allocating a database, and role-less apps require their
explicit admission. Owner and cancellation checks still precede the journal-only
acknowledgement. This reuses native read-only metadata; it adds no Preview,
worker snapshot, pin or qualification requirement.

An approved self-signup policy uses the same app lock and access workers. The
signup journal retains the verified actor, policy, session, resource, return URL
and approved roles. A fresh verified session may renew that same claim only when
Auth proves that no grant was ever reserved and no assignment or admission history
exists. Renewal preserves the claim ID and previous tuple/checkpoints, changes
the continuation digest, and gives subsequent worker steps distinct identities.
Missing evidence from older workers never authorizes renewal.

An interrupted reserved grant remains unknown until readback proves its outcome.
Current authority can observe a complete grant at its original recorded generation
without replaying writes, even after its signup session expires or signup is
disabled. This checks positive Auth admission and, for persistent apps, the exact
kernel binding. Empty approved roles are valid only for apps whose generated
catalog declares no business roles; named-role apps retain their existing guard.

The owner's existing People removal can close one interrupted signup under a
fresh app lease. It freezes the exact actor, claim and roles in both journals,
uses the existing revoke workers, and confirms Auth admission, assignments and
kernel access are closed before rejecting the original signup journal. Unknown
outcomes retain that cancellation target for reconciliation. Every other pending
signup continues to block conflicting mutations; cancellation never renews or
regrants the claim.

Automatic Auth callbacks try the same physical PostgreSQL transaction lock
without waiting. A callback returns pending when another continuation holds the
app slot, before starting another Auth worker or setup reconciliation. Explicit
owner commands retain their normal serialized lock. The operator keeps the one
authorized continuation and its database connection alive for the invocation;
the Auth page polls the same invitation. A later callback resumes from the
existing journal when the slot is free. Once the verified invitation and current
authorized setup status are ready, completion returns that status without
replaying completed setup effects or restoring removed access.

Normal delivery tools are `plan-app-production`, `prepare-app-production` and
`get-app-production`. Planning resolves the saved destination and captured app
description without provider writes. The preparation approval covers data and
access setup. Code publication, Ready, and merge remain tied to the reviewed
revision through the existing delivery flow. Setup status does not claim that
the native deployment is active or that app behavior has been tested.

The normal planning result supplies a server-derived version-two
`approvalReference` and `nextCall`. The model passes that compact input unchanged;
it does not copy the database release checksum, captured artifact reference or
resource configuration into preparation. The reference binds the app, repository,
operation, setup-effect digest and displayed access/account selection. The
protected service resolves the current owner-scoped captured release and app
description again, compares the reference, and observes the exact native request
and creator settlement before retaining approval or running setup. Changed
schema, repository, organization or access effects need a current approval;
source-only revisions retain the same effects and storage. No additional plan
store or provider operation is introduced. Legacy full-plan preparation and the
protected `plan`/status response shapes remain supported without treating an
invalid full plan as a reference. The reference is review input, never consent.

For a managed existing-repository destination, publish the reviewed draft first,
then finish required normal data/access/runtime binding setup before the approved
merge triggers native Production delivery. Vercel project environment writes do
not update a deployment already created without those variables. The internal
`delivery-status` read on the existing protected endpoint binds the canonical
owner, saved app and reviewed repository identity. It projects existing setup
journal/effect and runtime-binding receipt readiness without launching People or
Auth workers, acquiring an effect lease, changing resources, or testing the app.

A source-only revision in a new session can use the completed setup for the
same canonical owner, app, and configured Production destination. The
operator compares the published capture at the reviewed GitHub head with the
saved approved setup effects, including the checked release, creator access
and roles. The original setup remains the owner of its database and runtime
binding. The revision can read readiness and observe availability. Changes to
the approved setup still require the existing setup authority and approval.

`read_github_pr_delivery` returns the normal plan/preparation continuation when
required setup is missing or changed, or the saved status continuation while an
existing setup is progressing. It exposes the existing PR approval once those
requirements are ready. The merge step independently repeats the bound read
immediately before its GitHub merge effect, retaining exact revision, native
approval, required-check and ready-cycle protections. A passing Check alone
cannot merge an app whose required runtime binding is still absent.

For a scoped Arrusted release, the operator can verify the original Build or
release approval against the active owner's saved app and the exact current
setup plan. It independently reads the actual owner decision and reviewed
published source before applying that plan. Existing setup approvals are
accepted through the same ownership and plan checks.

After a managed merge, the read-only `native-status` action observes the
current Production app through the saved owner, app and repository binding.
It checks the provider’s current Production deployment and public domain,
then checks the app’s registered route and entry on the Gateway. The read
reports pending activation while the verified public alias still serves the
previous deployment and Vercel is building the selected deployment or explicitly
reports that its ready deployment awaits alias assignment. Required deployment
checks can delay that assignment. The result
describes current availability and may include the app’s public entry URL.
The delivery of the requested revision remains unassessed. The completed merge
is independent of these observations. The owner can check the same saved app
again through `observe-app-production`, including when no current build is
running.

An authoritative configured-service response may classify an unrelated repository
as unmanaged. A GitHub-only deployment with no managed operator capability keeps
its generic flow; authorization/transport/unknown failures never mean unmanaged.
After the session observes a managed requirement or obtains a normal setup plan,
it retains that fact so losing the endpoint/profile cannot bypass preparation.
Frontend-only apps keep `storage:none`; their applicable shared Auth setup never
allocates a business database. Source-only revisions reuse the same completed
setup and data; actual schema, role or access changes use existing preparation.

If an older merge preceded its runtime bindings, recover in the same Builder
session through the ordinary reviewed app repair/revision and provider-owned
native Git delivery. Preserve its destination, database, records and setup.
This adds no manual deployment, promotion, alias writer, synthetic runtime,
external qualification or mandatory app-test gate.

A missing saved destination is reported explicitly. Failed plan and status reads
do not claim that setup was started or saved by that read. An uncertain
preparation still requires status reconciliation before any retry.
