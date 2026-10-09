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
