# Production handoff

After technical app validation, Builder runs the selected repository's
`mise run app:describe <app>` command. The structured descriptor supplies app
routes, backend kind, checked source release, declared authorization roles,
database environment name, schema receipt declaration, and repository validation
capabilities. Builder does not depend on `.config/production-handoff.json`,
guess a route from the app ID, or parse app implementation files for readiness.

The resulting `productionHandoff` is an operator review summary. A failed or
unavailable descriptor remains a concrete blocker without invalidating the
already recorded technical validation result. Static apps do not acquire a
database release prerequisite.

## Evidence boundaries

- A checked source release does not establish installation in a selected
  database. Installed release evidence remains `unassessed` for data apps.
- A declared schema receipt route and response contract do not establish
  authenticated access or actual response behavior. Receipt evidence remains
  `unassessed` until a runtime validation observes it.
- Existing product action/readback observations are retained with their actual
  results and `action-readback-only` coverage. They do not establish
  authentication, revocation, tenant isolation, concurrent decisions,
  idempotent submission, audit history, or restart durability.
- No recorded product observation means behavior is `unassessed`. Passing
  repository checks does not change that status.

The descriptor summarizes source facts. In the target delivery flow, the
approved release operation prepares the intended live resources and reads
back the actual installation and access bindings. Provider activation
follows native Git delivery. Verify the authenticated app on its final
domain. Hosted Preview and synthetic testing are optional. See the
[public release contract](public-app-release.md).

## Onboarding requirements for each new authenticated app

Carry these requirements in the operator checklist for every generated data
app, using its repository descriptor and supported operator commands. Builder
must not silently reproduce manual provider changes or claim they are automated.

- Match the live Auth runtime binding to the reviewed migration database, role
  and host. Preserve existing users and sessions. Database names are not proof
  of ownership: do not migrate an empty similarly named database or fall back
  to an unrelated application DATABASE_URL. In Arrusted, Production uses
  PLATFORM_AUTH_DATABASE_URL and AUTH_PRODUCTION_DATABASE_IDENTITY.
- Review the checked immutable release and target organization, prepare the
  dedicated database and restricted runtime principal, and independently read
  back installation and tenant activation. Do not install demo seeds or expose
  cluster/installer credentials to app processes. Use a separately authorized
  Auth operator principal that can read membership and write app assignments;
  cluster authority does not imply Auth table privileges.
- Verify the intended owner's real Better Auth session, organization app
  enablement, explicit assignment and kernel membership. Check denied access
  with an unauthorized identity. Verify grants and revocation as access
  operations against the same live app. Use synthetic QA identities only in
  explicitly scoped engineering or acceptance exercises.
- Name the descriptor's runtime variable, selected provider project and target
  environment in the approved binding action. Save the restricted runtime
  secret before native Git delivery. Saving a variable does not change an
  existing deployment, and rerunning CD does not activate it. Delivery remains
  Git push → independent native deployment → provider-owned activation →
  authenticated Gateway routing → read-only semantic CD proof.
- Observe the declared mounted schema receipt with real authentication and
  compare ready/app/tenant/release facts against the reviewed target. Exercise
  the actual submission and destination render separately, with independent
  readback and a fresh app process against the same database.

Arrusted exposes plan/prepare/grant/revoke/export through `app:production`; use
its reviewed plan digest and operator guide rather than direct handwritten SQL.
The current public release implementation consumes a verified synthetic
runtime receipt. Direct preparation of the live target remains implementation
work. Keep the operator's authority checks and independent readback as the
source of live readiness evidence.
