# Better Auth Infrastructure

Better Auth Infrastructure is the operator dashboard for the App Builder's
Better Auth users, sessions, organizations, memberships, invitations, and audit
events. It supplements the application database; it does not replace Neon or
become workspace authorization authority.

## Activation order

Infrastructure MUST remain disabled until the Better Auth organization
migration has completed and parity with the former hosted membership authority
has been verified. Activation then follows this order:

1. Verify organizations and members are the sole runtime workspace authority.
2. Create one Better Auth Infrastructure project on the **Starter ($0)** plan.
3. Store its API key as the server-only `BETTER_AUTH_API_KEY` secret.
4. Set `BETTER_AUTH_ORGANIZATION_AUTHORITY_READY=verified-v1` only after the
   parity receipt passes, then set
   `BETTER_AUTH_INFRASTRUCTURE=starter-dashboard-v1` in the same runtime.
5. The auth runtime adds the plugins returned by
   `resolveBetterAuthInfrastructure`; it refuses activation unless the exact
   organization-authority readiness value is present.
6. Deploy, verify dashboard read-back for users, sessions, organizations,
   members, invitations, and audit events, then exercise session revocation and
   membership removal against the application.

The configuration is deliberately fail-closed. An unknown activation value,
missing API key, or unverified organization migration prevents auth startup.
The diagnostic summary never includes the API key.

## Starter boundary

This integration enables only `dash()` from `@better-auth/infra`. It MUST NOT
enable Sentinel, managed directory sync, SSO, transactional email or SMS,
custom dashboard domains, log drains, or another paid capability without a
separate product decision and matching schema/operational work. Activity
tracking is also left disabled because it adds a user-schema field.

Starter currently provides one dashboard seat, 10,000 audit events per month
with one-day retention, and 1,000 security detections per month. Limits and
retention MUST be re-read from the provider before external activation.

## Operations and secrets

- `BETTER_AUTH_API_KEY` is server-only and MUST be stored in approved provider
  secret storage. It MUST NOT appear in logs, receipts, client bundles, or test
  fixtures containing real values.
- Dashboard actions are administrative effects. User deletion, bans, session
  revocation, invitation changes, and membership changes MUST be independently
  authorized and verified against the application database.
- The dashboard is an operator surface, not an authentication fallback. GitHub
  and Vercel remain the only public sign-in providers. Personal workspace
  provisioning follows the [self-serve onboarding contract](self-serve-onboarding.md).
- If Infrastructure is unavailable, authentication and organization authority
  remain in the application database; operators lose the managed dashboard but
  the application MUST NOT silently weaken access checks.

Official references: [Getting Started](https://better-auth.com/docs/infrastructure/getting-started),
[Dashboard plugin](https://better-auth.com/docs/infrastructure/plugins/dashboard),
and [Infrastructure pricing](https://better-auth.com/pricing).
