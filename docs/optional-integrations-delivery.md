# App Builder / Autograph optional integrations delivery

This is the App Builder handoff for the shared Arrusted integrations capability,
including Vendor migration and optional generated-app composition. Publishing
this handoff does not authorize implementation, environment provisioning,
permission changes, provider operations or production activation.

Use the existing [optional integration authoring reference](../agent/skills/create-app/references/optional-integrations.md)
for executable app definitions, typed recipe bindings, the configured server
host, `install-app-integrations`, and the standard/embedded component. Use the
selected Arrusted checkout's `docs/integrations/optional-app-integrations.md`
for the authoritative operating sequence, migration prerequisites, owner roles,
validation and recovery procedures. The source baseline is tracked in
[Arrusted PR #1598](https://github.com/withAutograph/arrusted-development/pull/1598).
This handoff does not define a second control-plane or schema contract.

## Current evidence — 2026-10-28

[Builder PR #784](https://github.com/withAutograph/autograph-app-builder/pull/784)
merged on October 27 at `22:39:43Z`, as commit
`9416113d7506f21ac5450abc83b08978b4f47dfe`. Its final head was
`6023e9407dea86037b850245277cb3d874868985`.
[CI run 40595013466](https://github.com/withAutograph/autograph-app-builder/actions/runs/40595013466)
passed every executed job; Vercel proof was skipped for the PR. The reported
Preview status was Ready. Neither CI nor that status establishes authenticated
provider behavior or a completed public Builder journey.

[Arrusted PR #1598](https://github.com/withAutograph/arrusted-development/pull/1598)
merged on October 27 at `22:20:45Z`, as commit
`9c03def23a5ffa428c56edeeccc53345bf0d7b7d`. Its final head was
`e2fee31d91a3363e5931004d69faf1e840402d65`, with passing
[CI run 40582097399](https://github.com/withAutograph/arrusted-development/actions/runs/40582097399).
These merged implementation PRs are not active publication targets for this
recovered documentation; the handoff is a follow-up documentation change.

The former Gateway Trusted Sources blocker is superseded. The merged delivery
configuration disables Git-triggered deployments for the dedicated Gateway
project root using `git.deploymentEnabled: false`; root and apps Git delivery
remain enabled. No new Gateway permission request is needed for this handoff.
That delivery configuration is separate from provider/runtime readiness.

The implementation session recorded tests of installer-emitted standard and
embedded pages with a synthetic host, plus PostgreSQL isolation and replay
tests. These are local/source evidence, not a normal public Builder session or
authenticated hosted provider proof. This documentation update reruns neither
those tests nor provider operations. Its documentation changes are not covered
by the implementation CI runs above.

## Ordered handoff

| Step                                 | Owner                                                            | Prerequisite, action and exit evidence                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Select the merged source          | Delivery coordinator and both repository owners                  | The implementation PRs are merged. Confirm the selected Builder/Arrusted source includes them and use the current checked app release. Publish this recovered handoff through its follow-up documentation PR; source publication does not activate a provider.                                                                                                                                                                      |
| 2. Establish runtime readiness       | Platform integration owner, database operator and provider owner | Supply the real central host, protected authentication/configuration, exact provider identity inspection, binding leases and restricted service actor. Bind QuickBooks/Xero to their shared read/setup/installation adapters. Ramp still needs its distinct proxy-sync host and is deferred from the recommended pilot. Record unavailable capabilities explicitly; a typed recipe is not a deployed host.                          |
| 3. Qualify the shared path           | Vendor/provider and acceptance owners                            | Follow Arrusted's fenced migration sequence and prove one connection serving two apps independently. Adoption creates an active binding: fence and drain the old writer before adoption, then verify the checked release supports protected `actor_kind: "service"` membership and current authorization before resuming. The shared resolver is generic; integration recipes do not define another actor kind or schema authority. |
| 4. Request the new app normally      | Product requester and public acceptance owner                    | Submit an ordinary product brief requesting supported provider data and an optional standard Integrations page. The brief describes product intent and authority, not evaluator implementation instructions. Retain the public session and ordinary question/approval replies.                                                                                                                                                      |
| 5. Let Builder compose and validate  | Builder workflow owner                                           | The ordinary workflow uses typed app definitions and the repository-owned installer after private build approval. It validates generated app behavior and supplies the real app DAL/host. A page, installed receipt or successful setup callback does not prove activation or canonical ingestion.                                                                                                                                  |
| 6. Exercise an existing-app revision | Public acceptance owner and app owner                            | In a separate saved public revision session, request embedding the same component in an existing page and select whether navigation/standard page is wanted. Verify that existing app-owned content is preserved. Also exercise an app that did not request integrations.                                                                                                                                                           |
| 7. Decide release readiness          | Coordinator, acceptance owner and environment approver           | Review independent database readback, UI states, isolation, revocation, replay and recovery evidence. Authorize any provider/production expansion separately. Close only issue acceptance that actually passed; source CI and this handoff do not establish rollout completion.                                                                                                                                                     |

The merged source supplies shared mechanics, not a configured deployment host.
The host must bind the existing authentication/DAL, central authority, protected
service identity, exact provider inspection and canonical-write lease. Shared
read/setup/installation support exists for QuickBooks/Xero; Ramp normalization
alone does not supply its proxy transport or sync host. Builder must report a
missing host as unavailable instead of inventing an application backend.

The central authority precedes app activation; proven host/recipe availability
precedes claims of public Builder success. Publication, environment preparation
and runtime activation are distinct decisions. Git/PR identities above record
evidence and do not select provider deployments.

## Public acceptance and recovery

Follow [full-app authoring](full-app-authoring.md), the
[public MCP contract](public-mcp-contract.md), and the public-driver discipline
in [self-reproduction evidence](evals/self-reproduction.md). Use the normal web
product or public MCP surface. For this capability, use an integrations product
brief and a separate existing-app revision brief; do not claim full App Builder
self-reproduction from these two narrower journeys.

Preserve session IDs, request IDs, cursors, replies and approval records. The
evaluator observes the workflow and independently reads its result; it does not
invoke internal Eve stages, prepare the implementation for Builder, repair a
backend manually or silently replace a failed session. A missing configured
host is a capability blocker; missing functionality in a supposedly supported
generated result is a failure. Report passed, failed, blocked and unassessed
requirements separately.

Verify the optional standard page and embedded component use the same shared
implementation, preserve desktop resizing and partial-failure states, and grant
no authority through presentation filters. Verify a non-opted-in app gains no
integration routes, sync jobs or integration UI behavior. Provider activation
and test writes require their own scoped authority. Authenticated canonical
record/provenance/history readback is separate from a screenshot or HTTP 200.

If composition fails, retain the app's existing files and saved public session,
report the actual installer/validation error, and let the ordinary workflow
perform an authorized repair. Do not generate a replacement integration backend
or fake success. If provider activation or ingestion fails, keep admission
blocked and hand recovery to the Arrusted runbook's platform/provider owner.
Application rollback does not undo database migrations, canonical writes or
shared provider effects; preserve the observed installed release and data.

### A-469 normal Builder acceptance

Follow the accepted [local-first execution decision](plans/2026-11-03-a469-normal-builder-public-delivery.md)
before implementation and hosted continuation. Its milestones remain unproved
until their named behavior is observed.

Continue the saved generated app through the public product. Resolve its accepted
repository and normal provisioning result first; reuse its independently verified
project, or let normal Create App provision its standard `apps-<app-id>` Services
project. Use that one project for Auth, app Services, delivery and revisions.
Do not substitute a separately named protected acceptance project. Keep the
privileged operator private and separate. Follow the
[one-destination delivery contract](full-app-authoring.md#one-app-destination-and-public-delivery).

Verify the actual isolated database, Auth bindings, service memberships and app
assignments before app tests or provider effects. Public app distribution and
provider environment are separate facts: the app may have a public production
domain while the approved provider account and canonical test records remain
development/Sandbox-only. Customer Production rollout remains separately owned
by A481. A public release must open without a Vercel login and enforce access
through real Better Auth sessions, including a same-organization member with no
app assignment. A READY deployment or successful sign-in alone is insufficient.

Public release failures retain only bounded provider support facts with their
saved effect phase. GitHub diagnostics include the provider name, actual HTTP
status (or HTTP 200 for explicit GraphQL errors), closed error classifications
and a bounded hexadecimal request reference. Vercel diagnostics keep their
existing shape. Provider messages, response bodies, credentials and URLs are
never retained. Transport exceptions without an HTTP response remain unknown;
a diagnostic never clears a pending effect or grants another dispatch.

Record these exercised outcomes independently:

| Area                         | Required evidence                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public delivery              | Public app domain, real sign-in/sign-out, unauthorized route/action denial, persistent app action and independent readback.                                                             |
| Builder create/revision      | Saved public creation journey and existing-app revision against the same app/repository/project; preserved content and data.                                                            |
| QuickBooks development pilot | Exact authorized Sandbox connection, app activation, real ingestion and independently observed canonical records and provenance.                                                        |
| Isolation                    | Two apps with distinct installations/bindings on one tenant-owned connection; two tenants; denied foreign-app/tenant and unassigned-user access.                                        |
| Recovery/lifecycle           | Replay without duplicate writes, visible conflicts/uncertain state, and app-only disable with drained jobs while the other app and connection remain active.                            |
| Optionality/retention        | Shared standard/embedded component, safe installer reconciliation, no integration capability in a non-opted-in app, and no secrets/raw provider payloads in retained logs or artifacts. |

Ordinary Builder questions and concrete effect approvals drive these journeys.
Repair missing automation in the shared workflow and resume the saved work;
manual app changes, internal stage forcing and manually created resources do not
satisfy public Builder acceptance. Preserve every prior resource and operation.
In particular, never replay or fabricate settlement of the uncertain
`a469-preview-target-approved-batch`. Changed destination/exposure approval cannot
be borrowed from its obsolete protected Preview plan. Cleanup remains separately
scoped. Mark each criterion passed, failed, blocked or unassessed from observed
evidence; do not close A469 on source tests or deployed metadata alone.

### A-469 normal Builder acceptance

Follow the accepted [local-first execution decision](plans/2026-11-03-a469-normal-builder-public-delivery.md)
before implementation and hosted continuation. Its milestones remain unproved
until their named behavior is observed.

Continue the saved generated app through the public product. Resolve its accepted
repository and normal provisioning result first; reuse its independently verified
project, or let normal Create App provision its standard `apps-<app-id>` Services
project. Use that one project for Auth, app Services, delivery and revisions.
Do not substitute a separately named protected acceptance project. Keep the
privileged operator private and separate. Follow the
[one-destination delivery contract](full-app-authoring.md#one-app-destination-and-public-delivery).

Verify the actual isolated database, Auth bindings, service memberships and app
assignments before app tests or provider effects. Public app distribution and
provider environment are separate facts: the app may have a public production
domain while the approved provider account and canonical test records remain
development/Sandbox-only. Customer Production rollout remains separately owned
by A481. A public release must open without a Vercel login and enforce access
through real Better Auth sessions, including a same-organization member with no
app assignment. A READY deployment or successful sign-in alone is insufficient.

Public release failures retain only bounded provider support facts with their
saved effect phase. GitHub diagnostics include the provider name, actual HTTP
status (or HTTP 200 for explicit GraphQL errors), closed error classifications
and a bounded hexadecimal request reference. Vercel diagnostics keep their
existing shape. Provider messages, response bodies, credentials and URLs are
never retained. Transport exceptions without an HTTP response remain unknown;
a diagnostic never clears a pending effect or grants another dispatch.

Record these exercised outcomes independently:

| Area                         | Required evidence                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public delivery              | Public app domain, real sign-in/sign-out, unauthorized route/action denial, persistent app action and independent readback.                                                             |
| Builder create/revision      | Saved public creation journey and existing-app revision against the same app/repository/project; preserved content and data.                                                            |
| QuickBooks development pilot | Exact authorized Sandbox connection, app activation, real ingestion and independently observed canonical records and provenance.                                                        |
| Isolation                    | Two apps with distinct installations/bindings on one tenant-owned connection; two tenants; denied foreign-app/tenant and unassigned-user access.                                        |
| Recovery/lifecycle           | Replay without duplicate writes, visible conflicts/uncertain state, and app-only disable with drained jobs while the other app and connection remain active.                            |
| Optionality/retention        | Shared standard/embedded component, safe installer reconciliation, no integration capability in a non-opted-in app, and no secrets/raw provider payloads in retained logs or artifacts. |

Ordinary Builder questions and concrete effect approvals drive these journeys.
Repair missing automation in the shared workflow and resume the saved work;
manual app changes, internal stage forcing and manually created resources do not
satisfy public Builder acceptance. Preserve every prior resource and operation.
In particular, never replay or fabricate settlement of the uncertain
`a469-preview-target-approved-batch`. Changed destination/exposure approval cannot
be borrowed from its obsolete protected Preview plan. Cleanup remains separately
scoped. Mark each criterion passed, failed, blocked or unassessed from observed
evidence; do not close A469 on source tests or deployed metadata alone.

## Decisions needed to start the pilot

1. **Identify the rollout approver and provider-consent owner.** The delivery
   coordinator can prepare the supported host composition, protected
   configuration and migration/recovery plan using the existing contracts. The
   requester need not design database roles, signer formats or SDK internals.
   Before hosted resources, credentials or roles are changed, the operator must
   present the concrete target and effects for scoped approval. Coordinate with
   the existing A191/A197/A198 implementation streams rather than duplicating
   their work; those engineering prerequisites are not solved by blanket approval.
2. **Confirm the pilot scope.** The recommendation is QuickBooks in a
   nonproduction environment, migrating Vendor and adding one minimal second
   app with different target bindings against the same reusable connection.
   Confirm the approved organization/test account and acceptance owner. Do not
   include production activation or unbounded backfill in this approval.
3. **Decide whether Ramp belongs in the first rollout.** The
   recommendation is to defer it until the QuickBooks pilot passes. Choosing
   Ramp now adds a separate proxy-sync host and its acceptance work; its recipe
   and catalog presence do not make that host available. Xero can follow the
   same read-host qualification path after the initial pilot.

After runtime readiness, the operator presents the concrete migration window,
fence/drain and bounded retry/backfill plan, rollback owner and evidence
location for approval before provider effects. Then run the normal public
create and existing-app revision journeys, preserving their sessions and
independent canonical readback. Production expansion and organization-wide
disconnect remain separate approvals. No new Gateway permission decision is
required. These are rollout decisions; they do not reopen the merged source PRs.

A469/A480's dependency reconciliation was already approved and applied in the
implementation session; it is not a new approval request or an action to repeat.
A189 remains canceled. This documentation publication does not authorize new
Linear status/dependency changes, implementation, purchases, permission changes,
deployments or production/provider writes.

This handoff intentionally leaves the executable skill and its generated bundle
unchanged. Future authoring-guidance edits must use the repository's normal
bundle-generation/parity workflow before claiming the product consumes them.

New public release plans freeze a `source.deliveryScope` identifying the normal
Builder create receipt. Its request and digest must equal the destination's
provisioning receipt. Before planning and publication, the private factory
requires the settled owner-bound journal to prove this app repository was
created by Builder, with the recorded absent-candidate and accepted repository
identity. Independent GitHub reads must match that identity and its existing
Builder request marker. A shared source/template repository cannot become an
app release destination merely because its installation and branch are writable.
No legacy frozen onboarding approval authorizes this new release scope.

### Public realm enrollment

A public Auth bootstrap freezes a fresh `realmEnrollmentRef` with its environment
value hashes before its release operation digest is computed. The sealed link
configuration binds that reference to the current owner, app, creation session,
normal Services project, future public origin and exact prior installer Auth
resource tuple. It retains the installer's resource classification, including
`preview`, independently of native public delivery in Vercel Production.

Enrollment metadata alone grants no callback or membership authority. The
callback must resolve one owner-scoped READY `auth-bootstrap` public release,
verify its genuine approval receipts and original installer provenance, and
bind its operation reference and digest into the pending nonce and signed
`publicRelease` correlation. Ordinary browser identity and normal cookie capture
still require current Auth session readback. Production native senders come
from explicitly reviewed workload configuration, never an edited Preview
subject. Signup uses the actual installed policy for that origin and exact
resource digest; no generic membership fallback substitutes for that policy.

Frozen protected Preview link configurations and proofs retain their original
meaning. They cannot satisfy a new pending public release binding, and no
uncertain request or approval is replayed or transferred.

For a normal provisioned app, the initial GitHub destination review automatically
selects its owner/session-bound settled Builder repository receipt. Independent
GitHub access must return the same repository and installation; a supplied
selector cannot retarget the app. The fresh-template source receipt retains its
original provenance. Later revisions retain that same destination and review
current content through the existing branch/ref comparison and approval flow.

When public-release planning finds no normal destination, its blocked result
links to that same saved build's destination controls. Recovered workers use
the verified public owner session for this link. Opening the control does not
approve resource creation or release; the ordinary effect reviews still apply.

New public release plans snapshot the provider's prior active Production
deployment ID, or explicit absence, alongside the actual runtime key hashes.
If any runtime value is new or changed, publication must trigger native Git
delivery and observation cannot accept that prior deployment as the result.
Unchanged runtime values may reuse the provider's actual active deployment.
The snapshot excludes stale evidence; it never selects, promotes or aliases a
deployment. Provider activation and the public domain remain independently read.

### Public realm enrollment

A public Auth bootstrap freezes a fresh `realmEnrollmentRef` with its environment
value hashes before its release operation digest is computed. The sealed link
configuration binds that reference to the current owner, app, creation session,
normal Services project, future public origin and exact prior installer Auth
resource tuple. It retains the installer's resource classification, including
`preview`, independently of native public delivery in Vercel Production.

Enrollment metadata alone grants no callback or membership authority. The
callback must resolve one owner-scoped READY `auth-bootstrap` public release,
verify its genuine approval receipts and original installer provenance, and
bind its operation reference and digest into the pending nonce and signed
`publicRelease` correlation. Ordinary browser identity and normal cookie capture
still require current Auth session readback. Production native senders come
from explicitly reviewed workload configuration, never an edited Preview
subject. Signup uses the actual installed policy for that origin and exact
resource digest; no generic membership fallback substitutes for that policy.

Frozen protected Preview link configurations and proofs retain their original
meaning. They cannot satisfy a new pending public release binding, and no
uncertain request or approval is replayed or transferred.

New public release plans freeze a `source.deliveryScope` identifying the normal
Builder create receipt. Its request and digest must equal the destination's
provisioning receipt. Before planning and publication, the private factory
requires the settled owner-bound journal to prove this app repository was
created by Builder, with the recorded absent-candidate and accepted repository
identity. Independent GitHub reads must match that identity and its existing
Builder request marker. A shared source/template repository cannot become an
app release destination merely because its installation and branch are writable.
No legacy frozen onboarding approval authorizes this new release scope.

For a normal provisioned app, the initial GitHub destination review automatically
selects its owner/session-bound settled Builder repository receipt. Independent
GitHub access must return the same repository and installation; a supplied
selector cannot retarget the app. The fresh-template source receipt retains its
original provenance. Later revisions retain that same destination and review
current content through the existing branch/ref comparison and approval flow.

New public release plans snapshot the provider's prior active Production
deployment ID, or explicit absence, alongside the actual runtime key hashes.
If any runtime value is new or changed, publication must trigger native Git
delivery and observation cannot accept that prior deployment as the result.
Unchanged runtime values may reuse the provider's actual active deployment.
The snapshot excludes stale evidence; it never selects, promotes or aliases a
deployment. Provider activation and the public domain remain independently read.

### Fixed optional-capability worker transport

Optional integration setup uses the existing project-OIDC, immutable-worker,
framed file-spool Sandbox transport. Its catalog entry is
`app-integration-bootstrap-v1`; the approved source SHA must match the installed
worker bytes. Control schema, service memberships, and atomic sealed app
registration have separate fixed commands and readback commands. A readback
worker can check its current fence but cannot request a mutation authorization.
Private connection and sealed-authority files travel through owner-only SDK file
writes. They are not shell arguments or public tool results. Control database
allocation uses the existing fixed resource worker with the explicit
`integration_control_database` scope, independently from the app's Neon branch.

### Normal existing-platform reference

Fresh capability plans use version 3. The new existing-platform READY receipt
uses central-readiness family `version: 2` and protocol kind
`existing-platform-integrations-ready-v1`; legacy isolated READY remains
version 1/kind `central-integration-host-ready-v1`. They consume an independently verified
already-owned normal platform Integrations reference, while the app retains its
single recorded `apps-<app-id>` Services destination and BetterAuth composition.
The platform control plane may already live in a different owned Services
project and serve multiple apps; this does not authorize creating another app,
acceptance, Auth, Preview, or integration-backend project.

The deployment-owned `HOSTED_EXISTING_PLATFORM_INTEGRATIONS_REFERENCE` selects
one shared public platform reference, authorized owners, its platform owner
authority and protected worker credential custody. It has no per-new-app
caller or READY entry. The current canonical provisioning receipt supplies
the app owner/project/installation; provider readback supplies its caller
observation. The frozen caller-grant digest excludes unrelated callers, so
registering a second app does not invalidate the first. It is not model-supplied configuration or approval.
Read-only verification checks both the platform and recorded caller project,
active owner-scoped installations, repository linkage, Services root, absence of
paid Microfrontends groups, native deployment activation, loaded configuration,
restricted control database/schema/activation key, actual approved central-control
resource custody plus independent Neon readback, QuickBooks Sandbox identity
and actual caller grant. The retained `control.resource.environment: preview` field is the existing
restricted-resource isolation marker, not a demand for Preview hosting.
Production **hosting** does not authorize customer
Production provider resources or data: the normal readiness contract separately
requires `providerEnvironment: development`, `dataEnvironment:
dedicated-development`, and `quickbooksSandbox`.

Production native activation is read from the provider's current project target
and that exact deployment. The [deployment API](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url)
uses `null`/omitted or `staging` target representations for development delivery;
these remain distinct from the internal `preview` hosting environment.
A normal Preview reference needs an explicit trusted
provider-owned activation observation port for its exact ID; no deployment list,
Git/PR/SHA mapping, alias reconstruction or time ordering can substitute. Missing
or unverifiable normal configuration returns
`app_integration_existing_platform_required` before capability effects. The read-only platform preflight produces its own verified reference digest
without claiming an app caller. A missing actual caller grant separately returns
`app_integration_caller_registration_required` for a fresh normal registration
approval; an operator readiness inspector is not the app caller. Neither case
falls back to an isolated-host setup. The public five-tool interface is unchanged.

The V3 plan freezes the normal reference digest and actual physical destination,
resource and caller facts. It has no invented legacy setup/caller operation IDs.
Its control allocation, schema, memberships, provider destination and app
registration still require the existing ordinary concrete effect approval.
The shared reference freezes its real `resourceCustody` receipt reference and
digest. `readExistingPlatformControlResource` must resolve that actual
platform-owner custody and independently read the physical resource; loaded
configuration IDs or a pending app/Auth resource policy do not satisfy it. The
consumer fails closed with `app_integration_resource_provenance_required` until
that real reader is available.

Public release and removal re-read the same normal authority; an unchanged
reference string alone cannot establish readiness. Privileged platform/control
credentials remain in the protected worker boundary, never in the generated app.

A missing normal reference is a provisioning prerequisite, not completed setup.
The reference consumer performs no setup. Supporting a new isolated development
resource/profile must use a new ordinary Builder intent bound to the recorded
app and an explicitly selected already-owned normal platform project: prepare
resource/Auth ownership and fixed schemas, freeze exact environment/caller scope,
obtain fresh effect approval, publish reviewed source through native Git, then
verify provider activation and loaded readiness. Those effects must preserve
existing customer Production configuration/data and cannot reuse old isolated
onboarding consent. The legacy isolated setup tool is not that normal setup
operation; do not manually alias an old app-specific profile or manufacture a
READY reference to bypass this missing mechanism.

### Legacy isolated central setup and caller observations

The existing isolated central Services destination has its own approved setup
intent and owner. Each normal app has a distinct caller plan pointing to that
exact setup. Readiness rechecks both authorities and the actual provider, SQL,
configuration, and workload grant; a ready-looking retained row alone is not
proof. This infrastructure intent never changes the meaning or target of an old
app onboarding plan.

Native deployment IDs must come from authenticated provider receipts for the
owned source publication. `deployment.created` and `deployment.ready` receipts
retain bounded IDs, origins and body hashes; they do not establish application
acceptance. Different native IDs stay a visible conflict. No list, timestamp,
source-SHA election or reconstructed branch alias can select a replacement.
Vercel documents `deployment.ready` for ordinary ready deployments and limits
`deployment.succeeded` to integrations with registered checks in its
[webhook contract](https://vercel.com/docs/webhooks/webhooks-api).

## Integration-independent app finalization

Optional integrations may be explicitly deferred by an ordinary accepted AppSpec
revision and fresh existing-app source approval. The same app retains its project,
repository, database, dedicated Auth and previous receipts. Reconcile the active
executable provider selection and installer-owned source with
`install-app-integrations`; a valid omitted receipt has no providers or readiness
claim. Its observed `capabilityState: "source-omitted"` is guidance, not runtime or
provider authority. Normal create, public delivery and revision acceptance can
then proceed without provisioning shared Integrations infrastructure or activating
a third-party connection. App-owned static unavailable UI may remain only without
an executable capability/runtime claim.

This source operation preserves retained external bindings, provider/customer
data and uncertain operations. Existing retained-capability reconciliation and
removal approval controls remain authoritative. An app description that still
claims an installed integration capability must continue to satisfy the unchanged
public-release guards. Deferment never turns a missing capability into success or
changes a frozen plan's meaning. Any later provider connection/activation/ingestion
journey remains separately scoped and approved.

### Lifecycle release scope

The integration-independent lifecycle cut keeps normal Builder destination,
source publication, dedicated Auth, app resources, public delivery and revision.
Active shared-control provisioning and third-party connection/activation/ingestion
implementations remain parked. Missing optional private handlers return their
existing unavailable response; they never imply `not_configured` or successful
settlement. Only supported implementation with a genuine authorized binding read
can establish `not_configured`. No provider/account probe or synthetic binding
substitutes for that distinction.

Read-only installed-capability/retention guards stay in the public release path.
An installed declaration still requires a genuine completed capability; retained
bindings that need unsupported reconciliation remain an explicit prerequisite.
The scoped PostgreSQL proof retains app resource/Auth credential custody and
public-release journal checks. Separate central/control provisioning proofs are
parked with their implementation, not reported as lifecycle acceptance evidence.
