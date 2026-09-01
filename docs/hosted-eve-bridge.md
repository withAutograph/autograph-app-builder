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
   requires `autograph:start`, `autograph:get`, `autograph:send`, `autograph:respond`, or `autograph:cancel`
   immediately before the corresponding operation and before store access.
3. The durable PostgreSQL `HostedEveStore` implementation scopes every session and operation
   predicate by issuer, audience, workspace, and owner. The interface has no
   unscoped lookup. Operation reservation and terminal settlement are atomic;
   successful start settlement atomically creates the tenant-owned session.
   Retention indexes support exact-tenant cleanup without adding an unscoped
   store method. Age-based retention never removes a `reserved` operation and
   deletes an old session only after no retained operation references it.
   The provider-publication boundary has a separate PostgreSQL compare-and-set
   journal keyed by exact proposal digest. Its duplicated receipt digest,
   idempotency key, kind, and state are rebound to the closed receipt on every
   read. It is intentionally outside tenant retention: pending or terminal
   provider mutation authority must not disappear and permit redispatch.
4. The same-origin HTTPS adapter implements `HostedEveTransport` against the
   canonical API emitted by installed Eve 0.44.4 and `withEve(nextConfig)`. It
   obtains a fresh Vercel project OIDC token for every hop, uses only the
   canonical create, continuation/input-response, stream, and cancel routes,
   and never forwards the user's Bearer token. The verified OAuth principal
   crosses the internal hop only as Eve's closed `forwardedPrincipal` metadata,
   accepted from one exact Vercel team/project/environment subject. Every MCP
   request must also match the exact configured resource URL before the
   adapter can open storage or send project identity, and stream reads require
   the pinned Eve 0.44.4 session, format, and protocol-version headers. The
   service exposes only `start`, `get`, `send`, `respond`, and `cancel`, and
   projects only public allowlisted events. Reasoning, tool results, system
   instructions, malformed events, continuation credentials, and adapter
   session identifiers never enter the public result.

The MCP route constructs its service inside each request. No principal is held
in module-global state. Hosted selection is explicit through
`EVE_HOSTED_ADAPTER=1`; it never falls back to the loopback or unconfigured
adapter. The signed, consent-bound `workspace_id` claim is the only workspace
selector; no independent client header can select or override the tenant. The
configured hosted auth database is the live membership authority. Invalid
credentials return a 401 Bearer challenge, missing session scope returns the corresponding 403
challenge, and missing, mismatched, denied, or failed workspace lookups share
one content-free 404 projection. The protected-resource metadata endpoint is
`/.well-known/oauth-protected-resource`.

Hosted configuration is one exact-origin contract: `/api/auth` is the issuer,
`/api/auth/jwks` is its non-redirecting key source, and `/mcp` is both audience
and resource. A separately hosted issuer, alternate path, query, credential,
or fragment is a configuration failure rather than an implied topology.
The runtime accepts only `preview` or `production`, and only when Vercel's
`VERCEL_ENV` exactly equals `EVE_HOSTED_VERCEL_ENVIRONMENT`. The exact team and
project remain part of the trusted-forwarder subject. Missing, Development,
wildcard, or mismatched bindings fail closed. This source capability is not a
Production activation or deployment receipt; the existing checked-in live
activation receipt remains Preview-only.

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
observation plus ceiling, an observation window of at most 24 hours, and the
SHA-256 digest of the provider readback. Missing, stale,
environment-mismatched, unknown, or out-of-range bindings return 503 before
storage opens. The durable start
reservation serializes and enforces the rate/session fields before Eve
dispatch, and every observed public session result refreshes active status.

The MCP-side contract accepts no continuation credential and the durable store
schema has no field for one. Canonical Eve 0.44.4 routes use durable session IDs
and likewise require no continuation credential. Adding any new credential
field requires a new closed contract and migration rather than reusing `record`
as an opaque secret container.

