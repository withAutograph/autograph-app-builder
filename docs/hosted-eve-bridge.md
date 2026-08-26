# Hosted Eve bridge core

The repository contains a provider-neutral hosted service core, but it does not
yet configure or deploy a hosted bridge. The core deliberately separates four
boundaries:

1. The HTTP boundary accepts exactly one strict Bearer value. Its standards-
   compatible verifier interface has a concrete remote-JWKS implementation
   that requires the configured HTTPS issuer, one exact string audience,
   allowed asymmetric algorithm, nonempty key ID, signature, integer expiry
   and not-before times, OAuth scope string, and workspace claim. JWKS
   redirects and unexpected JWKS URLs are rejected. Any provider-specific
   revocation policy remains an adapter responsibility.
2. The authorization boundary requires the configured issuer, one exact
   audience, every required scope, and the exact workspace selected by the
   request. It derives the owner only from the verified subject. Unknown claims
   fail closed instead of becoming implicit authority. The service additionally
   requires `eve:start`, `eve:get`, `eve:send`, `eve:respond`, or `eve:cancel`
   immediately before the corresponding operation and before store access.
3. The durable PostgreSQL `HostedEveStore` implementation scopes every session and operation
   predicate by issuer, audience, workspace, and owner. The interface has no
   unscoped lookup. Operation reservation and terminal settlement are atomic;
   successful start settlement atomically creates the tenant-owned session.
4. The provider-neutral HTTPS adapter implements `HostedEveTransport` and the
   membership boundary. It obtains a fresh, separately injected workload token
   for every hop, uses fixed HTTPS paths with manual redirects, bounds and
   strictly parses responses, and never forwards the user's Bearer token. The service exposes only
   `start`, `get`, `send`, `respond`, and `cancel`, and projects only public
   allowlisted events. Reasoning, tool results, system instructions, malformed
   events, continuation credentials, and adapter session identifiers never
   enter the public result.

The MCP route constructs its service inside each request. No principal is held
in module-global state. Hosted selection is explicit through
`EVE_HOSTED_ADAPTER=1`; it never falls back to the loopback or unconfigured
adapter. The request must select one workspace in `X-Eve-Workspace-Id`, the
verified claim must bind that exact workspace, and a separately supplied
membership adapter must affirm membership. Invalid credentials return a 401
Bearer challenge, missing session scope returns the corresponding 403
challenge, and missing, mismatched, denied, or failed workspace lookups share
one content-free 404 projection. The protected-resource metadata endpoint is
`/.well-known/oauth-protected-resource`.

The checked-in Next.js composition deliberately supplies no database handle or
workload identity. Enabling hosted mode there therefore returns a fail-closed
503 until those capabilities are supplied together by separately authorized
deployment composition through `composeHostedMcpRuntime`. That pure composition
boundary reads no environment, opens no connection, and obtains no credential.
Unconfigured mode and the explicit
loopback-only local adapter preserve the same exact five MCP tools.

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
verification, redirects, expiry and not-before time, exact claims, negative issuer/audience/workspace
and per-operation scope cases, cross-tenant access, malicious store responses,
all five operations, event disclosure, idempotent retry, request-ID conflict,
lost-response non-redispatch, and substituted success result/session rejection.
Missing and digest-mismatched session retry cases are also rejected without
redispatch. Route tests cover 401/403/indistinguishable-404 behavior,
request-scoped principals, no hosted-to-local fallback, and exact five-tool
local/hosted/unconfigured discovery. PostgreSQL row tests prove that duplicated
tenant/index columns are rebound to each closed JSON record before use; the
checked-in migration retains issuer, audience, workspace, owner, and
idempotency keys. HTTPS adapter tests cover fresh workload credentials, fixed
routes, redirect denial, closed response schemas, and the distinction between
proven pre-dispatch rejection and uncertain network submission. The in-memory
store remains test/local scaffolding.

Hosted activation still requires separately authorized work:

- configure the implemented cryptographic verifier with approved identity
  metadata, inject the approved workload-identity provider, and bind the fixed
  HTTPS gateway origin/audience;
- apply the checked-in PostgreSQL migration with `mise run database:migrate` to
  an approved database and prove transaction behavior against that deployment;
- verify the workload gateway implements the fixed transport contract and maps
  installed Eve events into the normalized internal projection;
- encrypt any continuation credential outside public records with versioned
  server-side keys;
- compose the already request-scoped route with an approved database handle and
  workload identity; the repository deliberately does not do this at module
  import from ambient environment;
- deploy and prove hosted authentication, persistence, cancellation, and
  lost-response behavior; and
- publish an immutable Agent Plugins package pointing at that proven endpoint
  and run Codex and non-Codex installation smokes.

No database, provider, deployment, plugin registration, or remote repository is
changed by this slice. The loopback local adapter remains the only configured
runtime adapter.
