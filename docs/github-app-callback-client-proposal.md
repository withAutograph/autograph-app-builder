# Octokit GitHub App client architecture

## Decision

Adopted. GitHub App connection, provisioning, and publication use Octokit for
OAuth exchange and refresh, App authentication, installation-token minting,
and GitHub REST mechanics. App Builder retains a small orchestration layer for
tenant binding, authorization state, return routing, product UX, guarded
transport, and provider postcondition validation.

This is a reliability hardening proposal. It does not change the GitHub App's
requested permissions, repository-selection UX, or the rule that GitHub errors
remain local to GitHub connection elements.

## Why this change

The GitHub App connection is one user-visible action but combines two
provider-controlled stages:

1. GitHub installation or update identifies an installation and setup action.
2. GitHub user authorization returns an opaque authorization code which is
   exchanged for a short-lived user-to-server token and correlated with the
   installation.

The current implementation correctly owns tenant-scoped, single-use state and
PKCE, but it also hand-parses callback parameters and hand-implements the
token exchange. A production failure exposed the downside: the parser imposed
a maximum length on GitHub's opaque authorization code that was narrower than
the provider's behavior. The request was rejected locally before token
exchange. The immediate bound correction is necessary, but it is not a durable
reason to keep our own OAuth protocol client.

GitHub documents the user authorization callback and post-installation setup as
different concepts. When authorization is requested during installation, the
experience can traverse both concepts even though GitHub presents a single
installation screen. The application must therefore tolerate the documented
callback shapes without guessing at the format or size of opaque provider
values.

## Current boundaries

Better Auth is already the application's identity solution. Its GitHub social
provider is used for App Builder user sign-in at `/api/auth`; it is not the
GitHub App installation integration.

Better Auth should remain responsible for:

- App Builder login, sessions, and account linking.
- The GitHub social sign-in callback and identity profile validation.
- Application authorization decisions based on the authenticated session.

The GitHub App connection must additionally bind a particular GitHub App
installation to an exact App Builder tenant tuple. That requires application
data and policy which no general-purpose auth library can infer:

- the authenticated issuer, audience, workspace, and owner;
- one-time state storage, expiry, replay protection, and return routing;
- membership checks before and after the provider redirect;
- installation identity, active state, and account-identity validation;
- idempotent durable binding and GitHub-local user feedback.

Better Auth does not provide a first-class GitHub App installation-to-tenant
binding flow. Replacing the connection flow with its social provider would
conflate sign-in with installation authority and would not remove this product
logic.

## Proposed architecture

Use the following ownership split.

| Concern                                                                                             | Owner                                  |
| --------------------------------------------------------------------------------------------------- | -------------------------------------- |
| GitHub authorization URL, authorization-code exchange, refresh behavior, and OAuth protocol details | `@octokit/oauth-app`                   |
| GitHub App JWT creation, installation access tokens, App/installation REST client                   | `@octokit/auth-app` and `@octokit/app` |
| GitHub webhook verification and dispatch, when webhooks are activated                               | `@octokit/webhooks` or `@octokit/app`  |
| Tenant-bound state, PKCE correlation, membership policy, installation binding, return state, and UI | App Builder                            |

The App Builder callback route remains the only public callback endpoint. It
first uses the application-owned state record to establish the tenant and the
expected continuation, then delegates provider-token work to Octokit. For
personal-account repository creation, the route persists the GitHub App user
access and refresh token set only in the existing encrypted, versioned,
tenant-bound credential store. Plaintext credentials remain request-local.
The route never persists authorization codes, private keys, authorization
headers, or raw provider responses.

The existing fixed API origin, bounded transport timeout, strict tenant scope,
atomic state consumption, and safe diagnostics remain requirements. Octokit
does not replace these product security controls; it replaces the error-prone
provider protocol implementation beneath them.

## Alternatives considered

### Continue the handwritten client

Reject. It has already produced a compatibility failure at the callback parser.
Tests can add coverage for known callback shapes, but they cannot safely turn
opaque GitHub values into an application-defined wire contract.

### Use Better Auth for the installation flow

Reject. Better Auth is the right user-authentication layer and is already in
use. Its GitHub social-provider support does not model GitHub App
installation/update callbacks or an installation-to-workspace binding.

### Use Auth.js or another generic OAuth library

Reject. This would duplicate Better Auth's sign-in role while still leaving the
GitHub App installation correlation and binding protocol custom. It raises
migration risk without removing the relevant custom logic.

### Use a third-party integration platform

Defer. A managed integration service could own broader connector operations,
but it would introduce a separate credential, tenancy, lifecycle, and
compliance boundary. It is not a proportionate fix for a GitHub App callback
client and does not eliminate the need for App Builder's binding policy.