Hosted session handles remain tenant-scoped and resumable until explicitly
deleted. The 30-minute idle and 24-hour lifetime windows apply only to compute
and admission accounting: expired active rows no longer consume a new-start
slot, but their product history remains readable. Bounded checkpoints retain
the latest public product events, outstanding input, prototype, and plan.
Unchanged `working` observations cannot refresh an execution lease forever; the
service marks the session checkpoint-resumable and fences any replacement
adapter generation. The separately confirmed retention task remains the only
age-based deletion path.

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

The hosted sandbox command adapter bounds every template and live-session
command. Durable execution leasing is a separately dormant source capability,
enabled only by the exact `EVE_HOSTED_SANDBOX_EXECUTION=enabled-v1` deployment
gate. It acquires at `turn.started`, reasserts the current PostgreSQL epoch
before each command, and releases at terminal turn boundaries rather than at
an interim `session.waiting` authorization park. The Mise-owned PostgreSQL
behavioral task proves admission concurrency, replay, rollback, expiry,
heartbeat, recovery races, and fail-closed admission after a provider stop
failure. Failed stops remain fenced and orphaned while the rest of the batch
continues; only successful stops release their leases. This does not prove or
activate provider-side orphan lookup and stop, so hosted enforcement and
Production readiness remain unclaimed.

Hosted activation still requires separately authorized work:

- apply the checked-in Better Auth Preview migration, configure its exact
  same-origin environment, and prove discovery, sign-in, consent, the
  single-active-workspace binding, and a minted token. The mounted routes
  remain fail-closed without that configuration and unapplied schema. The
  issuer records user consent and derives `workspace_id` from the exact live
  membership; the resource server rechecks that membership on every request;
- read back the exact Preview provider request, concurrency, session, and spend
  controls; construct the closed, time-bounded admission-control binding from
  that evidence. The runtime rejects starts when observed monthly spend reaches
  the ceiling and atomically enforces the per-subject/workspace start and
  active-session ceilings in its durable reservation transaction;
- establish a separately evidenced Preview restore point, apply the five
  checked-in additive PostgreSQL migrations with `mise run database:migrate`,
  then run `mise run hosted:storage-verify`. The verifier opens one bounded
  pooled connection, uses a read-only transaction, and emits only schema and
  contract digests/counts. It refuses migration-order, managed-object, or
  read-only drift and honestly leaves the provider restore point `not-proven`;
- configure the exact Vercel team slug, project name, and environment used by
  the authored Eve channel's trusted-forwarder predicate, then prove project
  OIDC and installed Eve 0.44.4 event projection in Preview;
- deploy and prove hosted authentication, persistence, cancellation, and
  lost-response behavior; and
- publish an immutable Agent Plugins package pointing at that proven endpoint, and run
  Codex and non-Codex installation smokes.

Hosted JWT access tokens are intentionally not denylisted or introspected.
They cannot be revoked immediately: removing a membership blocks the next MCP
request through the live database check, while the token remains
cryptographically valid for no more than five minutes. Public clients receive
an eight-hour, rotated refresh token only when they request `offline_access`;
every MCP request made with a refreshed access token still passes the resource
server's live membership check. Do not claim immediate token revocation or a
Production activation without separate live evidence.

The closed `autograph-ext-bld-05-evidence-v1` receipt aggregates only accepted
digest references for the exact source SHA/tree: a two-subject live lifecycle,
membership revocation, retention, drained tenant deletion, public-response plus
provider-log disclosure scans, and exact-source validation of timeout and Eve
0.43 session-ID-only continuation semantics. It contains no subject, workspace,
endpoint, token, or database value and explicitly cannot claim Production
readiness.

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

Preview activation prerequisites use the same plan-first boundary. Prepare one
absolute owner-only request, run `mise run hosted:activation-plan`, approve its
exact confirmation digest, then invoke only the matching task:

