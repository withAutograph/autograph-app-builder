# Authenticated web-to-client continuation

## Trust and credential boundaries

The website and hosted MCP endpoint use the same canonical Autograph origin, Better Auth identity, workspace authority, and provider stores. A native client obtains its own Autograph access and refresh tokens using authorization-code OAuth with PKCE. The existing browser session satisfies sign-in when it is still valid; a new client can require the first-time Autograph consent confirmation. GitHub and Vercel credentials stay server-side. Connecting their independent plugins or logging into provider CLIs is not part of this continuation flow.

An opaque handoff ID is a reference, not a credential. Redemption requires an authenticated MCP principal and an exact issuer, resource, workspace, and user match. Missing and mismatched records return the same unavailable response. Neither authentication nor redemption authorizes building, publishing, or deploying beyond the user's separately recorded approvals.

## Durable provider context

The existing version-2 session JSON gains an optional `sourceHandoffId`; old version-1 and version-2 records remain readable. The field is not a public MCP input. Only the server's owner-authorized handoff redemption sets it. The field participates in the creation digest when present, without changing digests for existing sessions.

The trusted MCP-to-Eve forwarder includes the reference in authenticated attributes. New starts, subsequent messages, approval responses, engine replacement, and terminal-session recovery preserve it. Current and initiating authorities must agree. Provider tools load the saved intent under this verified authority and fresh membership, rather than relying on a model summary.

Launch expiry does not discard a running session's prepared context. Provider credentials and access are resolved afresh for each operation; the durable record is not evidence of current provider authorization. Successful resources are defaults to reuse, not invitations to provision duplicates. Explicitly chosen alternative repositories must not inherit the prepared repository's installation selection.

## Client and deployment boundaries

Codex uses the official App Builder plugin and its native OAuth/CIMD flow. Cursor uses a dedicated public PKCE client and a Cursor-specific install adapter, not extra fields in the portable MCP manifest. Dynamic registration remains disabled. Deployment setup must register the Cursor client before its installation link is shown.

The browser can request an OS launch but cannot confirm installation, client startup, or prompt submission. Cursor's prefilled prompt needs user review and submission. Only an owner-authorized status read showing a bound session is evidence that the handoff continued. An expired unredeemed handoff can be renewed without re-running provider provisioning.

## Acceptance boundaries

Use [the Computer-assisted native QA runbook](handoff-native-qa.md) for the automated commands, coverage boundaries, remaining Codex/Cursor walkthrough, failure cases, and sanitized receipt template.

Local deterministic tests and provider-emulated browser tests are not native desktop acceptance. Before claiming native-client support on a deployment, record the Preview URL/revision, Codex and Cursor versions, fresh-profile setup, browser profile used for sign-in, first consent, repeat consent behavior, refresh-token continuation, and successful authenticated provider readbacks. Do not record tokens, OAuth codes, cookies, or credential-bearing URLs.

The normal path assumes OAuth opens in the same browser profile used for web sign-in. Cleared cookies, another profile, expired sessions, revoked connections, or newly required permissions can require authentication again. A provider outage is a retryable failure, not a reason to request another provider login.

Native Preview acceptance has not yet been performed for this change.

### Local evidence (2026-09-08)