## Implemented cutover

1. `@octokit/oauth-app` owns authorization URL construction, code exchange,
   and expiring user-token refresh. App Builder adds its derived S256 PKCE
   verifier at the guarded transport boundary because Octokit's GitHub App web
   flow does not expose that parameter.
2. `@octokit/app` and `@octokit/auth-app` own App JWTs and operation-scoped
   installation tokens.
3. Octokit owns REST request construction and response decoding across
   connection, provisioning, and publication. A shared App Builder transport
   keeps the fixed GitHub origins, redirects disabled, bounded response size,
   timeout, API version, user agent, and silent internal logger.
4. Callback parsing rejects duplicates of required and application-owned
   fields while tolerating RFC 9207 `iss`, repeated provider extensions, and
   future provider fields. Authorization codes remain opaque and have no
   application-defined size or syntax bound.
5. Existing adapter return types, public routes, environment names, schema,
   selected/all repository behavior, and personal/organization creation remain
   unchanged.

## Acceptance criteria

- A GitHub App can be installed or updated with either selected repositories or
  all repositories, subject to the App's configured permissions.
- The final production callback creates or updates the durable binding for the
  initiating App Builder workspace and returns a visible connected state.
- Authorization code size and syntax are treated as provider-owned opaque data
  except for security checks required by the OAuth client; application callback
  parsing does not impose undocumented provider-specific bounds.
- Replayed, expired, duplicate, cross-tenant, unauthenticated, or
  account-mismatched callbacks fail closed without a binding.
- Diagnostics retain only bounded allowlisted metadata such as stage, key
  names/counts, value-presence/length, and digests. They never contain
  authorization codes, state, tokens, client secrets, private keys, or raw
  GitHub responses.
- GitHub failures appear in the GitHub connection UI, not as a global product
  error.
- Full repository validation, exact-head CI, and a Vercel Preview pass before
  the migration is merged. A real production installation/update flow remains
  a deployment proof and is not implied by local or Preview validation.

## PR #178 disposition

PR #178 was audited at its exact unmerged head
`301d70ed01c850b18fac5fb87d97a2ca4e45ae17`; its conflicting branch is not a
cutover input. The commit-by-commit disposition is:

| PR #178 commit | Concern                                   | Cutover disposition                                                                                                                                                                      |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d2caa882`     | Selected and all-repository installations | Preserve the existing UX and adapter behavior; Octokit replaces only provider mechanics.                                                                                                 |
| `fefea785`     | Installation update redirects             | Preserve setup-action and installation correlation plus the existing callback/return route.                                                                                              |
| `f1c150ab`     | OAuth exchange failure classification     | Preserve safe product stages/categories; delegate exchange protocol and response decoding to Octokit.                                                                                    |
| `3a5b53bd`     | Secret-safe callback diagnostics          | Preserve bounded key/count/presence metadata without code, state, token, secret, or raw-response values.                                                                                 |
| `3666e665`     | OAuth errors returned with HTTP 2xx       | Superseded by Octokit's OAuth response handling, with failures mapped into the existing product-safe error surface.                                                                      |
| `7e8c8081`     | Callback state and PKCE handling          | Preserve signed tenant state, replay/membership checks, and PKCE correlation; remove provider-owned code syntax/size policy.                                                             |
| `256a85ac`     | Installation repository response handling | Preserve selected/all response interpretation and publication authorization/postcondition checks behind Octokit REST.                                                                    |
| `fbdfec65`     | Tenant-scoped installation uniqueness     | Already landed in the durable schema/store and remains unchanged.                                                                                                                        |
| `dfe5c7bb`     | Tenant uniqueness regression coverage     | Already landed and remains applicable without importing the stale branch.                                                                                                                |
| `2824475b`     | Return state on callback failure          | Preserve return routing in the existing route adapter and error type.                                                                                                                    |
| `9c403fb3`     | GitHub-local failure UI                   | Already landed and remains the product error boundary.                                                                                                                                   |
| `3be9b0b7`     | Scoped installation-index replacement     | Already landed in hosted storage and remains unchanged.                                                                                                                                  |
| `301d70ed`     | Installation callback metadata            | Preserve required setup discriminators, but supersede its allowlist: tolerate RFC 9207 `iss` and future provider extensions while rejecting duplicate required/application-owned fields. |

No schema, route, environment, UI, or provider-setting change is taken from the
stale branch.

## References

- [GitHub: user authorization callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)
- [GitHub: modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
- [Octokit App authentication](https://github.com/octokit/auth-app.js/)
- [Octokit OAuth App](https://github.com/octokit/oauth-app.js/)
- [Better Auth social-provider options](https://better-auth.com/docs/reference/options)
