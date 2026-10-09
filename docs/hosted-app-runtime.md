# Protected hosted runtime operator

New runtime effects use a separately operated service. Builder's read-only
`plan-app-hosted-runtime` obtains a frozen concrete plan before approval;
`prepare-app-hosted-runtime` and `cleanup-app-hosted-runtime` submit its operation
reference and digest only after their effect approval. The approval description
names the Vercel project and Preview branch, synthetic Neon context/project/branch,
app and shared Auth databases and roles, release, exact effects and access grants,
cost ownership and retention. `get-app-hosted-runtime` reads operator journal
status. Static apps require no database operation.

The consumed HTTP client uses `HOSTED_RUNTIME_OPERATOR_URL` (an HTTPS origin)
and Builder's workload identity. Missing configuration fails closed with
`protected_operator_required`. A configured operator must verify the workload's
signature and audience, independently resolve the named session's authenticated
owner/tenant, and recheck membership and provider authority. Client session
claims and `approvedByCallId` are not approval evidence. Its mandatory approval
adapter must read the actual authenticated durable Eve approval outcome and
exact tool input, matching action, call, plan digest, target and approver's current
authority. The native composition supplies concrete owner and approval readers;
their deployed configuration and authority still require independent proof.
There is no default-allow approval path.

Hosted Eve records terminal decisions for only the two protected runtime tools
in a private field on the tenant-owned session record. It pairs Eve's exact
`input.requested` action with the later `approval.settled` outcome and responder
identity; replay is idempotent and a conflicting terminal result is rejected.
The field is outside the public checkpoint and is not returned by session,
checkpoint or MCP projections. Historical v1/v2 checkpoints remain readable.
The operator still has to compare the receipt with the independently resolved
owner, membership, plan digest and selected target; receipt persistence alone
is not evidence of hosted provider authority.

`mise run operator:serve -- <absolute-reviewed-adapter-module> <sha256> [port]`
is a separate service entrypoint bound to loopback for an authenticated HTTPS
front end. It refuses startup without every required adapter. It must run in a
separate credential/process boundary, outside the Builder deployment and app
Sandbox. The entry-module checksum does not prove its imported closure: the
operator deployment must pin and review its complete package/toolchain and use
trusted generated artifacts as verified declarative data. Model-authored
repository scripts, dependencies, hooks and arbitrary SQL are never an installer
input. The [native operator host](operator-native-host.md) separately wires the
trusted [Preview composition](hosted-operator-native-composition.md). Source
wiring does not establish deployed configuration or successful provider effects.

The existing PostgreSQL `builderProvisioningJournals` row is the sole effect
journal. The optional `operator.mode = protected-operator-v1` discriminator
preserves v1 target identity, parser compatibility and encryption associated
data. It stores frozen plans, opaque references, approvals, encrypted checkpoints,
leases and effect receipts. Legacy rows are never silently converted. Existing
explicitly selected v1 runtime consumers remain a controlled recovery path; new
tools cannot create a legacy installer operation. Legacy consumers reject
operator records before decryption.

Each new protected operation reserves one positive `fenceGeneration` in that same
journal row with a compare-and-set before any provider effect. A PostgreSQL
sequence orders generations across sessions that share authority rows. Retries
reuse the stored generation; the trusted effect adapter must pass that exact
generation to both Auth and app-kernel authority rows and include it in access
and revoke receipts. This lets those rows reject a delayed older grant after a
newer revoke. Existing v1 receipts remain readable without generation proof and
must be reconciled before a new protected access checkpoint is accepted.

Planning the same resource with a changed release replaces the pending plan
and clears its old proof while retaining encrypted resource credentials. A plan
that changes actual resource identities is rejected while those resources are
present. Approval is bound to the replacement plan digest and must be read again
before any effect; an earlier plan's approval or proof cannot authorize it.

The contract requires ordered observed phases: resources → install/grant
verification → app access → bindings; cleanup requires revoke → remove bindings
→ retire. Existing resources still require a no-op readback receipt for each
phase. Execution checks authorization and durable approval before every effect, renews
its CAS lease and requires an adapter-held fence across the actual shared
resources. Long operations must call `assertCurrent` immediately before each
provider/SQL effect and checkpoint credentials before allocation. The adapter
must enforce cross-session shared-resource fencing and handle process death;
a journal lease alone does not establish distributed provider fencing. Every
unreceipted effect is reconciled against its frozen identities before execution.
Unknown readback stays blocked; a timeout never permits new names/passwords.
Cleanup uses a separate frozen scope/approval and clears ciphertext only after
all cleanup receipts. Shared Auth retirement must account for remaining consumers.

