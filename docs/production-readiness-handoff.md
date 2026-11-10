# Production handoff

After technical app validation, Builder runs the selected repository's
`mise run app:describe <app>` command. Its structured descriptor supplies app
routes, backend kind, checked source release, declared roles, database environment
name, schema receipt declaration, and repository validation capabilities. Builder
does not require `.config/production-handoff.json`, guess routes from app IDs, or
parse app implementation files to declare live readiness.

The resulting `productionHandoff` has `status: advisory`. It summarizes source
facts and recorded observations; its checklist creates no delivery, testing,
provider-inventory or approval prerequisite. A failed or unavailable descriptor
command remains a concrete `blockers` entry without invalidating already recorded
technical validation. Actual authorization, credential, command and provider
failures remain failures in the operation that observed them.

## Evidence boundaries

- A checked release does not establish installation in a live database. Data-app
  installation remains `unassessed` unless a matching observed proof is present.
  A private Preview proof retains its actual environment and scope.
- A declared schema receipt does not establish authenticated HTTP behavior.
- Source descriptions and private database checks do not observe credentials
  available to native app processes. `nativeInstallerIsolation` is `unassessed`
  for persistent apps, rather than a generic failure or an invented pass. Static
  apps keep `not-applicable`. This unknown does not add a delivery gate. A
  historical generic `blocked` projection from the same source-only checklist
  is not an observed credential failure; use current protected operation results.
- Actual product action/readback observations retain their results and
  `action-readback-only` coverage. Unobserved authentication, revocation, tenant
  isolation, concurrency, idempotency, audit and restart behavior stay explicit.
- Neither green checks nor setup readiness establishes complete physical
  credential isolation or unexercised product behavior. A confirmed installer
  credential exposure is a real service issue, not an advisory success.

## Normal Production delivery

Use the saved app and repository through the existing protected Production setup.
`plan-app-production` and `get-app-production` provide that operation's reviewed
intent and current data/access status. Builder manages its approval, database,
restricted runtime binding and creator onboarding; creators supply no connection
strings, database IDs or external operator commands. Revisions retain the same
saved destination and database. Frontend-only apps skip database allocation.
See [existing-repository Production setup](repository-production-access.md).

Production configuration and private installer connections belong to the protected
operator. Only the app's restricted runtime URL and public Gateway boundary are
published for its normal app binding. Current owner, tenant, approval, resource,
role and provider checks remain authoritative. A source-only summary does not
replace those checks or infer a refusal that they did not report.

Publication and reviewed merge retain their own approvals and required checks.
Native deployment and activation remain provider-owned. Read actual delivery
status and use the returned app URL. Report unfinished setup or real deployment
errors through their supported recovery, preserving the original operation.
Hosted Preview, synthetic runtimes, manual enrollment and a per-app restore
qualification are not prerequisites for this flow. The application's accepted
requirements determine its product tests; additional engineering acceptance
observations remain distinct from release authority.

The historical Preview adapter retains its branch-scoped resource and credential
checks. Its integration-specific `DATABASE_URL_UNPOOLED` concerns are not proof
that normal Production setup exposes installer credentials. This handoff performs
no provider inventory read or environment mutation and weakens no credential
refusal. See the [public release contract](public-app-release.md).
