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
**Continue with Passkey**. If the browser cannot authenticate, the page remains
on sign-in and changes the action to **Passkey failed (try again)**. Retrying
starts the registration recovery ceremony without adding a second passkey
button. After registration, sign out and use **Continue with Passkey** to exercise the
returning-user flow. Browsers treat `localhost` as a
WebAuthn secure context; use `localhost` consistently rather than switching
between it and `127.0.0.1` because credentials are RP-ID scoped.

The Sign Up view offers **Create a passkey** directly and never places a second
passkey action beside it.

To reset a local identity, remove its organization/member, session, passkey, and
user records together in a transaction. Do not reuse that procedure against
Preview or Production data.

## Vercel Preview

Enable Vercel Authentication under Deployment Protection before setting:

```dotenv
PASSKEY_ONBOARDING=local-preview-v1
PASSKEY_PREVIEW_PROTECTION=vercel-authentication
```

The runtime also requires Vercel's exact `VERCEL_ENV=preview`, `VERCEL_URL`, and
`VERCEL_DEPLOYMENT_ID` metadata. It derives the auth origin from `VERCEL_URL`
when `BETTER_AUTH_URL` is not set, or requires an explicitly configured URL to
agree exactly. Every generated Preview hostname is a different WebAuthn RP and
therefore has independent passkeys and workspace data. Removing Deployment
Protection requires removing the passkey flags first.

## Stable Preview alias for integration testing

Use a dedicated, long-lived integration branch when an external provider or
test client needs one callback origin that survives new deployments. Vercel's
[branch URL](https://vercel.com/docs/deployments/generated-urls#generated-from-git)
always points to the latest deployment for that branch and has the form:

```text
https://<project>-git-<branch>-<scope>.vercel.app
```

The Vercel deployment page and `VERCEL_BRANCH_URL` system variable provide the
exact value; do not reconstruct or guess it. A custom domain assigned to that
one Preview branch is also acceptable. Keep the branch URL or domain under
Vercel Authentication and do not add it to Deployment Protection Exceptions.

Scope these bindings to the dedicated Preview branch (or a dedicated Vercel
custom environment), rather than every Preview:

```dotenv
BETTER_AUTH_URL=https://<stable-preview-host>/api/auth
MCP_RESOURCE_URL=https://<stable-preview-host>/mcp
GITHUB_CLIENT_ID=<integration-client-id>
GITHUB_CLIENT_SECRET=<integration-client-secret>
VERCEL_AUTH_CLIENT_ID=<integration-client-id>
VERCEL_AUTH_CLIENT_SECRET=<integration-client-secret>
```

Register these exact provider callback URLs:

```text
https://<stable-preview-host>/api/auth/callback/github
https://<stable-preview-host>/api/auth/callback/vercel
```

The dedicated integration environment must not inherit
`PASSKEY_ONBOARDING=local-preview-v1`. The current passkey security contract
requires the RP hostname to equal the generated `VERCEL_URL` and binds each
registration to `VERCEL_DEPLOYMENT_ID`; a branch alias intentionally does not
satisfy that contract. Continue manual passkey QA on each generated deployment
hostname. Enabling passkeys on a stable alias requires a separate reviewed
runtime change for alias verification, deployment binding, trusted origins,
cookies, and RP migration; documentation or an environment override alone is
not sufficient.

For browser-driven integration tests, authenticate to Vercel Deployment
Protection before starting the provider flow. Non-browser automation may use a
[Vercel Protection Bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection#protection-bypass-for-automation)
secret stored only in the CI secret store. Never put a bypass value in a URL,
repository variable, test fixture, or client bundle, and do not make the alias
public to simplify testing.

Treat the alias as a moving target and the generated deployment URL as the
immutable test receipt. Before accepting a run, record the deployment ID and
commit SHA currently served by the alias, wait for that deployment to become
Ready, and retain the generated URL with the test result. This prevents a later
branch push from changing what a passing integration result claims to cover.

## Recovery

Passkey-first accounts have no verified email recovery. Add a second passkey in
Account settings before treating the account as durable. The server refuses to
delete the final passkey. OAuth linking remains separate from passkey recovery.
