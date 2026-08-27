# Hosted Eve bridge core

The repository contains a provider-neutral hosted service core, but it does not
yet configure or deploy a hosted bridge. The core deliberately separates four
boundaries:

1. The HTTP boundary accepts exactly one strict Bearer value. Its standards-
   compatible verifier interface has a concrete remote-JWKS implementation
   that requires the configured HTTPS issuer, an audience exactly equal to the
   canonical `/mcp` resource URL,
   allowed asymmetric algorithm, nonempty key ID, signature, integer expiry
   issued-at, expiry, and not-before times, a maximum 300-second token lifetime,
   OAuth scope string, and workspace claim. JWKS
   redirects and unexpected JWKS URLs are rejected. Any provider-specific
   revocation policy remains an adapter responsibility.
2. The authorization boundary requires the configured issuer, exact resource
   audience, every required scope, and a signed `workspace_id` claim as the sole
   workspace selector. It derives the owner only from the verified subject and
   performs a live exact subject/workspace membership read on every request.
   Missing, inactive, or unavailable membership fails closed before store or
   Eve access. Unknown claims fail closed instead of becoming implicit authority. The service additionally
   requires `eve:start`, `eve:get`, `eve:send`, `eve:respond`, or `eve:cancel`
   immediately before the corresponding operation and before store access.
3. The durable PostgreSQL `HostedEveStore` implementation scopes every session and operation
   predicate by issuer, audience, workspace, and owner. The interface has no
   unscoped lookup. Operation reservation and terminal settlement are atomic;
   successful start settlement atomically creates the tenant-owned session.
   Retention indexes support exact-tenant cleanup without adding an unscoped
   store method. Age-based retention never removes a `reserved` operation and
   deletes an old session only after no retained operation references it.
4. The same-origin HTTPS adapter implements `HostedEveTransport` against the
   canonical API emitted by installed Eve 0.43 and `withEve(nextConfig)`. It
   obtains a fresh Vercel project OIDC token for every hop, uses only the
   canonical create, continuation/input-response, stream, and cancel routes,
   and never forwards the user's Bearer token. The verified OAuth principal
   crosses the internal hop only as Eve's closed `forwardedPrincipal` metadata,
   accepted from one exact Vercel team/project/environment subject. Every MCP
   request must also match the exact configured resource URL before the
   adapter can open storage or send project identity, and stream reads require
   the pinned Eve 0.43 session, format, and protocol-version headers. The
   service exposes only `start`, `get`, `send`, `respond`, and `cancel`, and
   projects only public allowlisted events. Reasoning, tool results, system
   instructions, malformed events, continuation credentials, and adapter
   session identifiers never enter the public result.

The MCP route constructs its service inside each request. No principal is held
in module-global state. Hosted selection is explicit through
`EVE_HOSTED_ADAPTER=1`; it never falls back to the loopback or unconfigured
adapter. The signed, consent-bound `workspace_id` claim is the only workspace
selector; no independent client header can select or override the tenant. The
Preview auth database is the live membership authority. Invalid credentials return a 401
Bearer challenge, missing session scope returns the corresponding 403
challenge, and missing, mismatched, denied, or failed workspace lookups share
one content-free 404 projection. The protected-resource metadata endpoint is
`/.well-known/oauth-protected-resource`.

Preview configuration is one exact-origin contract: `/api/auth` is the issuer,
`/api/auth/jwks` is its non-redirecting key source, and `/mcp` is both audience
and resource. A separately hosted issuer, alternate path, query, credential,
or fragment is a configuration failure rather than an implied topology.
The forwarder environment is exactly `preview`; `production` and `development`
are rejected by the runtime parser rather than treated as future implied
authority.

