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

## Native Services blocker and recovery

The current adapter has two concrete native provider gaps. First, Services
shares project environment variables and its documented
[service configuration](https://vercel.com/docs/services/config-reference)
has no environment allowlist. An integration-owned installer URL delivered to
the project can therefore also reach app services, even when app code selects
its restricted URL. Removing a variable from `process.env` inside app code
does not establish that the provider withheld the credential from that process.

Second, the [Neon Vercel-managed integration contract](https://github.com/neondatabase/website/blob/main/content/docs/guides/vercel-managed-integration.md)
injects branch credentials during each Preview deployment; those variables
override Preview settings and are not stored in project environment settings.
Consequently, the adapter's exact branch project-env lookup is a required
readback it may not obtain from the native integration. A missing lookup must
remain blocked; a global Preview URL does not identify that deployment's
isolated branch. The guide also lists raw password and legacy connection
variables, so checking only `DATABASE_URL_UNPOOLED` is insufficient for a
future native credential-isolation proof.

The public [Get Integration Resource API](https://vercel.com/docs/integrations/create-integration/marketplace-api/reference/vercel/get-integration-resource)
documents resource state and metadata, with no secret-read response. The
[Partner Get Resource API](https://vercel.com/docs/integrations/create-integration/marketplace-api/reference/partner/get-resource)
is called by Vercel on the provider's server. It is not an owner-authorized Neon
credential issuer for Builder's separate integration. No such issuer is wired
in this repository; do not substitute an ambient Neon key or assume a different
integration's credential grants that authority.

Recovery preserves the single Services project and needs one reviewed provider
contract change:

- Obtain a supported native integration capability that exports restricted
  runtime roles while giving a separately authorized installer access to the
  same verified branch. Confirm all credential variables received by each
  service without printing their values.
- Migrate the connection to the [Neon-managed integration](https://github.com/neondatabase/website/blob/main/content/docs/guides/neon-managed-vercel-integration.md),
  which supports selecting the PostgreSQL role and injected variable names.
  It cannot coexist with the Vercel-managed integration. Installer authority
  still needs its own protected owner-scoped issuer, and role grants plus the
  actual service environment must be verified after migration.
- Disconnect the native project connection through the provider's supported
  lifecycle, retain the database, and bind only restricted runtime variables.
  Disconnection stops automatic creation of new native Preview branches, so a
  provider-owned branch lifecycle and protected installer issuer are additional
  prerequisites. Existing deployments require separate replacement and old
  credentials require separate revocation; an environment edit cannot erase
  credentials already issued to a running deployment.

These are recovery options, not completed capabilities or provider effects.
Until an option is implemented and observed, private Sandbox validation can
continue while native application-process installer isolation remains blocked.

## Approved sequence and recovery

1. Resolve the owner-selected project and installation, check live membership,
   and read the project and exact native branch credential.
2. Reserve an owner, workspace, session, app, project and branch scoped record
   in the existing provisioning journal. Only one mutating continuation holds
   its renewable lease. GitHub/Vercel provisioning retries do not select these
   `app-runtime` records.
3. Create a separate installer Sandbox through project OIDC. Transfer the
   current checkout and installed dependency symlink closure through supported
   file APIs in bounded chunks; an old snapshot alone cannot supply current
   source. The control handle never enters Eve or model tools. Run repository
   `app:runtime plan <app> preview` through its structured command API. The repository writes its private resource identities
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
   as encrypted variables for the approved Preview branch. Existing bindings
   must have this runtime's ownership marker. Another app or session's branch
   Auth binding blocks preparation before database writes; a concurrent
   provider creator cannot be overwritten. Read their exact IDs
   and values back to establish the effect. Partial or uncertain writes stay
   unfinished and retry the same values. Preserve integration-owned
   `DATABASE_URL_UNPOOLED` and the native auth origin. Sandbox fixture origins
   and test cookies never become hosted provider configuration.

The protected journal contains ciphertext and provider references. Plaintext
installer credentials, runtime passwords, cookies and private file contents
are never tool inputs, public events, model results, repository files or command
arguments. Installer execution receives secrets through SDK `env`, and private
state is restored only in the separate control Sandbox. Application Sandboxes
receive only restricted environment, identity and browser session files. They
never receive installer `state.json`, including during fresh verification of an
already running app. Control compute is deleted after each operation; a
renewable provider timeout bounds stranded compute after a process crash
without limiting valid operation duration. Encrypted journal checkpoints
support a replacement control Sandbox. App children do not inherit the private
state-directory driver variable.

## Approved teardown

`cleanup-app-hosted-runtime` requires its own approval naming the same app,
selected project and Preview branch. It claims the durable runtime mutation
lease, rechecks owner access and native endpoint isolation, and reads every
owned environment ID, owner marker and current value before deleting any
binding. Native integration, global, Production and unrelated variables remain
untouched. A changed binding for a previously bound runtime blocks cleanup.
A preparation that never obtained full branch bindings can remove its own
partial variables and databases while preserving a concurrent winner's Auth.

After environment removal, the isolated installer runs repository
`app:runtime cleanup`, which checks database and role ownership markers before
its first destructive statement. This drops the dedicated databases and roles,
revoking their issued credentials. Failures retain encrypted recovery state;
retries continue the same resources and tolerate already removed variables.
Successful cleanup leaves a tombstone and clears credential/session ciphertext.
Cleanup does not deploy or alter deployment selection. Existing Preview
processes using the removed resources will lose database access.

Turn stops and replacement Sandboxes preserve persistent resources. Provider
connection removal or workspace revocation blocks future Builder access but
does not itself revoke credentials already issued to a deployment. Cleanup
requires an active authorized owner connection; reauthorize before removing
resources when that connection has been revoked.

## Evidence boundaries

The current provider adapter binds restricted credentials at project and Preview
branch scope. It preserves native integration-owned `DATABASE_URL_UNPOOLED` and
does not configure service-specific environment filtering. Selecting an
app-specific restricted database URL does not establish that a native Services
app process cannot also read the installer credential. Native application
process isolation remains a blocker until supported service-scoped bindings or
an equivalent provider capability is configured and verified. Inspect the
actual service's credential availability without exposing values; private
Sandbox isolation cannot establish this native deployment fact.

Preview launch, local preparation and validation consumers preserve an approved
hosted selection. They recheck membership, installation, native isolation and
the dedicated branch environment values, verify through a separate installer
Sandbox, and restore only runtime/session files into application Sandboxes.
The trusted command driver reads that environment for app and browser commands. An incomplete or revoked hosted binding blocks these paths;
it never silently becomes a disposable local database. Private gateway origin
updates preserve the existing database and session tokens, and checkpoint the
updated auth origin and cookie domains in encrypted state without rerunning
database installation.

Each restored consumer reruns repository `app:runtime verify` and compares its
database observation with `app:describe` for the current selected release and
artifact. Its safe `installationProof` includes the app, Preview branch,
release, artifact, actor/tenant counts and observation time. This proves the
observed database installation; it does not prove native deployment or the
authenticated HTTP receipt. Browser/validation logs stream with backpressure
and credential redaction across provider chunk boundaries.

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
[remove an owned environment variable](https://vercel.com/docs/rest-api/projects/remove-an-environment-variable),
and [bind branch environment variables](https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables).
