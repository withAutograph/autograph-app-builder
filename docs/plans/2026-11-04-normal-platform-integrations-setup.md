# Normal existing-platform Integrations setup and custody

Status: design before implementation or effects. The verified-reference consumer
is implemented separately; it does not provision missing infrastructure. This
plan closes that gap through the existing Builder product controls. No hosted
acceptance, resource ownership or caller grant is asserted by this document.

## Destination and source ownership

The saved app keeps its one recorded `apps-<app-id>` Services project, repository,
public app domain and BetterAuth realm. The privileged operator remains separate
infrastructure. This plan has no Vercel project-create effect and creates no
acceptance app, Auth project or integration-backend project.

A shared control plane may use an independently verified **already-owned** normal
platform Services project. The setup plan names that platform project separately
from the initiating app's recorded destination. They must not be confused with
one another, and an operator inspector must not impersonate the new app caller.
Do not copy global platform/provider credentials into the generated app project.
If a proposed composition cannot prove this credential boundary, return an
explicit prerequisite; never quietly install the control plane in user-authored
Services or create another project.

Use the existing Services (Beta) factory and bounded custom Gateway. The selected
normal catalog contains Gateway, the platform Shell with canonical BetterAuth
routes, and Integrations; it excludes unrelated customer app Services and their
bindings. There is no `AUTOGRAPH_DEPLOYMENT_PROFILE` override and no
`isolated-central-integrations-v1` source receipt. The source is the reviewed
platform-owned repository, not the generated app or its evaluator.

An already-correct normal Production-hosted reference may be consumed read-only
with dedicated development/Sandbox resources. New setup defaults to a separately
approved operation branch and Preview-scoped bindings on the existing platform
project. It must preserve customer Production deployments, environments, data,
provider installations, branches and aliases. Their rollout remains A-481.
The app's own Production-domain public release remains a different normal intent.

