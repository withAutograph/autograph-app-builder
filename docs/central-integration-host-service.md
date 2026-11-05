# Central integration setup service

The shared Builder service separates global central setup from app caller
registration. `plan` resolves the current owner, protected profile and reviewed
source through trusted native composition, reserves one immutable plan in the
existing provisioning journal, and performs no provider or database effects.
It never adopts the obsolete protected-Preview onboarding operation.

`prepare` reads complete ordinary native approval for the exact current call,
plan and effect list, then obtains the physical project/resource lease. Global
setup has six ordered effects: resources, schema, deployment receiver,
inspector grant, branch runtime and native Git publication. Caller registration
has one effect and cannot publish or choose a deployment. The five public
Builder controls remain unchanged; these are private native workflow ports.

Each fresh effect gets one durable pending attempt and its original fence
before dispatch. Subsequent calls reconcile pending work read-only; uncertain
outcomes and missing legacy attempt custody cannot authorize replay. A new
physical lease preserves old attempt generations, receipts, per-key accepted
provider IDs and grant before/after hashes. Current owner and lease checks plus
all original approval/cancellation histories are re-read throughout execution.
CAS contention stops the operation visibly instead of repeating effects.

The actual PostgreSQL store uses the same parsed transition guard exercised by
focused tests. Attempted phases never return to idle, applied phases never
regress, approval history and accepted checkpoints cannot be erased or replaced,
and a lower or reused-different lease fence is rejected. New records also
require dependency order, current approved attempts and exact frozen branch
binding keys. Older records keep their original omitted-field meaning; new
execution does not fabricate their missing attempt evidence.

Only the independently authenticated provider-event receiver may populate a
native deployment identity. The service never derives an ID from a branch,
source SHA, list, alias or timestamp. A signed created or ready event can retain
that identity; the mandatory setup observer must independently verify actual
provider readiness, loaded configuration and restricted SQL for that exact ID.
An event alone is insufficient. Caller readiness is separately observed and
retained only when it matches the frozen setup/caller scope.

Private native composition must supply real source/profile/ownership reads,
ordinary approval history, the physical lease, encrypted custody, fixed worker
adapters, scoped provider operations, native Git publication and independent
observation. Missing prerequisites have no synthetic successful default. The
service and store tests use controlled authority/effect ports and establish local
state-machine behavior only, not hosted delivery, authenticated acceptance or
QuickBooks activation.
The ordinary internal tools are `plan-app-central-integrations`,
`prepare-app-central-integrations`, and `read-app-central-integrations`. They use
`/v1/central-integrations` on the protected operator. The public Builder controls
remain unchanged. Preparation presents the complete immutable setup or caller
plan for ordinary Native tool approval; a digest-consistent alternate plan is
rejected against the stored owner-scoped intent before effects.

`createCentralHostApprovalAuthority` reads the authenticated Native history for
that exact tool, current call, app, session and plan. Its durable observation
checkpoint retains the actual Native settlement timestamp and cancellation;
it is a cursor, not independent consent. Partial history cannot authorize an
effect. Historical approvals are re-read through the same authority port.

`createCentralHostDispatcher` requires real owner and service-port composition.
It verifies workload identity before interpreting request identity, checks the
canonical app owner around reads, and exposes closed actionable 409 prerequisites
when the reviewed profile, captured source, central setup, or normal app
destination is absent. Neither the client nor dispatcher supplies a default
profile, readiness receipt, provider credential or deployment. Native entrypoint
mounting and concrete source/profile/worker composition must be supplied by the
operator deployment before these tools can run successfully; these source checks
are not hosted acceptance evidence.
New native central setup profiles explicitly select
`isolated-central-integrations-v1` with exactly `gateway` and `integrations`.
The approved branch settings include the literal `AUTOGRAPH_DEPLOYMENT_PROFILE`
and the public runtime manifest declares the same mode. The source plan freezes
`buildReceiptSha256`, the genuine source-owned build receipt, alongside the
reviewed source SHA, compiled Services graph hash and fixed worker byte hashes.
The read-only capture worker must verify these facts before effects and again
before Git publication. Missing captured facts are a source prerequisite.
Omitted mode/receipt fields on an older v1 intent keep their original meaning;
they never silently become the new two-service machine profile.
The request-scoped native operator mounts `/v1/central-integrations` with the
same canonical app ownership and ordinary Native consent reader as other
Builder effects. Its default factory composes the private profile/custody,
existing PostgreSQL journal, physical leases, fixed source/resource/schema
workers, provider adapter, and one reviewed Git branch publication. It also
forwards the existing public-release and optional-capability handlers; loading
an optional handler alone cannot complete the public dispatch path.

The deployment-owned profile must supply a dedicated isolated central target.
Before offering setup or executing any effect, the provider reads inherited
Preview environment metadata and refuses unrelated keys. It never deletes,
shadows, or replaces shared project settings. Missing profile/source facts are
explicit prerequisites. The approved build setting is
`AUTOGRAPH_DEPLOYMENT_PROFILE=isolated-central-integrations-v1`; it is separate
from the ten-key private runtime fingerprint. The full binding manifest includes
that setting and the public central configuration.

New-plan freezing first reads the owner-scoped GitHub installation, exact repository,
reviewed commit and operation-branch absence. Branch absence is only a planning
observation; publication rechecks it and never adopts a preexisting branch.
Source capture independently verifies the pinned archive receipt, exact source
bytes, two-Service graph and executable worker hashes before a setup intent is
offered and again before publication. Source publication creates one previously
absent operation branch with the reviewed commit; it never creates a deployment
or changes an alias. A signed provider callback at
`/api/central-integrations/deployment-events/<subscriptionRef>` retains the
accepted native identity. The public Builder callback holds no privileged
operator configuration or provider receiver secret. It bounds the exact raw bytes,
acquires its own fresh Builder Production workload token and relays only to the
configured operator's closed `/v1/central-deployment-events` endpoint. The operator
requires the configured exact Builder Production team/project/environment policy
before bounded envelope parsing, then verifies the singular provider-generated
secret from encrypted custody, exact event/project/branch/source metadata and
owner journal; the receipt confers no consent or readiness. Ready requires independent
readback of that accepted ID and immutable origin, loaded central configuration
and actual restricted SQL state. Pending unknown writes never become retries.

The repository PostgreSQL proof invokes the actual native dispatcher and factory
against its owned disposable restricted-writer database. Only the provider and
fixed-worker transport boundaries are synthetic; it checks frozen planning,
source inspection, private sealing, exact restart replay and revoked-owner
rejection with zero provider writes. This is local source qualification, not
hosted acceptance.
An ordinary existing-app revision may reuse one unchanged canonical READY caller
grant. Planning then returns a read-only READY receipt and its original
`callerSetup` pointer, rather than an old plan presented as a new approval. The
native resolver checks the current revision's normal app/project/provisioning
receipt against that exact original grant and global setup, re-reads both
original Native consents and owners, and independently observes the current
provider grant, accepted deployment and SQL state. It creates no new intent,
approval, or caller journal. Multiple READY candidates or changed scope fail
closed; no newest-row selection is permitted. Capability/release consumers
retain and independently recheck the same canonical pointer.
The ordinary operator composition supplies the real integration-removal adapter
by default. It uses the same live central READY reader and private custody reader
as capability setup, together with the actual database, source worker settings
and environment. Missing setup is a removal prerequisite when removal is used;
it does not silently omit the port or affect releases that do not remove the
capability. An explicit trusted native override remains supported. The worker's
frame guard rechecks only Builder owner, genuine current consent, frozen journal
and held physical lease; it never reenters target SQL while the worker holds its
ordered locks.