- `hosted:runtime-role-configure` creates or verifies a non-owner login role,
  fixes it to `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`, and the other safe
  non-owner attributes, rejects every role membership, clears existing object
  grants, then grants only connect, public-schema usage, table read/write, and
  sequence usage/read. It applies the owner-only requested credential and emits
  exact privilege/attribute booleans without that password;
- `hosted:oauth-initialize` initializes the single exact resource and ES256 JWKS
  through the real Better Auth handler and reports bounded pre/post row counts;
  and
- `hosted:invited-user-provision` binds one operator-invited stable GitHub
  account ID to a verified user plus that user's sole active workspace membership in one SQL
  transaction. The membership write follows migration `0002` exactly and uses
  `updated_at` as its lifecycle timestamp. Exact retries prove the stored
  GitHub identity and return a no-op receipt; conflicts fail closed. No user
  password is accepted or stored. A failed user,
  account, or membership write rolls back the whole provisioning attempt.

Secrets remain only in the owner-only request and the database URL remains on
task-scoped stdin. Public signup stays disabled by the closed runtime policy.
Repository tests use pure stores and never invoke these mutating adapters.

The aligned Better Auth 1.7.1 MCP, CIMD, and OAuth Provider packages and the
hosted issuer are checked in. The issuer is mounted at `/api/auth`, with
an RFC OAuth authorization-server discovery rewrite, `/api/auth/jwks`, and
explicit sign-in and a single verified-client consent surface that binds the
sole active workspace. The scope contract does not advertise OpenID discovery.
Construction is
lazy and fail-closed: importing a route does not parse secrets, connect to the
database, generate keys, register a client, or mint a grant. The policy selects
operator-provisioned GitHub identity with public signup and implicit email
linking disabled, authorization code/S256 PKCE plus rotated refresh tokens,
explicit consent, CIMD-first
client identity, public `none` client authentication, and exact resource/scope
ceilings. Signed-query public-client prelogin verifies the client identity and
exact requested scopes before consent, while every client/resource management
action is denied. Dynamic
client registration stays disabled: enabling it would mutate the authorization
server client registry and needs separate authority. Activating CIMD is also a
separately authorized mutation because discovery may create, persist, or refresh
an authorization-server client record. The application-owned metadata transport
rejects any client whose `token_endpoint_auth_method` is not exactly `none`,
including `private_key_jwt`. CIMD metadata advertises the client's exact RFC 8252
loopback redirect URI, including its runtime-chosen port, and the authorization
request still requires S256 PKCE. The policy also
sets a 300-second access-token TTL and sources the `workspace_id` claim from the
consented active membership. The checked-in migration remains unapplied and no
client, consent, grant, key, or token exists merely because the routes are
present. Live activation still requires the separately authorized migration,
environment, membership, CIMD persistence, consent/grant, and minted-token
proof showing integer `nbf`, the exact resource audience, `workspace_id`, and a
lifetime no greater than 300 seconds.
The first configured request may overwrite the exact resource seed and create
the first ES256 JWKS key pair. Those are explicit, separately authorized
PostgreSQL mutations; route mounting and source receipts authorize neither.
The repository-level memory-adapter test proves real OAuth AS metadata, ES256
public JWKS, absent OpenID metadata, management denial, GET and form POST
authorization, CIMD resolution, signed-query client/scope display, allow and
deny, no-consent denial, S256 exchange, exact five-minute resource/workspace
claims, and membership drift before consent or exchange. Exactly one active
workspace proceeds directly to the single consent surface; zero or multiple
memberships fail before consent even with `prompt=consent`. No workspace
selection continuation, generic proxy, or compatibility patch is installed.
The proof still uses an in-memory adapter and is not a deployed-issuer or live
PostgreSQL activation receipt.

No database, provider, deployment, plugin registration, or remote repository is
changed by this slice. The loopback local adapter remains the only configured
runtime adapter.