The private `bindings` operation rechecks access, current provider/database proof
and an unchanged journal revision. Its app projection returns only the app's
restricted runtime database credential and public Gateway verification settings,
plus nonsecret plan/proof. It verifies endpoint, TLS, database and explicit
runtime role. Auth SQL credentials and signing secrets remain in the separate
trusted Gateway/Auth host; installer authority remains in the protected operator.
The actual SQL grants, schema identity and absence of elevated capabilities are
the mandatory trusted verification adapter's responsibility. No installer state,
provider token or cluster URL reaches the app process. An operation reference
selects this closed launch path: failures never trigger legacy admin decryption.
Launch compares observed release/artifact with the app description. New preparation
plans include `publicGateway`, whose HTTPS origin the protected planner independently
verifies for the selected Preview project and branch. App bindings use the approved
public origin and verified Gateway transport/JWKS settings under the
[app environment contract](hosted-operator-app-environment.md). They do not
contain `BETTER_AUTH_URL`, an Auth SQL connection or a Better Auth signing secret.
The trusted Gateway/Auth host receives its own approved authentication settings.
Private Sandbox origins are never a Gateway origin. Persisted legacy plans remain
readable without origin proof, and cleanup can retire their resources without
reconstructing an origin. The concrete trusted planner still owns provider origin
resolution. This slice projects no browser identity/session fixtures; authenticated
browser acceptance and durable fixture projection remain unassessed.

The read-only Builder resolver uses the owner-bound Vercel installation credential. It
requires exactly one verified project domain assigned to the selected Git branch, then
reads the newest ready Preview deployment for that project and branch, confirms the
deployment's Git ref, and verifies the domain in that deployment's alias readback. If
any identity or alias is absent or ambiguous, it returns the unresolved
`verified_preview_branch_alias` predicate. It does not derive a hostname, use a request
origin, create an alias, or deploy. These provider metadata reads do not prove browser
reachability, TLS behavior, or hosted operator configuration.

## External setup and evidence gate

Source tests exercise the consumed client/handler over local HTTP with synthetic
trusted adapters, approval denial, tenant/target mismatch, revocation, fencing,
unknown-effect recovery, restricted projection and unchanged legacy records.
They do not establish hosted deployment, provider authority or SQL isolation.
All hosted acceptance remains **UNASSESSED** until these capabilities are
configured and observed:

- A separately owned operator host, reviewed pinned installer/compiler and
  verified artifact store; workload audience verification and authoritative
  session ownership plus durable Eve effect-decision lookup.
- Explicit owner-authorized Neon connection outside Builder/app processes,
  with a separately authorized synthetic-only nonproduction project/root.
  Existing production-root descendants are not synthetic isolation evidence.
  Preserve existing production database names, users, sessions and data.
- Resource inventory, concrete cost/retention/access policy, shared-resource
  lease/fencing, encrypted checkpoint keys and provider reconcile/install/verify
  adapters. The service uses the existing PostgreSQL journal store, not a second
  plan/effect ledger. Production stores/adapters must never use the test fixture.
- Exact Vercel deployment binding identity and restricted credential delivery
  proven for actual processes. Native dynamic Neon variables cannot be resolved
  from project-wide env metadata alone. No per-service env allowlist or
  project-wide OIDC isolation is assumed; unsupported identity remains blocked.
  A different integration or connection requires separate explicit authorization.
- Observed migration/role grants, revocation, cross-tenant denial, concurrent
  consumers, browser behavior, backup/restore and deployed readiness evidence.

The remainder describes existing v1 recovery code and its unresolved native
provider limitations. Its shared Auth environment is historical recovery
behavior, not the current app projection contract. It does not authorize new
legacy operations or establish hosted readiness of the protected Preview service.

# Legacy v1 runtime recovery reference

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
   source. The control handle never enters Eve or model tools. Repository task
   `app:runtime plan <app> preview` is read-only and does not allocate private
   state. Run `mise run app:runtime prepare <app> preview -- --checkpoint-only` through the
   structured command API to allocate private resource identities and random
   credentials without starting or installing databases. Encrypt and checkpoint
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
arguments or process environment variables. The separate control Sandbox gets
the direct installer database URL through a mode-restricted private startup
file; only typed, payload-free spool notices reach the command log stream.
Private state is restored only in the separate control Sandbox. Application Sandboxes
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

The validation handoff includes an operator checklist for access grants,
configuration, migration, backup/recovery, native installer isolation and
separate effect approvals. It derives app, routes, role declarations, runtime
variable and selected release from `app:describe`; matching database proof is
shown only as the observed Preview installation. That observation does not
assess Production migration, grant access, prove backups or approve an effect.
Database migration, backup/recovery and installer isolation are not applicable
to a repository-described static app. Platform access and configuration still
require operator evidence. A generated app explicitly retains the native
installer-isolation blocker even after a successful private database check.

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
