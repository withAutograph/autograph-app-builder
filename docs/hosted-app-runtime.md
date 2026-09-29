# Hosted app runtime preparation

Builder owns the app's schema, backend and authenticated persistence lifecycle.
Its private database tests and hosted Preview resource changes have separate
authority: the private build approval permits disposable local validation;
`prepare-app-hosted-runtime` asks for approval naming the app, Vercel project
and exact Preview branch before changing connected resources.

## Provider prerequisites

The owner selects a Vercel installation through the existing authenticated
connection flow. Its tenant-bound encrypted OAuth credential must be active,
the owner must still be a workspace member, and the prepared app must identify
the selected project. No ambient Vercel or Neon API key supplies authority.

Arrusted uses one native Services project rooted at `.` with the `services`
framework preset. New project provisioning uses that topology; old journals
remain readable but an old app-root or Next.js-preset project needs an explicit
topology correction before this runtime path can run.
Builder does not update old projects automatically.

The selected project must already have a native Neon connection and an exact
Preview-branch `DATABASE_URL_UNPOOLED` variable with its integration reference.
Builder decrypts only that env ID through the owner's Vercel connection. A
global Preview fallback, Production variable, pooled endpoint, unrelated host,
missing installation permission, or missing native branch is a blocker. The
endpoint must support verified PostgreSQL TLS. The same selected project must
also supply `AUTH_PRODUCTION_DATABASE_IDENTITY` for Preview. Its normalized
Neon endpoint must differ from the selected native Preview endpoint; Builder
never borrows its own Production guard or deployment identity. Installing Neon, activating a
native branch and supplying missing provider permissions remain explicit
provider operations; a working code adapter does not establish those effects.

## Approved sequence and recovery

1. Resolve the owner-selected project and installation, check live membership,
   and read the project and exact native branch credential.
2. Reserve an owner, workspace, session, app, project and branch scoped record
   in the existing provisioning journal. Only one mutating continuation holds
   its renewable lease. GitHub/Vercel provisioning retries do not select these
   `app-runtime` records.
3. Run repository `app:runtime plan <app> preview` through the official Sandbox
   structured command API. The repository writes its private resource identities
   and random credentials before any database mutation. Encrypt and checkpoint
   its JSON state using the existing provider credential key and tenant-bound
   associated data.
4. Recheck access, run `prepare`, checkpoint, then run `verify` and checkpoint
   again. The repository creates dedicated app and authentication databases,
   restricted login roles, selected schema release, two test tenants and
   schema-declared or explicitly accepted product roles. A replacement Sandbox
   restores the same protected state and resumes with the same resource names
   and passwords. Source changes retain those resources and select the current
   checked schema through the repository task.
5. Recheck access before binding `<APP>_DATABASE_URL`,
   `PLATFORM_AUTH_DATABASE_URL`, `BETTER_AUTH_APP_NAME` and `BETTER_AUTH_SECRET`
   as encrypted variables for the approved Preview branch. Read their exact IDs
   and values back to establish the effect. Partial or uncertain writes stay
   unfinished and retry the same values. Preserve integration-owned
   `DATABASE_URL_UNPOOLED` and the native auth origin. Sandbox fixture origins
   and test cookies never become hosted provider configuration.

The protected journal contains ciphertext and provider references. Plaintext
installer credentials, runtime passwords, cookies and private file contents
are never tool inputs, public events, model results, repository files or command
arguments. Sandbox execution receives secrets through SDK `env`, and private
state is restored through SDK file APIs outside the checkout. The private app
launch uses the restricted auth binding; installer credentials remain confined
to the protected preparation task.

## Evidence boundaries

The public result names only the app, project, branch, changed variable keys,
and repository proof fields: release/artifact identities, tenant and actor
counts, and `authenticatedBehavior: "unassessed"`. Successful preparation
establishes database setup and env readback. Authenticated product behavior,
tenant isolation, revocation, idempotency, concurrency and audit pagination
still require the accepted behavioral test journey. Native deployment,
activation, Gateway routing and Production admission remain separately gated.
This tool never deploys, promotes, aliases, selects a deployment or changes
Production variables.

Provider contracts:
[Services configuration](https://vercel.com/docs/services),
[create a Services project](https://vercel.com/docs/rest-api/projects/create-a-new-project),
[list project environment variables](https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name),
[read one decrypted variable](https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id),
and [bind branch environment variables](https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables).
