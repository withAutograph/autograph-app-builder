# Native Preview operator composition

`lib/provisioning/hosted-operator-function.ts` loads the real
`hosted-operator-composition.ts#createDependencies` factory. Missing or invalid
`PROTECTED_HOSTED_OPERATOR_CONFIGURATION` leaves resource operations unavailable.
The separately configured consent-only path is described below. Source configuration,
local fixtures, native deployment READY, database metadata, and normal human
sign-in are separate evidence.

Git and database branches have separate purposes. Arrusted apps and their
schemas converge on Arrusted's Git `main`; Builder keeps its own Git `main`.
Review branches do not define permanent database ownership. Each app needs its
own PostgreSQL database and runtime role, while the shared Auth realm has a
separate database. The one native Neon scope in current configuration is the
physical context containing those distinct databases.

Without deployment-owned `syntheticEnrollment`, native readers require nondefault
Neon branches with `parent-schema` or `schema-only` provenance. Explicit synthetic
enrollment supports a dedicated project's default `main` root with `parent-data`
or `schema-only` provenance. Provider readback must match the enrolled project ID,
owner and creation metadata, plus the root's branch ID, creation metadata,
initialization source, ready state and `default: true`. Enrolled children also
require verified lineage and fork metadata back to that root.

Operator use can select the enrolled root directly; creating a child is optional.
Default branches remain unavailable without explicit synthetic enrollment. Preserve
current Production storage and treat migration as a separate approved operation.
See the [database target and safe sequence](plans/2026-10-07-hosted-operator-deployment-and-spend-review-qualification.md).

The deployment-owned configuration selects three distinct projects: app-only
Next, Gateway/Auth-only, and private operator. The app-only project runs the
selected generated app. It is separate from the hosted-app-runtime Services
path, whose shared service credentials do not meet this operator's
credential-isolation boundary. This operator does not migrate to or invoke that
Services topology. It supplies exact native project,
branch references; native Neon store/project/branch/endpoint;
actual operator/workload OIDC identities; immutable Sandbox image and worker
IDs/SHA256s; Auth/app database and role names; public browser/issuer origins;
and restricted application roles. Secrets and SQL URLs are never plan inputs.
The private planning tool resolves the configured Preview project and branch
through the protected operator. Resolution rechecks the original session owner,
membership and current provider project access; it performs no resource effects
and needs no compiled release. Repository deployment metadata cannot substitute
for this target. An explicit conflicting project or branch remains rejected,
with only the authorized target returned privately for recovery.
The accepted spec's workspace ID identifies the repository execution workspace.
The canonical session principal and owner authority identify the tenant workspace;
artifact reads retain that tenant scope and the original public session. Each
artifact read freshly checks the canonical session, app linkage, and membership;
provider project grants are checked at planning and execution boundaries, rather
than once for every immutable archive chunk. Do not
compare the repository workspace ID with the tenant workspace ID.
Read-only Neon metadata inspection checks the current provider project grant and
native source binding before the observation and again before returning its
result. Every OIDC, token and tool step still rechecks canonical session ownership,
active workspace membership, app/adapter identity and the active owner-scoped
installation credential. These local checks do not repeat the provider inventory
read. This prevents one observation from amplifying Vercel project requests into
HTTP 429 failures. Authority is not retained between observations; credential
acquisition and approved effects keep their existing approval, fence and current
provider checks.

Recovery keeps three identities distinct: the original public/authority session
owns human receipts, grants and artifacts; `currentSpec.sessionId` stays the
logical Eve workflow/session ID; the canonical recovered child's adapter is the
physical stream anchor. A deployment successor may differ from that anchor; the
SDK supplies distinct trusted execution and stream-anchor identities. The current
canonical child's top-level decision, adapter and generation fences govern physical
execution. Derive mappings only from a verified recovery binding; never rewrite
saved approvals or session IDs, or map a logical session to “latest”. Apply
`resumedCancellationRevision` equality only to recovered-only continuation, not
ordinary active sessions. A completed session may permit cached terminal receipt
readback; keep effect-specific current, Stop and tenant checks. Fixtures should
reflect original/current canonical records and assert behavior and security rather
than incidental argument counts or app shape. Source evidence is in
`lib/provisioning/hosted-operator-owner.ts`,
`lib/provisioning/hosted-operator-planning-authority.ts` and
`lib/provisioning/hosted-operator-callback-owner.ts`; this does not establish a
usable hosted Preview.