- The integrated focused suite passed 329 tests across 25 files. It covers the changed auth, handoff, session, provider, and UI boundaries; this is not the repository-wide CI suite.
- The real Better Auth handler harness exchanges authorization codes and refresh tokens for Codex CIMD and the registered Cursor public client. The MCP handler verifies actual exchanged JWTs against the handler's JWKS, binds a handoff, reuses its session across clients, and rejects another owner. The Eve engine transport in this harness is a test double, not a native client.
- Connected OAuth tests also exercise selected GitHub installation/repository and Vercel team/project readbacks through production adapters with injected HTTP fixtures. They rotate server credentials, rebuild the context reader, and check fresh authorization headers and credential-free output. These provider HTTP fixtures are separate from the running browser emulators.
- The scoped Chromium walkthrough passed all five cases in `e2e/builder/builder-handoff.spec.ts`: saved/reloadable Codex preparation after both local provider connections, registered Cursor install configuration, explicit launches, blocked launch and clipboard fallback, and bounded opaque links for long briefs. The run used local PostgreSQL and the GitHub/Vercel emulators; OS launches and clipboard behavior were controlled test boundaries.
- Session tests cover durable references across server recreation, approval responses, engine replacement, terminal-session recovery, and rejection of a public attempt to inject the internal reference.
- The final six-case browser run kept the original five scenarios green and exposed a PostgreSQL microsecond/JavaScript millisecond expiry comparison bug. After removing that unnecessary equality predicate, the isolated renewal rerun passed with the original microsecond fixture. It verifies the same ID, unchanged intent/journals, extended expiry, and no provisioning or launch.
- Follow-up UI tests (47), MCP outage/error tests (34), TypeScript checking, and changed-code ESLint passed. Provider outages now explicitly instruct retrying the same handoff without triggering another OAuth challenge.

These checks do not prove the complete browser-to-native-client-to-hosted-engine journey on Preview. No live provider registration or deployment was performed as part of that local acceptance pass.

### Preview deployment receipt (2026-09-09 UTC)

- Source: `da24d44432d75dcdff7575aa3110f040822b810c`, published to `codex/authenticated-client-handoff`; Production was not changed.
- Ready deployment: `dpl_2MY8fxDFGsV836kg6h1VhK8NQuq7`, immutable URL <https://autograph-app-builder-6hfwzcduv-autographing.vercel.app>.
- Canonical branch origin: <https://autograph-app-builder-git-codex-authenticat-457163-autographing.vercel.app>.
- Neon integration created isolated branch `br-twilight-band-au3jzlsj` (`preview/codex/authenticated-client-handoff`) in project `wispy-cherry-74541901`. Cursor setup ran against this branch, not its parent.
- The existing Cursor setup implementation returned `ready: true` twice for `autograph-cursor-desktop` bound to the canonical origin's `/mcp` resource. The second run verified idempotent registration/readback.
- The first ready deployment exposed missing branch-specific MCP settings as `503 service_unavailable`. Six nonsecret branch-only settings were added: `BETTER_AUTH_URL`, `MCP_RESOURCE_URL`, `MCP_OAUTH_ISSUER`, `MCP_OAUTH_AUDIENCE`, `MCP_OAUTH_JWKS_URL`, and `MCP_OAUTH_ALGORITHM=ES256`. Redeploying the same source produced the ready deployment above.
- Through authenticated `vercel curl`, Better Auth metadata advertised CIMD, PKCE-S256, and refresh tokens on the canonical origin. Protected-resource metadata returned the matching issuer/resource; MCP initialize succeeded; `autograph_get` without an Autograph token returned `authentication_required` and the matching MCP authentication challenge. This is server smoke evidence, not an exchanged-token or provider-continuity acceptance test.

Native acceptance remains blocked/unperformed:

- Preview Vercel Authentication remains enabled. A direct credential-free MCP POST received HTTP 401 without the application's authentication challenge; authorized Vercel access is not evidence of a fresh native client's access. No protection exception, bypass credential in client configuration, or Production change was introduced.
- Browser automation explicitly rejected the Preview tab under its URL policy. No alternate browser surface was used to circumvent that rejection.
- Installed Codex desktop (`com.openai.codex`, displayed as ChatGPT) reports version `26.903.61454`. Cursor was not found in the inspected application locations or available native-app inventory; its installation/location awaits user direction. Neither client completed fresh-profile acceptance.
- First/repeated consent, refresh continuation, handoff redemption, and provider readbacks through the deployed native clients remain unverified. A user-driven walkthrough and an approved native-client-compatible Preview access path are still required before claiming support.
