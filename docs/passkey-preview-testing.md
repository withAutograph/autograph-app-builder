# Passkey testing

Autograph supports passkey-first registration and returning passkey sign-in on
loopback development origins and explicitly enabled Vercel Preview deployments.
It does not add a test-user bypass, password, impersonation endpoint, or public
registration token. Production passkey onboarding is rejected by the runtime.

## Local development

Use PostgreSQL with migration `0013_passkey_onboarding` applied. Put the local
bindings in the owner-only `.env.local` file loaded by Next.js:

```dotenv
BETTER_AUTH_URL=http://localhost:3000/api/auth
BETTER_AUTH_SECRET=<at-least-32-random-characters>
DATABASE_URL=postgresql://...
PASSKEY_ONBOARDING=local-preview-v1
```

Run `mise run app:dev`, open `http://localhost:3000/auth/sign-in`, and choose
**Continue with Passkey**. If the browser returns no assertion because the
ceremony was cancelled or no usable credential was available, Sign In shows
**Passkey failed (try again)** and offers **Create an account with a passkey**.
WebAuthn reports both cases as the same user-mediated failure, so Autograph does
not redirect automatically. Choosing the enrollment action moves to Sign Up and
explains that continuing will create a new passkey; registration does not begin
until **Continue with Passkey** is clicked again there. If the browser returns
an assertion that the server rejects, Sign In shows the retry state without an
enrollment action and never creates a replacement identity. After registration,
sign out and use **Continue with Passkey** to exercise the returning-user flow.
A transport failure after the authenticator returns an assertion is
intentionally treated as ambiguous and also remains on Sign In. Browsers treat `localhost` as a
WebAuthn secure context; use `localhost` consistently rather than switching
between it and `127.0.0.1` because credentials are RP-ID scoped.

The Sign Up view offers one **Continue with Passkey** action that creates the
passkey, account, workspace, and session together. An already authenticated
visitor is redirected through the preserved setup callback instead of being
offered first-account enrollment; adding another passkey remains an Account
settings action. The onboarding endpoint enforces the same distinction if a
session appears after the page renders.

Cancelled and failed registration can leave one short-lived onboarding-context
row, but no user, passkey, workspace, membership, or session. Expired contexts
are deleted with the existing expiry index before the next context is issued,
including contexts left by retired Preview deployments.

To reset a local identity, remove its organization/member, session, passkey, and
user records together in a transaction. Do not reuse that procedure against
Preview or Production data.

For deterministic local OAuth and WebAuthn coverage, run:

```sh
mise run auth-e2e:setup
mise run auth-e2e:test
```

The repository starts HTTPS on exact `https://localhost:3001`, PostgreSQL, and
the GitHub and Vercel Emulate services. Playwright uses a Chromium virtual
authenticator; Better Auth requests, callbacks, sessions, and workspace
provisioning remain real. Use `mise run auth-e2e:reset` to remove only ignored
emulator and database state. The test task also performs this cleanup when it
exits.

## Vercel Preview

Enable Vercel Authentication under Deployment Protection before setting:

```dotenv
PASSKEY_ONBOARDING=local-preview-v1
PASSKEY_PREVIEW_PROTECTION=vercel-authentication
```

The runtime also requires Vercel's exact `VERCEL_ENV=preview`, `VERCEL_URL`, and
`VERCEL_DEPLOYMENT_ID` metadata. Normally it derives the auth origin from
`VERCEL_URL` when `BETTER_AUTH_URL` is not set, or requires an explicitly
configured URL to agree exactly. Every generated Preview hostname is then a
different WebAuthn RP and has independent passkeys.

The exact `APP_BUILDER_PREVIEW_PROVIDER_EMULATION=1` gate instead uses the
validated stable `VERCEL_BRANCH_URL` as the auth origin and RP ID. Passkeys can
survive redeployments of that branch, while each new-account onboarding token
is still signed and bound to the current `VERCEL_DEPLOYMENT_ID`; a branch alias
moving during a ceremony makes that one ceremony fail closed. Auth pages are
redirected to the branch hostname before WebAuthn begins. Removing Deployment
Protection requires removing the passkey flags first.

Stable Preview endpoints and provider callback configuration are documented in
[Preview integration testing](preview-integration-testing.md). Passkey QA
continues to use the generated deployment hostname under the current exact
origin and deployment binding.

## Recovery

Passkey-first accounts have no verified email recovery. Add a second passkey in
Account settings before treating the account as durable. The server refuses to
delete the final passkey. A credential that exists on an authenticator but is
missing from server storage is intentionally treated as unrecognized; sign-in
fails generically and does not recreate the user or workspace. If every passkey
for an unlinked passkey-only account is lost, the account cannot be recovered.
OAuth linking remains separate from passkey recovery.

If an authenticator creates a credential and server verification or the final
database transaction fails, WebAuthn provides no browser API for deleting that
device-local credential. Autograph rolls back all server-side account state and
leaves the user on Sign Up, but the authenticator may retain that unusable local
credential until the user removes it through their device settings.