Private planning failures report only a closed stage, error class, known code,
and hashed session identity. They preserve the original result or error and never
log error messages, stacks, provider responses, credentials, or app content.
Browser acceptance receives `APP_TEST_BASE_URL` only for `test-e2e`, from the same
owner-verified native Preview projection used to prepare runtime execution. This
URL handoff supplies no actors, sessions, roles, or authenticated behavior proof.
The hosted preparation Workflow returns its existing public operation reference.
Its owner `action.result` hook synchronously retains only the app, operation, and
plan digest in durable session state: authored Eve steps have separate contexts,
so step-local state writes alone do not reach a later ordinary tool. The next
Preview or runtime consumer reloads that exact retained approval, rechecks the
current owner, adapter generation and cancellation revision, and then reads the
protected bindings. A failed lookup remains a resource/authority failure and
does not switch a protected preparation to a Sandbox Preview. Apps without a
protected preparation reference retain the ordinary Sandbox path. Neither this
handoff nor a ready Preview supplies authenticated behavior evidence.
Existing Gateway signing and Better Auth secrets, actual provider-injected
`VERCEL_DEPLOYMENT_ID`, and independently observed
`AUTH_PRODUCTION_DATABASE_IDENTITY` are setup prerequisites. No Production
connection string is supplied to the Preview realm or generated app.

Fresh app and Gateway projects need no seed deployments. Their configuration
retains exact team-owned project and Preview branch inputs. Gateway repository
and commit inputs remain required. The app's repository and commit may be absent
during Auth/database bootstrap, so unpublished app source does not block those
approved effects. After ordinary approved Git publication, update, or
reconciliation, Builder automatically associates the independently observed
repository, branch, commit, and tree with the original owned session's selected
compiled release. Generated app delivery consumes this `publishedSource`
association; it never substitutes configured starter source, a baseline commit,
or a latest-repository guess. An update records its newly observed head, while
replaying the original publication retains its original completion marker.

The Gateway's configured branch remains its environment, alias, and saved
candidate namespace. When an approved app plan delivers the Gateway from the
same repository and exact commit as its published app, native Git creation,
listing, and readback use that app's approved source branch. The commit, project,
owner, and operation checks remain exact. Bootstrap and other repository or
commit combinations retain the Gateway's configured source reference. This
source projection does not change environment rows, approval digests, or pending
delivery attempts.

For a new selected release, optional `deployment` metadata in the captured
repository `app:describe` result supplies the provider framework, outside-root
source inclusion, and any explicitly configured build command. Builder uses the
same description's app `workspacePath` as `projectSettings.rootDirectory` and
freezes those settings with the new delivery plan. An omitted `buildCommand`
preserves existing provider behavior and `null` is forwarded unchanged. A
description without deployment metadata still supplies its exact `workspacePath`
as the new plan's root. Other configured fields remain for compatibility when
present; when absent, framework detection, outside-root inclusion, and build
command use provider defaults. This does not establish a complete current source
build profile. Do not derive an app path from its ID
or invent install, build, or output commands. For the current Next app source,
the profile is `nextjs` at that exact workspace path with outside-root source
inclusion enabled for shared workspace packages. A missing profile remains
valid for older configurations and frozen plans; it does not claim that provider
project settings were configured or observed.

