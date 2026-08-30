# Self-serve onboarding

Autograph App Builder provisions one personal workspace for a new verified
GitHub or Vercel identity. Better Auth organizations and members are the sole
workspace-membership authority. Client-side organization creation remains
disabled.

## Authority contract

- Production MUST use `https://new.autograph.so/api/auth` as issuer and
  `https://new.autograph.so/mcp` as resource and audience.
- Email/password authentication MUST remain disabled. GitHub and Vercel
  provider callbacks remain the only Production user-creation paths. The
  separately gated passkey-first path may create non-email-verified users only
  on loopback development or Deployment-Protected Preview origins.
- The provider MUST assert a verified email. Stored emails are normalized to
  lowercase and protected by a case-insensitive unique index.
- Implicit provider linking MUST require the same verified normalized email.
  The runtime MUST NOT declare trusted providers or replace the canonical user
  profile during linking. A different verified email may link only from an
  already authenticated account-settings flow; it MUST NOT link implicitly.
- A provider account identity remains unique by `(issuer, account_id)`. A
  conflicting identity MUST fail rather than move between users.
- `allowUserToCreateOrganization` MUST remain `false`. Only the server-owned
  `ensureOrganizationForVerifiedUser` transaction may create a personal
  organization.

## First-session sequence

Before Better Auth persists a session, the authority locks the user row and:

1. verifies the user is not suspended, has a normalized verified email, and
   owns a persisted GitHub or Vercel account;
2. reuses exactly one membership bound to the configured issuer and resource;
3. otherwise accepts exactly one unexpired invitation for that authority;
4. otherwise, when `SELF_SERVICE_SIGNUP_ENABLED=1`, creates one personal
   organization, random workspace ID, owner membership, and
   `personal_workspace` row in the same transaction; and
5. re-reads the exact membership before setting
   `session.activeOrganizationId`.

Multiple memberships or eligible invitations fail closed. A removed personal
membership is treated as revoked access and is never silently recreated. A
crash before the transaction commits leaves no partial organization; the next
login safely retries the same operation.

OAuth consent, token issuance, refresh, and every hosted MCP request continue
to re-read the exact organization membership. The signed `workspace_id` claim
is derived from the organization row and never from request input.

## Rollout and rollback

1. Run the case-insensitive email-collision audit embedded in migration `0011`.
   A collision stops the migration and requires explicit operator
   reconciliation.
2. Deploy the additive schema and runtime with
   `SELF_SERVICE_SIGNUP_ENABLED=0`.
3. Verify existing memberships and invitations, then enable the flag in
   Preview and exercise both providers, linking, retries, and tenant denial.
4. Enable the flag in Production only after the exact Preview behavior passes.
5. Monitor sanitized signup, linking, retry, ambiguity, and denial outcomes;
   never log tokens or provider credentials.

Rollback sets `SELF_SERVICE_SIGNUP_ENABLED=0`. Existing organizations and
memberships remain valid and no destructive down migration is required.

The [Better Auth Infrastructure dashboard](better-auth-infrastructure.md) is
the operator surface for users, sessions, organizations, members, invitations,
suspensions, and audit events; it does not replace database authorization.
