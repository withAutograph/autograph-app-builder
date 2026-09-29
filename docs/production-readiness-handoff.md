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

The handoff does not provision providers, install a release, grant app access,
or activate a deployment. Preview runtime validation must supply the missing
observations. Hosted preparation and provider activation keep their separate
operator approval gates, followed by semantic read-only Production proof.
