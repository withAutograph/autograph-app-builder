# Shared Development Auth transport contract

This refines the approved shared Development realm option in the normal platform
Integrations setup plan. It preserves existing dedicated per-app Auth, old
adoption receipts and the saved local realm. It does not select a live realm or
authorize any provider effect.

## Placement and ownership

The realm is privileged Auth infrastructure within the supported existing
platform Services composition. Its data is an independently owned isolated
Development Auth resource. It is neither the global platform/operator realm nor
a customer Production realm. A generated first app's dedicated Auth database
cannot become this authority by alias: that project already receives its own
Auth credentials and is not a least-privilege shared authority.

Gateway, Auth and application slots remain in each generated repository's normal
single-project Services composition. In shared mode its existing Auth slot uses
a package adapter. The operator performs privileged setup only; it does not
become a runtime Auth backend. Add no separate Auth project, standalone backend,
public Builder tool or evaluator-only route.

## Closed public descriptor and private custody

The new browser-safe contract is versioned independently from existing public
realm and standard-runtime schemas. An absent shared descriptor retains all
existing meaning. The descriptor carries no secret, database URL or credential.

```ts
type SharedDevelopmentAuthApplication = {
  version: 1;
  kind: "shared-development-auth-application-v1";
  realm: {
    id: string;
    custodyRef: string;
    custodyDigest: string;
    installedSchemaDigest: string;
    authOrigin: string;
    providerProjectId: string;
    providerOwnerId: string;
  };
  enrollment: {
    ref: string;
    generation: number;
    appId: string;
    publicOrigin: string;
    ownerDigest: string;
    provisioningRequestId: string;
    provisioningDigest: string;
    organizationIds: readonly string[];
    rolePolicyDigest: string;
    caller: {
      issuer: string;
      audience: string;
      subject: string;
      projectId: string;
      ownerId: string;
      environment: "production";
    };
  };
  transport: {
    path: "/api/auth/platform/shared-development-app";
    protocol: "shared-development-auth-transport-v1";
  };
};
```

Use strict schemas, exact HTTPS origins and canonical digests/UUIDs. Provider
metadata identifies the actual realm/app projects; it is not a deployment or
enrollment approval. Realm custody separately binds the actual nondefault
Development database/roles/resource, installed Auth schema, privileged Auth
service and current owner. Re-read independent physical and owner proof before
selection, plan, enrollment and runtime use. Never accept a caller's database
locator or reinterpret an old per-app profile as this descriptor.

Builder and CoreAuth use a separately authenticated enrollment read port:

```ts
type ReadSharedDevelopmentEnrollment = (input: {
  enrollmentRef: string;
  signal?: AbortSignal;
}) => Promise<
  | {
      active: true;
      application: SharedDevelopmentAuthApplication;
      receiptDigest: string;
    }
  | undefined
>;
```

The port implementation supplies actual owner/custody and completed enrollment
proof, not a permissive default. Runtime caller verification is an injected
provider-neutral port returning verified issuer/audience/subject/project/owner/
environment. Existing maintained Gateway/Vercel adapters supply it; do not add a
private provider adapter or trust copied header/body claims.

## Realm-held BetterAuth instance

CoreAuth exports a realm-only scoped factory. Inputs are the verified active
application descriptor and the realm host's validated Development pool/resource
and dedicated realm-held secret. They are private in-memory inputs, never a
transport response or generated environment value. The factory returns an
ordinary BetterAuth instance plus normal context readers for that application.

Derive the instance session secret inside the realm with HKDF-SHA256 using a
versioned domain separator and the immutable realm/enrollment/app/public-origin
tuple. Set a per-enrollment cookie namespace, exact app host/origin and secure
host-only cookies. Remove inherited global secret-rotation fallback, cross-domain
cookies, alternate base-URL overrides and unrelated OAuth proxy secrets. Do not
return or install the derived secret in a generated project. Add an explicit
reviewed cookie-namespace port to normal Auth construction rather than patching
installed dependencies or fabricating cookies.

Qualify actual BetterAuth behavior with one real shared test store: A sign-in
produces its real secure cookie and current session; B rejects A's cookie and a
namespace-tampered copy; A logout invalidates A normally; origin/Host mismatch,
revoked enrollment, expired sessions and an unassigned member deny access.
Negative tampering tests are not an acceptance shortcut. Existing nonshared
sessions, OAuth agent/canvas consent and key rotation retain their meaning.

