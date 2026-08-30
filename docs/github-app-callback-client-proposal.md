# Proposal: use Octokit for GitHub App callback protocol handling

## Decision requested

Adopt GitHub's Octokit libraries for GitHub App OAuth and installation-token
protocol mechanics. Retain a small App Builder-owned orchestration layer for
tenant binding, authorization state, return routing, and product UX.

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

| Concern | Owner |
| --- | --- |
| GitHub authorization URL, authorization-code exchange, refresh behavior, and OAuth protocol details | `@octokit/oauth-app` |
| GitHub App JWT creation, installation access tokens, App/installation REST client | `@octokit/auth-app` and `@octokit/app` |
| GitHub webhook verification and dispatch, when webhooks are activated | `@octokit/webhooks` or `@octokit/app` |
| Tenant-bound state, PKCE correlation, membership policy, installation binding, return state, and UI | App Builder |

The App Builder callback route remains the only public callback endpoint. It
will first use the application-owned state record to establish the tenant and
the expected continuation, then delegate provider-token work to Octokit. The
route must not persist user OAuth tokens, refresh tokens, authorization codes,
private keys, or raw provider responses.

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

## Delivery plan

1. Keep the immediate callback compatibility fix and its regression tests.
2. Introduce Octokit behind a narrow internal `GitHubAppOAuthClient` port.
   Preserve the existing application-facing input/output types.
3. Move authorization URL construction and code exchange to
   `@octokit/oauth-app`. Do not log raw `state`, `code`, tokens, request bodies,
   or provider responses.
4. Move App JWT and installation-token creation and GitHub installation reads
   to `@octokit/app` / `@octokit/auth-app`.
5. Add contract tests for installation, update, authorization-only, duplicate
   parameter, provider-denial, expired-state, replay, tenant-change, and
   account-mismatch cases. Add a production-like end-to-end test using the
   actual GitHub App only where provider credentials and a disposable test
   installation are authorized.
6. Compare safe diagnostics and resulting bindings across the legacy and
   Octokit-backed paths. Remove the handwritten HTTP OAuth implementation only
   after the new path has passed the full repository gate and live verification.

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
- Full repository validation and a real production installation/update flow
  pass before the migration is considered complete.

## References

- [GitHub: user authorization callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)
- [GitHub: modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
- [Octokit App authentication](https://github.com/octokit/auth-app.js/)
- [Octokit OAuth App](https://github.com/octokit/oauth-app.js/)
- [Better Auth social-provider options](https://better-auth.com/docs/reference/options)
