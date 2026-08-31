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

## Embedded Preview provider emulation

Preview deployments may run the embedded GitHub and Vercel services when both
`VERCEL_ENV=preview` and `APP_BUILDER_PREVIEW_PROVIDER_EMULATION=1` are exact.
Those services stay under the deployment's own `/api/emulate/github` and
`/api/emulate/vercel` routes. Their state is stored in Postgres under the
repository, project, and Git branch namespace, so redeployments of one branch
reuse that branch's document while another branch begins from its own seed.

This mode is separate from the `APP_BUILDER_LOCAL_*_EMULATION` settings, which
remain loopback-only. Production does not enable either emulation mode.

## Deferred Preview browser E2E

The current automated Emulate browser lane is intentionally local. Running the
same user journeys against protected Vercel Preview deployments is deferred and
is not a merge gate in this change.

A future Preview suite should use generated deployment URLs and prove:

- GitHub and Vercel sign-in through the same-origin embedded emulator;
- GitHub and Vercel Connect through the app approval bridge;
- the selected Git scope and Vercel team after a normal reload;
- state persistence after redeploying the same branch; and
- an independent initial seed and state document on another branch.

Each run must record the deployment ID, generated URL, source commit SHA,
database branch, and result. Deployment Protection automation, disposable Neon
orchestration, Preview secrets, cleanup, and merge-gate wiring remain deferred.
The future suite is a user-journey proof; it does not add an unbound-network
traffic assertion.

Real-provider hosted authentication and passkey automation remain separate
future work. If added, they must keep integration-only credentials and Vercel
Protection Bypass secrets in the CI secret store and preserve the exact
host-bound callback and WebAuthn contracts described above.