The checked-in Next.js route now supplies the deployment composition without
weakening the provider-neutral service boundary. Constructing the route reads
no secret, opens no connection, and obtains no credential. On the first request
with `EVE_HOSTED_ADAPTER=1`, it validates the complete hosted configuration,
opens one bounded PostgreSQL pool, and composes the principal-free runtime. The
origin of the exact `/mcp` resource URL is also the canonical Eve origin; there
is no separately invented gateway service. Each internal hop obtains the
current Vercel invocation's project OIDC token and presents it directly to the
same project's Eve route auth. The user's principal is not used as workload
authority. Authentication,
authorization, membership, and session-service construction remain scoped to
each request. Invalid composition returns 503 and never falls back to the local
adapter. Unconfigured mode and the explicit loopback-only local adapter preserve
the same exact five MCP tools.

Hosted composition additionally requires a fresh closed admission-control
binding in `EVE_HOSTED_ADMISSION_CONTROL`. It binds exact per-subject and
per-workspace start limits, active/concurrent session ceilings, a monthly spend
ceiling, an observation window of at most 24 hours, and the SHA-256 digest of the
provider readback. Missing, stale, non-Preview, unknown, or out-of-range bindings
return 503 before storage opens. This is a fail-closed compensating-control
precondition; it is not an in-process rate limiter and does not prove the
provider actually enforced the values.

The MCP-side contract accepts no continuation credential and the durable store
schema has no field for one. Canonical Eve 0.43 routes use durable session IDs
and likewise require no continuation credential. Adding any new credential
field requires a new closed contract and migration rather than reusing `record`
as an opaque secret container.

## Idempotency and uncertain submissions

`start`, `send`, and `respond` reserve a tenant-bound operation before dispatch.
The client request ID is bound to a canonical request digest. A completed retry
returns the stored public result. Reusing the ID for different request bytes is
an error. If the adapter cannot prove whether Eve received the operation, the
store records `submission_unknown`; the same operation is never dispatched
again automatically. A still-`reserved` operation is also treated as unknown
after recovery because the process may have stopped after dispatch.
Reservation responses and unsuccessful settlements are parsed as closed
runtime discriminated unions and rebound to the exact principal, kind, client
request ID, request digest, state, and session before they grant any authority.
Unknown dispositions and mismatched store responses fail closed.
Successful settlement is also untrusted until its public result is canonically
exact and digest-equal to the dispatched result. A successful start additionally
requires the returned result, proposed new-session record, and an immediate
tenant-scoped store readback to bind the same session with exact record bytes.
The succeeded operation durably stores the exact session-record digest. Every
idempotent succeeded-start retry reloads the tenant-owned session and verifies
its schema, ID, principal, and digest before returning the cached public result;
an orphaned or changed session therefore cannot produce a false success.

`get` is observational. `cancel` remains cooperative and can be repeated; the
public contract currently has no client request ID for cancellation. Neither
operation weakens tenant ownership checks.

## Implemented proof and remaining external work

Unit conformance tests cover strict Bearer parsing, cryptographic JWKS token
verification, redirects, issued-at/expiry/not-before time, the 300-second
lifetime ceiling, exact claims, negative issuer/audience
and per-operation scope cases, cross-tenant access, malicious store responses,
all five operations, event disclosure, idempotent retry, request-ID conflict,
lost-response non-redispatch, and substituted success result/session rejection.
Missing and digest-mismatched session retry cases are also rejected without
redispatch. Route tests cover 401/403/indistinguishable-404 behavior,
request-scoped principals, no hosted-to-local fallback, and exact five-tool
local/hosted/unconfigured discovery. PostgreSQL row tests prove that duplicated
tenant/index columns are rebound to each closed JSON record before use; the
checked-in migration retains issuer, audience, workspace, owner, and
idempotency keys. Same-origin adapter tests cover fresh project OIDC
credentials, canonical routes, exact forwarded-principal projection, redirect
denial, closed response schemas, and the distinction between
proven pre-dispatch rejection and uncertain network submission. The in-memory
store remains test/local scaffolding.

Hosted activation still requires separately authorized work:

