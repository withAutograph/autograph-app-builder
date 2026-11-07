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

Production requires an explicit `authOperatorRole` distinct from the Auth schema
owner (`authResource.migratorRole`) and runtime role. Its restricted permissions
support managed invitations, existing-organization membership and app access;
the platform operator prepares the schema and grants separately. Builder does
not persist or pass an Auth schema-owner connection to Production workers.
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
source. If an acquired repository is also present, both repository identities
must agree. Missing, foreign, or ambiguous destinations do not authorize setup;
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

For a persistent app, setup records its owned database, roles, and encrypted
credentials in the existing provisioning journal before any provider write.
It allocates the database, installs the checked schema, prepares creator
membership and app roles, and binds only that app's encrypted Production
runtime variable. Frontend-only apps use shared Auth and skip app storage. The current captured
description has no explicit anonymous-access contract, so this path defaults
to private access; it does not infer public access from a static backend.
The native deployment provider continues to own deployment and activation.
There is no external product-test or synthetic-data release requirement here.

The creator receives a Builder-managed, one-time invitation through the saved
Builder account. Email is a delivery address, never account-linking authority.
The protected Auth service supplies the actual verified actor and session.
After sign-in, its workload-authenticated completion callback resumes the
original Builder setup. It grants organization membership only at member
level, plus the app's reviewed roles. Creator access and subsequent invitations
use the same protected Auth and generated-data workers.

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
An earlier delivery path's existing database must be reconciled to its original
ownership before enabling this path for that app. A response lost after binding
creation can be recovered from the owned provider record and expected value.

The People page and public delivery tools use the same endpoint. Ordinary
invitation completion accepts only an invitation ID from the authorized Auth
workload, reads the stored inviter and verified invitee, and rechecks current
ownership. Neither an email match nor the invitee's possession of a Creator
Builder session is required or sufficient.

The authenticated callback returns pending if setup is still running. The
operator keeps the authorized work and its database connection alive for the
invocation. The Auth page continues polling the same invitation. If the
invocation ends before setup finishes, the next callback resumes from the
existing journal and lock.

Normal delivery tools are `plan-app-production`, `prepare-app-production` and
`get-app-production`. Planning resolves the saved destination and captured app
description without provider writes. The preparation approval covers data and
access setup. Code publication, Ready, and merge remain tied to the reviewed
revision through the existing delivery flow. Setup status does not claim that
the native deployment is active or that app behavior has been tested.

A missing saved destination is reported explicitly. Failed plan and status reads
do not claim that setup was started or saved by that read. An uncertain
preparation still requires status reconciliation before any retry.
