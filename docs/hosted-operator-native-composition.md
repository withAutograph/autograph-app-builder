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

Current native readers accept only nondefault Neon branches with `parent-schema`
or `schema-only` provenance. A new synthetic project's clean default `main`,
built from reviewed source with temporary qualification contexts derived from
it, is the proposed baseline; it requires a reviewed synthetic-origin enrollment
and readback change before operator use. Do not broadly permit default branches,
reset current Production storage, or treat a branch rename as migration. See the
[database target and safe sequence](plans/2026-10-07-hosted-operator-deployment-and-spend-review-qualification.md).

The deployment-owned configuration selects three distinct projects: app-only
Next, Gateway/Auth-only, and private operator. It supplies exact native project,
branch, repository and commit references; native Neon store/project/branch/endpoint;
actual operator/workload OIDC identities; immutable Sandbox image and worker
IDs/SHA256s; Auth/app database and role names; public browser/issuer origins;
and restricted application roles. Secrets and SQL URLs are never plan inputs.
Existing Gateway signing and Better Auth secrets, actual provider-injected
`VERCEL_DEPLOYMENT_ID`, and independently observed
`AUTH_PRODUCTION_DATABASE_IDENTITY` are setup prerequisites. No Production
connection string is supplied to the Preview realm or generated app.

Fresh app and Gateway projects need no seed deployments. Their configuration
retains exact team-owned project, Preview branch, repository and commit inputs;
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

Normal Git delivery is explicitly at least once. A completed no-match listing is
not absence; an approved retry can create additional owned matching Preview
deployments and provider usage charges. Known queued/building candidates are
observed without another POST. The existing journal retains every observed
candidate ID, pins one independently READY candidate matching the approved
project/environment/repository/commit/configuration, and does not rewrite the
old frozen inventory.

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