When native Turborepo autodetection selects a failing build path, a trusted app
profile can explicitly invoke the accepted application's own build script. For
example, a source using Bun with an app `build` script can configure
`buildCommand: "bun run build"` at its actual app root. Select the command for
each app from its accepted source. The command travels in
`projectSettings.buildCommand` on the [supported deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment),
is covered by the plan digest and ordinary changed-plan approval, and does not
modify Vercel project-wide settings. Deploy a Builder that recognizes the field
before an operator publishes a plan containing it. Environment changes apply to
new deployments, so their configuration can be prepared in advance: refresh
Builder first, then refresh the operator that will publish the changed plan.
A source-derived override still requires actual native build readback; it does
not establish that a build has succeeded. Use actual provider build errors to
diagnose repeated failures before resubmitting the same command. Normal source
changes and explicit provider retries remain supported.

The REST deployment request is explicitly bound to the approved repository,
ref, and commit. A dedicated unlinked app project does not require Builder to
create a persistent Vercel Git link: the approved Git source on the REST request
is the delivery authority. If a project is linked, its repository and source
authority checks still apply; a link to a different repository is not accepted.
Project build settings travel in the same approval-covered delivery plan. The native REST transport forwards the frozen profile as
`projectSettings`; provider acceptance and build results remain actual
observations. A frozen source profile or REST request alone is not evidence of a
successful build.

If association recording fails after Git publication succeeds, preserve that
success and use the same approved publication's supported recovery. Do not issue
another outward effect merely to record the source. The resource journal's
selected branch keeps its identity; the approved app delivery and its
branch-scoped environment rows use the actual published branch. Ordinary
recompilation remains a new planning input, not a source-drift failure or a
reason to rebuild the Sandbox dependency closure.

A later publication on another branch preserves earlier owned deployment
provenance and environment rows in private delivery history. Active delivery
uses the new branch. Returning to an earlier branch restores its latest actual
row state, so a provider-confirmed removed row is not resurrected from an older
snapshot. Cleanup lists the exact saved owned row IDs, branches, and tags in its
concrete plan before approval. It re-observes each row before deletion and retains
unconfirmed rows after partial or unknown failure.

For both projects,
`deploymentId` is optional until a deployment is observed. Bootstrap planning
reads project ownership and Preview environment inventory even when delivery
has not happened. Configured origins are intended routing inputs, not observed
Gateway ownership or public-key evidence. A supplied deployment reference must
still be independently READY and match its project and branch. The operator's
own deployment reference remains mandatory.

Gateway delivery records its candidates in the durable journal. Identity-link
preparation requires the journal's actual READY Gateway candidate and validates
its origins; it does not require an app candidate before the first app delivery.
Final app verification requires both actual READY journal candidates and strict
provider deployment readback. The request API cannot choose bootstrap inventory
mode; that mode belongs only to the trusted planning composition.

The first approved `auth-bootstrap` plan creates or observes the owned resources,
installs only the Auth schema through `auth-protected-schema-v1`, writes the
Gateway's private Auth runtime connection and public configuration, and delivers
an independently observed native Gateway Preview. It records Auth schema
readiness, not app preparation. After execution releases its lease, the closed
private `auth-identity-input` request prepares or reuses the journal's sealed
nonce and returns an ordinary Auth browser link. The normal user signs in and
confirms the link; Builder receives only the separately scoped signed proof.
The canonical owner callback consumes that nonce exactly once.

A renewed full plan reads that captured proof and current Realm session through
the closed native transport. Creating a new organization is a distinct approved
`auth-membership` effect for the existing normally authenticated user; it seeds
no users and initially grants no apps. The existing access saga installs current
App DB bindings before enabling this app in Auth. App environment delivery
contains only its own runtime URL and public verification/boundary settings.
The selected native app candidate is then published into the existing
`PLATFORM_GATEWAY_PROJECT_BINDINGS` projection, preserving sibling applications,
and the Gateway is delivered again. The public working surface is the approved
Gateway browser origin; immutable native candidates remain the authority for
provider readback.

### Gateway access to a protected app

Provider protection has two separate caller directions. Gateway Trusted Sources
for Builder or the operator do not grant the Gateway access to the app project.
An app protected by Vercel Authentication must also trust its configured Gateway
workload. Forwarding a valid OIDC token alone does not create that grant; see
[Vercel Trusted Sources](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources).