- separately authorize and activate the in-project Preview OAuth server. Mount
  the checked-in Better Auth policy and routes, compile and apply its generated
  schema, add the sign-in and consent surfaces, then prove its minted token. The
  issuer must record user consent and mint `workspace_id` from that record. The
  resource server still rechecks the exact active database membership on every
  request;
- read back the exact Preview provider request, concurrency, session, and spend
  controls; construct the closed, time-bounded admission-control binding from
  that evidence; and separately prove that the provider enforces it;
- apply the checked-in PostgreSQL migration with `mise run database:migrate` to
  an approved database and prove transaction behavior against that deployment;
- configure the exact Vercel team slug, project name, and environment used by
  the authored Eve channel's trusted-forwarder predicate, then prove project
  OIDC and installed Eve 0.43 event projection in Preview;
- deploy and prove hosted authentication, persistence, cancellation, and
  lost-response behavior; and
- publish an immutable Agent Plugins package pointing at that proven endpoint, and run
  Codex and non-Codex installation smokes.

Preview JWT access tokens are intentionally not denylisted or introspected.
They cannot be revoked immediately: removing a membership blocks the next MCP
request through the live database check, while the token remains
cryptographically valid for no more than five minutes. Do not claim immediate
token revocation or extend this Preview policy to Production.

## Preview database administration

Database administration is plan-first and identity-free at the receipt
boundary. Each task accepts one absolute, canonical, owner-only JSON request
file. Run `mise run hosted:admin-plan -- --request-file /absolute/request.json`,
approve its exact `requiredConfirmationDigest`, add that digest to the unchanged
request, and invoke only the matching task:

- `hosted:membership-seed` activates one exact issuer/resource/workspace/user;
- `hosted:membership-revoke` makes that membership fail its next live check;
- `hosted:retention-apply` removes old terminal operations, then only old
  sessions with no retained operation; and
- `hosted:tenant-delete` removes one exact tenant only after its membership has
  been inactive for at least five minutes.

Apply tasks receive `DATABASE_URL` only through task-scoped stdin, open one
PostgreSQL connection, and emit a strict sanitized receipt containing digests
and row counts only. Repository code grants no authority to run these
mutations. Revocation and deletion remain separate actions so access drains
before destructive cleanup. The deterministic hosted configuration receipt is
marked `source-configuration-only`, contains source and contract digests plus
explicit no-secret and no-immediate-revocation claims, and records
`activation.status=not-proven` without endpoint, tenant, or provider values. A
separate future activation receipt schema accepts only digest-bound live
deployment, OAuth metadata, minted-token, migration, admission-control,
workload-identity, tenant-isolation, and five-tool lifecycle proof. It cannot
create or activate any of them.

The aligned Better Auth 1.7.1 MCP, CIMD, and OAuth Provider packages and the
non-mounted typed Preview policy are checked in. That policy selects
operator-provisioned email/password login with public signup disabled,
authorization code/S256 PKCE, explicit consent, CIMD-first client identity,
public `none` client authentication, and exact resource/scope ceilings. Dynamic
client registration stays disabled: enabling it would mutate the authorization
server client registry and needs separate authority. Activating CIMD is also a
separately authorized mutation because discovery may create, persist, or refresh
an authorization-server client record. The application-owned metadata transport
rejects any client whose `token_endpoint_auth_method` is not exactly `none`,
including `private_key_jwt`. CIMD metadata advertises the client's exact RFC 8252
loopback redirect URI, including its runtime-chosen port, and the authorization
request still requires S256 PKCE. The policy also
sets a 300-second access-token TTL and sources the `workspace_id` claim from the
consented active membership. It deliberately does not mount an issuer,
compile/apply the Better Auth schema, provide login/consent pages, or mint a
grant. Those activation steps require separate OAuth issuer/provider authority
and a real minted-token integration proof showing integer `nbf`, the exact
resource audience, `workspace_id`, and a lifetime no greater than 300 seconds.

No database, provider, deployment, plugin registration, or remote repository is
changed by this slice. The loopback local adapter remains the only configured
runtime adapter.
