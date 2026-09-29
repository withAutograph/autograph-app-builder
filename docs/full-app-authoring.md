# Complete app authoring

A request to build a complete app includes its UI, authenticated backend,
persistence and tests. Builder authors the whole app through the same public
workflow; a manually completed Arrusted patch is not evidence of that capability.

## Backend ownership

- Use Arrusted's CUE/PostgreSQL generated data boundary for app-owned durable
  records. Builder derives identities, fields, relationships, policies, typed
  operations and indexes from product decisions, writes the CUE, and runs the
  repository compiler. Never hand-author checked generated release files.
- App-owned server modules derive session, organization, app assignment and
  database authority on the server. Browser inputs cannot supply trusted actor,
  tenant or reviewer identities. Server Actions own workflows, input validation,
  safe errors and business authorization beyond schema policy.
- Use repository-owned authenticated disposable database tooling for tests.
  Synthetic fixture records are test data, not a demo fallback in the product.
  Do not add host/environment gates that bypass normal authentication.
- Follow the selected runtime's lifecycle for schema transitions, idempotency,
  versioned decisions, audit records and cursor pagination. Do not silently cap
  legitimate records or substitute browser state for persistent operations.
- Alternative backend stacks require an available repository-owned adapter and
  runtime lifecycle. Report an unavailable capability rather than claiming that
  an ephemeral file or an external Builder session supplies app persistence.

## Existing app revisions

Inspect the selected app's actual CUE and checked release before changing it.
`existingAppChanges` and `implementationFiles` accept legacy `{path, content}`
upserts, explicit `{path, operation: "upsert", content}`, and
`{path, operation: "delete"}`. A rename is a delete and an upsert. Operations
stay within the selected app; deletion is non-recursive. Review/publication
retain the original preimage even when an apply retry resumes partial writes.
Normal repairs preserve omitted staged files and replace supplied paths.

Compile a new release when the schema changes, then rerun app checks and tests.
Existing-app changes are deltas; absent action files in a submitted delta do not
prove that the retained app lacks a server write path.

## Completion evidence

Commands passing and a reachable page are separate from a working backend.
Exercise the accepted authenticated journey against the implemented app and a
real disposable database. Verify independent reads after writes and reload,
restart durability, denied access and revocation, tenant isolation, idempotent
submission, concurrent decisions and paged audit history when those behaviors
apply. Report only scenarios actually run; source inspection and mock tests do
not establish database or identity behavior.

The private build approval covers implementation and validation. Repository
publication, provider resources, production data changes, and activation remain
separately approved outward effects. A blocked public run must retain its
session and precise failed operation; manual implementation cannot replace it
in acceptance evidence.

## Repository runtime contract

Use `app:describe` for selected release, declared roles, database environment and
validation tasks. Use `app:runtime prepare` for isolated authenticated validation;
its protected environment and session files are injected by Builder into app
validation and Preview startup. Author `test-e2e` to consume `APP_TEST_IDENTITIES_FILE`
and exercise real browser submissions with those sessions. Backend validation
runs this task after repository checks and reports missing tasks as blocked.
No passing command substitutes for observed hosted readback after a restart and
a new native deployment. Legacy app-owned roles must be recorded explicitly;
authenticated runtime preparation cannot guess the accepted role policy.

For approved hosted Preview persistence, follow
[hosted app runtime preparation](hosted-app-runtime.md). Builder uses the
owner-selected Vercel installation and existing native Neon branch, keeps
installer credentials protected, and journals restricted branch bindings and
private recovery state. A missing native connection is a precise path blocker.