New app-stage proposals freeze the service grant in
`appTrustedSources.gatewayPreview`: add Preview-to-Preview access from the
configured Gateway project to the selected app project. The ordinary plan
approval covers this explicit access change. App environment binding observes
the target project's current policy, adds only this approved rule, and reads the
policy back. Preserve implicit app self-access and existing project grants,
OIDC providers, and provider-owned policy fields. A
pre-existing rule that already covers the requested access needs no policy
write. Do not disable Vercel Authentication, add Production access, introduce
static bypass secrets, or relax the app's signed-principal verification.
The provider policy update is a read-merge-write operation; readback does not
make it atomic with another administrator's concurrent policy changes.
Deploy a Builder that reads this optional plan field before an operator starts
publishing proposals containing it. This requires compatible readers and
writers, not identical deployment commits or a new configuration secret.

The reverse `gatewayBindings.trustedSources.appPreview` rule allows the selected
app Preview to fetch the protected Gateway's public signing keys with the app's
own short-lived OIDC token. Add that Preview-to-Preview pair through the existing
Gateway binder while preserving other callers. The public JWKS handler does not
require another account role or a realm readonly attester. A legacy plan can
approve this app rule alone without inventing Builder or operator grants.

Older frozen plans without this field perform no new policy reads or writes.
Do not silently add a grant to an approved digest, clear completed receipts, or
rebuild an already delivered app to repair provider access. A separately approved
grant may be applied as an explicit operator setup action while preserving the
saved plan, approvals, receipts, deployment candidates, and retention expiry.
Record that action's provenance; it is not evidence of automatic provisioning
by the older workflow. A changed-plan recovery instead needs fresh approval and
the original approved delivery provenance for every retained candidate.

For an interrupted app-stage operation whose approval has expired, propose a
new concrete expiry and both configured Preview service call directions
through the normal Builder approval. Keep the original session, account,
resources, release, source commits, roles, and app intent. The previous approval
is historical provenance; it cannot authorize more execution or extend itself.
Archive its full operator record, receipts, deployment candidates, pending
attempt, and alias intent before starting the renewed execution.

Preserve a consumed Realm identity link when its original delivered Gateway
candidate moves into that history. Its endpoint must still match the exact
retained READY candidate and unchanged consumed proof, with the current Auth
resource, owner session, browser origin, and issuer bindings intact. Retained
origin evidence does not authorize another identity-link consumption or replace
fresh deployment observation under the new approval.

Under the fresh approval, reconcile access and runtime bindings again, apply
and read back the approved service grant, and read both existing native
candidates and the canonical Gateway alias. Historical metadata must remain
paired with its exact approved plan and actual provider identity. Keep prior
receipts in history; they do not replace the renewed operation's observations.
An unresolved old deployment or alias attempt remains unresolved and cannot be
converted to absence to authorize a duplicate request. This does not require a
provider probe before proposing the plan or another account-selection step.

Provider policy readback and READY deployments do not establish authenticated
Preview behavior. Open the approved Gateway browser URL explicitly with the
normal account and verify app use and persistence. A direct native-app denial
does not identify the failed handoff; distinguish the first Gateway response
from later browser navigation before changing routing or authentication.

Operator-managed delivery calls Vercel's REST deployment API with the frozen Git
repository, ref and commit. It does not rely on a branch-push deployment, which
could start before the runtime bindings are ready. Git-source delivery through
this API is explicitly at least once. A completed no-match listing is
not absence; an approved retry can create additional owned matching Preview
deployments and provider usage charges. Known queued/building candidates are
observed without another POST. The existing journal retains every observed
candidate ID, pins one independently READY candidate matching the approved
project/environment/repository/commit/configuration, and does not rewrite the
old frozen inventory.

