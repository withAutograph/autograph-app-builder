# Preview integration testing

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

## Environment and provider callbacks

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

Use integration-only provider applications and secrets. Do not reuse
Production credentials, and do not put provider secrets in repository or
client-visible variables.

## Deployment Protection

For browser-driven integration tests, authenticate to Vercel Deployment
Protection before starting the provider flow. Non-browser automation may use a
[Vercel Protection Bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection#protection-bypass-for-automation)
secret stored only in the CI secret store. Never put a bypass value in a URL,
repository variable, test fixture, or client bundle, and do not make the alias
public to simplify testing.

## Test receipts

Treat the alias as a moving target and the generated deployment URL as the
immutable test receipt. Before accepting a run:

1. Resolve the alias to the deployment that is currently Ready.
2. Record that deployment's ID and source commit SHA.
3. Run the integration test against the protected stable alias.
4. Retain the generated deployment URL with the test result.

This prevents a later branch push from changing what a passing integration
result claims to cover.

## Host-bound authentication

Authentication methods that bind credentials or signed state to an origin must
explicitly support the stable host before they are exercised through the
alias. In particular, the current passkey onboarding contract requires the RP
hostname to equal the generated `VERCEL_URL` and binds registration to
`VERCEL_DEPLOYMENT_ID`. Continue passkey QA on each generated deployment
hostname as described in [Passkey testing](passkey-preview-testing.md).

Supporting passkeys on a stable alias requires a separate reviewed runtime
change for alias verification, deployment binding, trusted origins, cookies,
and RP migration. Documentation or an environment override alone is not
sufficient.

## Deferred hosted auth E2E

Hosted authentication automation is intentionally not part of the local
Emulate test lane. A future implementation should use two protected targets:

- a generated Preview deployment for full passkey E2E, preserving the exact
  deployment hostname as the WebAuthn RP ID; and
- a second protected Vercel project with a stable hostname, deployed from the
  same immutable source SHA, for GitHub and Vercel callback smoke tests.

That hosted design must create an isolated disposable Neon branch, apply the
real migrations, keep any Vercel Protection Bypass secret only in the CI secret
store, record the deployment IDs, generated URLs, source SHA, database branch,
and test result, and clean up both deployments and data after the run. The
stable target must use integration-only provider applications whose registered
callbacks exactly match its hostname.

The Emulate services and every `APP_BUILDER_LOCAL_*_EMULATION` setting are
local-only and must never be exposed or enabled in a Vercel deployment. Hosted
automation, the second Vercel project, real provider test accounts, disposable
Neon orchestration, and Preview merge gates are deferred in their entirety;
this repository does not partially configure any of them.