Follow the [native deployment contract](https://github.com/withAutograph/arrusted-development/blob/main/docs/plans/2026-08-18-vercel-native-deployment-conformance.md):
Git publication, native Services deployment, provider-owned activation, Gateway
routing, then read-only proof. No deployment POST, promote, alias writer,
deployment-list election, Git/PR/SHA selector or reconstructed branch origin.

## Product entry points and durable intent

Keep the five public MCP tools. Extend the existing internal central plan,
prepare and read tools with explicit `normal-setup` and `normal-caller` intent
kinds; the current isolated kinds remain legacy maintenance only. Fresh app
capability V3 cannot fall back to them.

A deployment-owned normal infrastructure policy selects the permitted existing
platform project/repository/installation, resource owner, reviewed worker
capabilities, provider Sandbox selection and mutation authority. It is shared
infrastructure policy, not a manual per-new-app READY/profile entry. Ambiguous or
missing existing-project authority becomes an ordinary owner-selection question
or typed prerequisite before effects. Project names alone prove no ownership.

Reserve a new owner-scoped normal operation record with a canonical plan digest,
separate namespace, fresh approval and effect checkpoints. Freeze the actual
platform source, physical destination, development resource scope, exact
branch/environment keys, access policy, costs and native event receiver. Keep
private credential custody encrypted and separate from public plan/artifact data.
Never reinterpret an old isolated plan, worker catalog, approval, receipt or
`a469-preview-target-approved-batch`; uncertain outcomes retain their meaning.

## Setup effects and proof

The normal setup uses explicit, ordered effects:

1. Prepare or reuse the approved dedicated development control resource through
   the real native-Neon/resource ports. Record accepted provider identities and
   independently read ownership, project/branch/endpoint and physical database.
2. Install and independently verify the fixed control schema, restricted central
   runtime principal, activation authority and schema hash. Resource allocation
   alone is not an installed central-control receipt.
3. Register the bounded signed native deployment-event receiver and the actual
   operator readiness inspector access. The inspector identity is separately
   authenticated and never stored as the app's caller proof.
4. Bind only the reviewed branch-scoped normal runtime environment and public
   configuration fingerprint, preserving inherited/unrelated keys. Audit the
   effective configuration for every selected Service before publication; no
   customer Production credentials may enter the development composition.
5. Publish the reviewed ordinary Services source on its owned Git branch after
   resource, receiver and binding receipts exist. Capture one actual native
   deployment ID from authenticated provider events, then read that exact resource.

If normal Gateway/Shell startup needs a development Auth realm, its actual owned
resource and approved binding must be proved through supported resource mechanics
before freezing setup. Qualify this source path before provider effects. Do not
use customer Auth credentials, a placeholder Auth flag, an acceptance-app alias,
a separate Auth project or an evaluator-written backend to make it start. The
app's public login/logout remains the canonical BetterAuth UI/API in its own
normal composition; private local app-port preview is not proof of those routes.

Normal setup gets an additive worker/source-capture contract. Legacy isolated
workers require their original source/profile semantics and must not receive a
normal plan disguised as V1. Capture and verify the real normal catalog/Services
graph and complete source inventory, including binary files and the selected
worker bytes; use fresh owned staging, never overlay a previous authored bundle.
Normal graph/handler startup and independent resource proof are prerequisites to
an effect-approved setup, not work for the generated app evaluator to finish.

## Immutable control-resource custody

Only completed resource/schema effects plus independent native-Neon/SQL readback
can publish the normal control custody receipt. Bind owner authority, actual
resource/profile IDs, Neon project/branch/endpoint, host/database, migrator and
central-runtime roles, installed schema and dedicated-development data scope.
Store its immutable receipt reference and digest. Routine settled-history pruning
must preserve current control custody, encrypted private custody, shared ready
selection and current grant authority; explicit authorized forget remains a
separate policy. A metadata selection is never provider-effect settlement. A selected or pending app/Auth
policy, reflected environment IDs or an old app onboarding row cannot substitute.
Do not invent a customer Production database identity merely to satisfy an old
exclusion field: use genuine known exclusion metadata or an additive normal
provenance-backed resource contract; retain legacy validation unchanged.

The verified reference consumer's `readExistingPlatformControlResource` port must
read that actual custody and independently re-read the physical resource. Its
`readPlatform` preflight then verifies ownership, native activation, loaded
normal configuration, activation key, restricted SQL schema/principal and actual
QuickBooks Sandbox project/integration selection. It returns a bounded shared
reference digest without any app-caller claim. The normal reference READY family
uses version 2/kind `existing-platform-integrations-ready-v1`; hosting environment
is independent of the retained `resource.environment: preview` isolation marker.

Resolve newly completed normal setup from its owner-scoped journal/custody rather
than asking the operator or evaluator to paste a READY JSON/env entry for each
app. The deployment policy chooses allowed infrastructure; real recorded receipts
supply completed facts and encrypted custody supplies protected values.

## Fresh normal app capability profile

A fresh normal app must not require an administrator to add its app ID to the
old per-app capability environment map. Retain those frozen explicit profiles
for their original callers; introduce an explicit normal enrollment policy and
derive the restricted control SQL identity from the authenticated owner, app,
recorded project and provisioning receipt. The derivation remains stable across
ordinary revisions and distinct between apps; it transfers no old approval.

Service membership is separate from a human app role. Read the checked,
source-declared supported integration service policy from the selected schema
release and prove its actual service actor/role privileges. Read the real Auth
realm/enrollment, organization ownership and app-assignment scope independently.
If organization selection is missing, use an ordinary product choice; do not
invent tenant IDs, duplicate another realm's organization ID, substitute a human
Finance role or import an acceptance fixture. The same-tenant/two-app connection
journey must use a real supported tenant/realm binding or approved development
realm reuse, rather than fabricating shared tenant identity across app databases.

### Explicit shared development Auth realm choice

The compatible first implementation is approved reuse of a genuine shared
development Auth realm. Keep dedicated per-app Auth as the ordinary independent
app default. Before a **fresh hosted app's first Auth setup**, Builder may offer
the authenticated owner a recorded, currently authorized development realm and
its real organizations. This choice is part of the normal setup plan and fresh
effect approval; a read allowlist alone cannot authorize enrollment or grants.
No already-configured app changes realm, and the saved local app's current realm
and data remain intact. Never provision the realm's existing Auth tables again.

The deployment-owned reuse policy names an enrolled realm by immutable custody
reference, not by an app-ID alias, copied organization string, arbitrary database
URL or an assertion that two tenants are equivalent. Its custody binds the real
realm owner, dedicated development resource identity, Auth deployment and
installed schema. Independently re-read the actual resource, registered realm,
organization ownership, current enrollment and app assignment before freezing
the choice and again before applying it. Missing or ambiguous proof produces an
ordinary owner choice or explicit prerequisite with no effects. Customer
Production realms and the global platform/operator Auth realm are not candidates.

Reuse must retain one real organization identity within that same realm, while
creating a distinct registered application and least-privilege assignment for
each app. A signed-in member without that app's assignment must still be denied.
The central tenant is the proven organization in this genuine shared realm;
Builder must not copy an organization ID into a different Auth database or infer
a canonical tenant mapping across realms. Each app keeps its independent app
database, project and capability binding, and disabling one app preserves the
other app and shared tenant-owned connection.

Qualify the credential boundary before enabling this choice. Prefer the existing
supported Auth authority/transport with an app-scoped, audience-bound enrollment
and verification capability. Do not copy realm migrator credentials, a global
Auth signing secret, platform control keys or provider keys into a generated app
project. If the current Auth adapter requires such broad credentials, implement
and qualify its least-privilege shared-realm transport inside the shared product
before offering reuse; do not weaken the boundary to make acceptance pass. Store
the selected realm and completed app enrollment/assignment receipts durably,
owner-scoped and protected from routine history pruning. Ordinary revisions
preserve that choice; revocation, removal or a new destination requires its own
explicit supported plan rather than transferring a previous approval.

Freeze the selected policy and actor/org/assignment evidence into the fresh V3
capability plan and disclose those grants in its ordinary approval. The fixed
membership worker must validate the installed service policy and actual scope
before applying a grant, and independently read it back. Removing/changing real
permission authority needs the corresponding fresh normal plan; ordinary source
changes alone are not a reason to rescope resources or rewrite history.

## Fresh app caller registration

A new app obtains caller identity only from its canonical normal provisioning
receipt and independent installation/project readback. If the actual grant is
absent, prepare a fresh `normal-caller` plan bound to the verified platform
preflight digest, initiating app/repository/provisioning identity, actual
Production workload and exact prior Trusted Sources snapshot hash.

The platform owner, or an explicit trusted delegation limited to this registered
Builder app and permitted environment pair, must authorize the platform mutation.
A read allowlist or app-owner Build approval alone does not grant arbitrary
platform administration. The ordinary approval discloses the exact platform and
caller projects and the provider's full environment-pair scope. Do not promise
branch/origin-only Vercel scoping or weaken deployment protection.

The effect changes only that caller's reviewed grant, preserves other project
rules/defaults, checks CAS/target lease authority and independently reads it back.
Its receipt is a new normal receipt, not a synthetic legacy setup/caller UUID.
Per-caller effective-grant digests exclude unrelated callers so registering app B
does not invalidate app A. Signed application/tenant authority still protects
control operations after transport succeeds.

With both real resource and caller proof available, ordinary capability V3 can
prepare its five separately approved app-scoped effects and attach to the app's
normal public release. Missing setup, physical proof or caller registration stays
a typed, actionable product prerequisite. It never starts the isolated path.

## Development iteration

Develop Builder changes against the maintained local Builder, following the
[local lifecycle guide](../local-development-lifecycle.md). Parallel sessions use
separate worktrees, ports, durable state/cycles, generated destinations, outputs
and client profiles. Resume the owned cycle with its genuine native state and
actual selected dependencies; copied source alone is not runtime alignment.
Local qualification precedes the one bundled shared Builder release used for
final hosted acceptance. A PR/shared deployment is not required for every edit.

## Recovery and qualification

Preserve pending/accepted/verified distinctions and all old work. Unknown external
writes are reconciled through recorded IDs and independent readback; they are
never blindly resent. Conflicting native IDs remain visible. Caller cancellation
prevents new effects, while accepted receipts are retained. Take connection then
binding locks in their documented order; do not parallelize them.

Use focused checks for new normal intent admission/approval, no project-create
port, resource custody/readback, cross-owner denial, caller CAS and peer retention,
normal source capture, native event conflicts, credential absence and strict
legacy rejection. Then exercise the real create/public-release/revision and
QuickBooks/isolation/lifecycle matrix through the public Builder. Source tests,
local private preview, native READY and successful inspector calls remain distinct
from public BetterAuth, provider activation and canonical-data acceptance. Broad
CI stays deferred until functional completion.