App-only REST delivery omits `target` to request Preview, following the
[deployment API's documented default](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment).
The API documents a response `target: null` as Preview; explicit
`target: "staging"` additionally assigns a staging alias. Reported first-deployment
misclassification is not the documented default;
[Vercel issue #17069](https://github.com/vercel/vercel/issues/17069) includes
failures with both omitted and explicit staging targets, so staging is not an
established repair. Confirm the actual native deployment target and its OIDC
environment through provider readback before using it as the app Preview. A successful POST
or a source fixture does not establish that environment. Retain any rejected
non-Preview attempt in the operation audit; never promote it into the Preview
candidate inventory. Keep the existing Production deny policy unchanged. The
Gateway delivery pathway remains unchanged.

A trusted `projectSettings` repair may be planned while app delivery is pending.
Use the normal structured planning and approval flow for the changed frozen
settings. Preserve the same resources, completed receipts, owned environment
rows, private credentials, and original retention expiry. Reconcile the old
exact approved attempt before a new deployment POST; an unknown outcome still
requires reconciliation rather than a duplicate submission. Retain the old
plan, approval, attempt, and observations as audit history. A settings repair or
its approval is not evidence that the repaired Preview has deployed successfully.

For an explicitly unlinked app-only project, the provider's physical Preview
environment may be generic rather than branch-named. Keep the approved logical
branch from the Git source on the durable owned environment row and delivery
history; do not invent a branch-specific provider environment name. This
unlinked-project handling does not relax repository, branch, commit, ownership,
or readback checks for linked projects or other deployment sources. When
assessing a first deployment, observe provider build settings and build results;
a source fixture or settings profile alone is not evidence of actual deployment
success. Existing source, project, and credential approval checks remain in
force.

## Deployment pathways and current choice

Both pathways build source from Git. The difference is what starts the build:

| Pathway              | Trigger and fit                                                                                                                              | Builder integration                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git integration      | Vercel starts a deployment on a branch push or merge. Convenient for an established project whose runtime configuration is already in place. | A Git-triggered candidate would need to be associated with the approved operation and observed through the delivery journal. The current operator does not adopt arbitrary Git-triggered deployments. |
| REST with Git source | The operator sends `POST /v13/deployments` with the approved repository, ref and commit after preparing the relevant bindings.               | Implemented by `hosted-operator-deployment-delivery.ts`; records operation metadata, observes existing candidates and publishes the selected app into the Gateway.                                    |

Use REST for the current provisioning flow: Auth bootstrap, app installation and
Gateway projection have an execution order, and the existing adapter already
owns that sequence and recovery. An app push does not select the Gateway's
separately configured source. This choice does not wait for CI or introduce
app-content requirements. App code, roles and schemas remain custom inputs.

Git integration is an alternative for projects with established resources. Using
it in this operator requires connecting its deployment observations to the same
approved operation and recovery flow; enabling automatic builds alone does not
provide that integration. Neither pathway changes authentication, tenant
isolation or effect approval. Do not enable both triggers for the same delivery
as an automatic retry: that can create duplicate builds and provider charges.

Vercel can allow these mechanisms separately through deployment-source policies.
A policy-blocked Git-triggered build is not a compiler result and does not prove
that an allowed REST deployment failed. Inspect the actual deployment source
and error before selecting a recovery action. See Vercel's
[Git integration](https://vercel.com/docs/git) and
[deployment-source policies](https://vercel.com/docs/deployments/deployment-policy#deployment-sources).

Required native transport grants are directional and exact: Builder Production
or operator Preview to the configured Gateway Preview for identity/JWKS
readback, and Gateway Preview to app Preview for protected ingress. Each caller
uses actual SDK OIDC and the configured team/project/environment; deployment
protection compatibility requires actual provider readback. No source fixture
qualifies these hosted grants.

Cleanup closes and observes app access before Auth revocation, deletes only
journal-owned app environment rows, and retires only the owned app resource.
Shared Auth users, sessions, data, credentials and Gateway settings remain. The
existing encrypted resource credential checkpoint survives cleanup and renewed
Preview preparation. Retired-state inspection uses the fixed read-only worker;
errors, foreign ownership and unsafe live sessions remain unknown. It never
forces database drops or equates a receipt with actual cleanup.

Shared Auth retention is not proof of cross-app adoption. Current encrypted
credential bundles bind the app and Auth resources to one physical context and
journal; a fresh bundle creates both credential pairs. Onboarding a second app
must prove reuse of the existing realm's authority and credentials without
rewriting users or sessions. Existing HC/Vendor database and environment names
alone likewise do not prove that live app processes use separate databases.

## Owner Neon consent before resource setup

`PROTECTED_HOSTED_OPERATOR_AUTHORIZATION_CONFIGURATION` is the narrow,
deployment-owned consent setup: `builderCallbackOrigin`, `builderWorkload`
(exact issuer, audience, subject, owner, project and environment), and
`operatorWorkload` (exact issuer, audience, owner, project and Preview
environment). Its owner reader uses `DATABASE_URL`, `BETTER_AUTH_URL` and
`MCP_RESOURCE_URL` for the existing session, handoff and membership stores.
It requires neither an Auth signing secret nor a Vercel token keyring.
Consent needs no app project access, app Git release, Neon branch, Gateway seed deployment
or Sandbox image. Without full `PROTECTED_HOSTED_OPERATOR_CONFIGURATION`, the
factory serves only the closed Neon consent action; resource planning and
effects remain unavailable.

`connect-app-hosted-owner` resolves the canonical saved-session owner before app
planning inputs exist. `plan-app-hosted-runtime` also uses
Eve's inline authorization flow for preparation. The operator re-reads the
exact direct/handoff generation and current membership for
each check, start and completion. Only verified operator Preview OIDC starts
the fixed `mcp.neon.tech/neon-preview-operator` grant with `read`/`write` scopes
and `https://mcp.neon.tech/mcp` resource. Eve supplies the callback under the
configured Builder origin; the public challenge URL must use the Vercel
consent origin. Connect owns PKCE/state, so request/verifier and provider
tokens are neither returned to Builder nor journaled in public events.

The original public session parks on its ordinary authorization request. The
human completes provider consent; callback completion rechecks the actual
owner grant before planning resumes. Browser return alone proves no grant,
app preparation or hosted product behavior.

## Active v1 encryption key custody

The private Source POST `/api/hosted-operator/key-custody` and Operator POST
`/v1/key-custody/possession` accept only `{ "operationRef": "<saved UUID>" }`.
They remain unavailable without a separate trusted global custody enrollment.
The receiver path dispatches before ordinary runtime composition and requires
neither full operator configuration nor a Realm callback or Auth signing secret.
Both endpoints verify the configured Source Production workload; Source also
verifies its own exact enrolled deployment. Receiver verifies its trusted Preview
workload and its own exact persisted receiving deployment before reading the key.

`PROTECTED_VERCEL_TOKEN_KEY_CUSTODY_CONFIGURATION` is nonsecret, deployment-owned
setup: version 1, one `operationRef` and `grantRef`, the captured canonical
`capturedOwner` context, and fixed `source` and `recipient` HTTPS origins and
workload policies. Source is Production and recipient is Preview, in the same
team and separate projects. The recipient origin must be an existing stable,
team-owned alias that will resolve to the separately approved refreshed Preview.
This source change creates no alias, deployment or enrollment. Operator needs
approved read access to the original session, membership and saved custody row;
it does not need journal mutation permission for possession.

The exact frozen `CustodyPlan` and full `TrustedCustodySetupGrant` are installed
by a trusted administrator in the existing `builder_provisioning_journal`, using
kind `vercel-token-key-custody-v1`. This adjusts the original environment-only
setup design: install stable configuration and deploy Source first, independently
observe its actual deployment ID, then review and enroll the exact plan and
operation-specific grant. Thus enrollment does not require predicting a future
Source ID or changing Source configuration after freezing that ID. Grant creation
is confined to the private administrative channel; neither runtime route creates,
replaces or accepts a grant. A digest closes the reviewed request; possession of
the existing private administrative database credential and explicit human
approval establish enrollment authority.

The source entrypoint `lib/provisioning/vercel-token-key-custody-cli.mts` has
`plan --request-file ABSOLUTE_PATH` and
`enroll --request-file ABSOLUTE_PATH --database-url-fd 0` modes. Its owner-only,
canonical, unsymlinked, bounded request contains `{ setup, request,
confirmationDigest? }`; `request` contains version 1, action
`enroll-active-v1-key-custody`, and the strict reserved metadata record. `plan`
returns the closed confirmation digest without database access. `enroll` requires
that exact digest, uses the existing private database credential from stdin,
rechecks the original saved session and current membership, and reserves only
this record under the fixed physical slot transaction lock. It reads no provider
token or encryption key and performs no provider request. These commands are
source capability, not evidence that an administrator ran them or approved a
transfer. Every enrollment/transfer/receiver refresh remains separately approved.

An exact reserved enrollment that never began an attempt can be retired through
the same private administrator entrypoint with
`retire-plan --request-file ABSOLUTE_PATH` followed by
`retire --request-file ABSOLUTE_PATH --database-url-fd 0`. The strict request
binds the saved operation, complete record digest and expected journal revision;
the printed confirmation digest must be supplied unchanged. Retirement acquires
the same global physical slot lock, rechecks the exact row/revision, and proves
the original saved owner session and current membership before setting only
`grantRevokedAt` through the existing scoped journal UPDATE. A stale plan, any
attempt timestamp, effect metadata, lease or nonzero fence is rejected. Ordinary
custody CAS remains unable to alter grant identity or revocation. A safely
retired, untouched reservation remains as an audit tombstone but no longer blocks
the physical slot; attempted, uncertain or effected tombstones continue to block
replacement. A replacement requires a new operation and separately approved
grant bound to the observed repaired Source deployment ID. This recovery changes
no database grants and grants no new role authority.

The journal stores only plan/grant metadata, captured canonical authority,
approval reference, phase, revision, lease/fence, attempted time, owned provider
row metadata, exact receiver ID, nonce/expiry/consumption and verified receipt.
The full grant is nonsecret and is digest-bound to the record; an admin-controlled
`grantRevokedAt` makes it unusable. Ordinary custody CAS cannot alter that grant
or revocation marker. Legacy retry/read selectors now select only untagged
records. Generic tenant retention and deletion exclude custody records, including
settled ones, because global slot claims and unknown outcomes must survive tenant
cleanup until the trusted global setup lifecycle revokes authority and resolves
uncertainty. No table, migration, sequence privilege or new admin URL is added.

Source rechecks the original actor/session/membership and existing active v1
owner-bound Vercel installation. It requires destination VERSION Config `v1` in
the exact project Preview scope with no branch override, and validates the
original installation's team binding and fresh destination project ownership.
Only a validated readable VERSION row may use the exact single-row decrypted
Config GET; app values and Secret key bytes are never decrypted from provider
storage. The Secret port sends one fixed create-only REST request with
`type: sensitive`, target Preview, null branch and `upsert=false`, using in-memory
active key bytes. Its `comment` binds the operation/plan/grant metadata for safe
unknown-outcome reconciliation. Config visibility cannot substitute for Secret
visibility. Current APIs may report Secret storage as encrypted with
`visibility: secret`; this normalizes to the logical sensitive receipt type.

The fixed lock covers team, Operator project, Preview/null branch, and the KEY
and VERSION pair across all actor/session/operation tuples. The transaction keeps
backend/held-lock/active-connection checks while the independent journal pool
commits attempted state before POST. A timed durable lease and CAS fence govern
each continuation. Transport failure or nondefinitive/partial success retains
attempted/unknown; a missing metadata read never permits another Secret POST or
a replacement operation. Reconciliation accepts only the saved owned row. Key
buffers are wiped after use; durable records and safe responses contain no key,
provider bearer, previous keyring or raw provider body.

After the separately approved refreshed receiver is available, Source resolves
the configured alias through the native alias API, then independently reads its
exact deployment. It requires the fixed project/team, native Preview target
(null), READY state, and creation after the attempted Secret write, and freezes
its exact deployment ID and unique origin. READY only permits this possession
checkpoint; it does not prove key equality. A server nonce and expiry bind the
current fence, plan/grant digests, both workloads, active v1 and exact receiver.
Receiver loads that persisted checkpoint, validates it before key access, computes
the domain-separated HMAC and rechecks revision/current authority before returning
proof. Source verifies against its own injected key and CAS-consumes the nonce
into a metadata-only receipt. A duplicate completed Source call returns the same
receipt; a consumed/expired/revoked receiver checkpoint cannot sign again. No
request accepts a caller nonce, message, destination, key, token or attestation.

Source-only tests cover checkpoint ordering, uncertain POST reconciliation,
no blind retry, byte mismatch, strict grant/receipt/scope binding, key wiping,
private selector rejection, nonce consumption, enrollment closure, Secret wire
and VERSION-only readback. They do not prove current grants, provider permissions,
actual Secret injection, receiver deployment or hosted possession. Hosted
acceptance requires the newly approved exact operation, independent metadata
readback, approved refresh and the persisted possession-verified receipt.

Provider wire references: [create environment variables](https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables),
[read one Config value](https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id),
and [read an alias](https://vercel.com/docs/rest-api/aliases/get-an-alias).

After custody enrollment, rollback and recovery must retain custody-aware tenant
cleanup selectors. Running earlier generic tenant retention/deletion code could
erase the global slot claim or an unknown-outcome checkpoint. Preserve these
exclusions when rolling back other operator changes; the custody grant and safety
evidence retire only through their explicitly authorized global setup lifecycle.

### Original-owner invocation

The coordinator opens the canonical Source origin's
`/api/hosted-operator/key-custody/invoke` in an ordinary signed-in browser.
The protected GET shows only the already enrolled operation's frozen plan,
admin approval/grant references and digests, exact Source deployment and
team/project scopes, active version, create-only Secret effect, VERSION
validate-only scope, expiry and current phase. It performs no key access,
provider effect or grant reservation. Missing, expired, revoked or mismatched
enrollment remains unavailable. A signed-out GET directs the browser to the
existing Source sign-in flow; only the captured original owner can review.

The page has a native same-origin POST form containing exactly one saved
`operationRef`. It accepts neither JSON nor caller grant/approval fields, nonce,
key, token, destination or an arbitrary message. Duplicate fields and unbounded
form input are rejected. HTML escapes all metadata and sends no-store, no-referrer
and restrictive form/frame/script policies. Browser cookies remain in the normal
browser session and are never copied into scripts, operator requests or output.

The invocation reader uses the existing Source Better Auth session API with
`disableCookieCache` and `disableRefresh` to read the current browser session.
The session's user must be the captured original actor. Each Source continuation
rechecks that same browser session and the exact original saved public session,
canonical authority and current workspace membership. It does not call the
organization provisioning or activation helpers. The independent administrator
grant remains the global custody authority; normal account or workspace roles
cannot create one through this route.

The POST calls the existing Source handler in process with a closed caller
verification callback, and the existing handler still verifies Source's own
Production workload and exact enrolled deployment before key/provider access.
The external browser never obtains a Production workload token. The original
WLI-only `/api/hosted-operator/key-custody` and fixed receiver possession handler
keep their workload policies. The native operator service must route the exact
`/v1/key-custody/possession` path to the operator entrypoint. No public MCP tool,
operator runtime configuration, provider credential or signing service is added.

This first hop uses the deployment invocation's supported OIDC context. The
[project-token REST endpoint](https://vercel.com/docs/rest-api/projects/generate-a-project-oidc-token)
exposes only a `source` body field and documents no Production environment
selector. [Vercel's OIDC documentation](https://vercel.com/docs/oidc) describes
Function invocation tokens separately from local Development tokens; a management
API or local CLI token is not presumed to satisfy the Production policy.

Deliver and independently observe the corrected Source deployment before freezing
and enrolling its exact ID. The stable operation/grant selectors can remain;
no custody enrollment, Secret write or receiving key-injection refresh follows
from this source repair alone. Hosted acceptance still requires the separately
approved enrollment, original-owner form submission, approved receiver refresh,
nonce-bound possession receipt and independent readback of that saved operation.