## Fixed normal runtime transport

The app Auth adapter sends only the immutable enrollment reference and a strict
operation envelope. The realm derives app identity, public origin and allowed
scope from the active registry and actual verified caller. Request fields cannot
select a different application, realm, project, origin or database.

Initial normal HTTP operations are email sign-in, get-session, sign-out,
organization list and active-organization selection needed by existing Auth UI.
Each maps to a fixed maintained BetterAuth path/method; arbitrary paths, dynamic
method forwarding, organization creation/invitation/grants, admin endpoints and
OAuth/provider endpoints are unavailable through this bridge. Preserve the
realm's existing signup and account policy; extending normal account operations
requires an explicit reviewed allowlist.

Private read operations are `app-context`, `app-grant-context`,
`organization-role` and the existing app-scoped `integration-authority` check.
They invoke maintained session, membership, organization, assignment and role/
fence checks against the exact scoped instance and realm pool. Named customer
selection still requires the real actor's membership in that same realm.
Required roles come from the app's captured service policy. No caller-supplied
role or organization string grants authority.

The realm passes only the verified app origin to BetterAuth request/origin and
callback handling. Preserve CSRF, secure cookies, current membership and normal
session expiry. Reject cross-origin redirects and Domain cookies. The existing
Auth slot relays genuine realm-produced cookies and bounded normal API responses
without reconstructing a session cookie. Server-only context readers and Gateway
authorization use the same app-bound port; shared mode never falls back to a
local Auth database or a global secret.

Use provider-verified app workload identity on the fixed private endpoint, with
redirects disabled and cancellation propagated. Strip transport credentials
before invoking the ordinary Auth handler. Re-read current enrollment around
I/O; revoke or change returns a typed prerequisite/denial. Raw cookies,
passwords, tokens, request bodies and private responses are transient and must
not enter model output, retained diagnostics, traces or source artifacts. Keep
useful bounded error categories and event references.

## Builder selection, effects and release

Before a fresh hosted app's first Auth setup, the authenticated owner can select
an actually enrolled eligible Development realm and real owned organizations.
Use ordinary authenticated Server Actions/public Builder continuation, with
owner/app/exact normal provisioning destination CAS and retained choice/receipt.
No existing app or dispatched uncertain setup may change its realm.

A fresh setup plan discloses realm custody/schema, app origin/caller, real
organization identity and proposed per-app assignment. Ordinary approval covers
registering that distinct app and its least-privilege grants. Existing Auth
tables are not provisioned again. The completed receipt binds exact request,
owner, destination, realm, orgs, role policy, caller and native effect evidence;
keep it outside routine retention pruning. An absent/ambiguous readback remains
a visible prerequisite.

Shared release configuration consumes that genuine receipt and installs only
the public descriptor plus the app's own independent Gateway identity. Omit
Auth database/runtime/migrator URLs, `BETTER_AUTH_SECRET`, global rotation keys,
realm/control signing keys and provider credentials from generated delivery.
Default local/dedicated paths remain unchanged. Revisions preserve the recorded
choice. Revoking one app denies its sessions/assignments and drains its binding
without deleting the realm, real organizations, other app or shared connection.

The two-app acceptance uses one genuine organization in this shared realm as
the canonical tenant ID. There is no cross-realm org-ID copy or inferred tenant
mapping. Each app retains its separate project, database, installation and
capability binding. Two tenants and an unassigned signed-in member still require
observed isolation.

## Parallel implementation and qualification

CoreAuth lane owns the neutral strict descriptor/transport contract, scoped
BetterAuth factory, normal HTTP/context adapter, existing Auth route assembly and
actual same-store cookie/assignment tests. Builder lane owns eligible owner
choice/custody readback, retained selection/enrollment plan/receipt, runtime
resolver and no-secret public-release configuration. Normal platform Integrations
control setup remains a separate coordinated lane; do not block it on a schema
alias or copy credential adoption into its dynamic membership producer.

Select the final shared source cuts only after the paired ports compose. Rebuild
and independently verify every affected worker/catalog family from those cuts.
Then exercise actual provider workload transport, public BetterAuth login/logout,
same-tenant/two-app connection sharing and the remaining A-469 matrix. Source
tests, matching IDs and READY deployment metadata are distinct evidence.
