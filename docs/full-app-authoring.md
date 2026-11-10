# Complete app authoring

A request to build a complete app includes its working interface and any
backend, authentication, persistence, and checks its requirements call for. Builder authors the whole app through the same public
workflow; a manually completed Arrusted patch is not evidence of that capability.

## Build phases and delivery

The intended complete-app journey has four business phases:

1. **Initial version and approval.** Turn the product brief into an implementation plan. Use a visual prototype
   when it helps refine the design. Present **Build this app?** through
   the existing approval card. Infer safe defaults and ask only material product
   questions.
2. **Build.** Implement the approved app, including its authenticated backend and
   persistence. Keep the private checkout and accepted session; repair concrete
   failures through supported tools. Start the applied app as soon as it can run
   and use its working preview for feedback. For reviewed delivery, validate the
   selected repository's native app build and declared app tests. Run explicitly
   requested lint separately and report its findings as advisory. Use focused
   checks during implementation and one final local acceptance pass when the
   behavior is ready.
3. **Review the change set.** Record the source to be published against the
   accepted plan. Keep technical checks, independent
   source judgments and executed product behavior distinct. Reuse current
   evidence when its inputs match. Technical validation returns deferred source
   evidence. Request an independent assessment at `accept_change_set` only when
   it serves the app. A source repair requires current
   validation and final acceptance before presenting the repaired result as
   reviewed. A review interruption alone does not require another technical run.
4. **Deliver.** Complete the requested deployment and submission through supported
   capabilities and the existing approvals for their visible effects. Delivery
   is part of the requested outcome when the brief includes it. A private preview
   or draft pull request alone does not establish deployed product behavior.

These phases describe product work, not exactly four model API requests. Tool
loops, product questions, genuine repairs and provider context limits can require
additional calls. Deterministic setup, command execution, paging and receipt
handling belong to the shared workflow; they should not each require a new model
judgment. See [model use and cost accounting](builder-model-cost.md).

The current workflow provides implementation, review and preview, with
separately approved publication when requested. Production activation remains a
protected operator handoff. The fourth phase is the intended delivery contract;
this documentation does not add an automatic deploy-and-submit operation or
expand the scope of the agreed work. Report unavailable delivery capabilities and
remaining handoff work precisely. Preserve the original public session and all
approval decisions throughout these phases.

### One app destination and public delivery

The default hosted result is the live app at its final URL. After private
validation and review, complete the approved release preparation and
native delivery described in [public app release](public-app-release.md).
The owner uses the live app first and shares it through its access controls.
A hosted Preview and synthetic acceptance run are optional.

The [A-469 execution decision](plans/2026-11-03-a469-normal-builder-public-delivery.md)
records the local-first implementation milestones and remaining acceptance gaps.

Resolve delivery from the accepted app and its owner-scoped provisioning result.
Normal Builder provisioning derives `apps-<app-id>`, links the selected repository,
and creates one native Vercel Services project rooted at `.`. Reuse that exact
verified project for runtime setup, publication, delivery and existing-app
revisions. An existing project requires recorded ownership and current provider
readback; a matching name alone is not ownership. Do not create another app,
Preview or Auth project merely to complete acceptance. Gateway, Auth and app
Services follow the selected repository's single-project composition; the
privileged installer/operator remains separate infrastructure.

For a requested public release, the app's public domain must open without a
Vercel account. Better Auth still owns sign-in, organization membership, app
assignment and action authorization. Standard Protection can retain protection
on deployment URLs while leaving the production domain public. A public domain
does not authorize public product data, provider activation or customer
Production changes. Public delivery must be an explicit supported Builder effect,
not a manually completed deployment or a renamed protected Preview receipt.

The protected native Preview onboarding contract is a distinct capability, not
the required destination for every normal app. Its frozen plans, approvals and
uncertain outcomes keep their original meaning. A changed destination or exposure
requires a supported new intent and its own effect approval, preserving history;
never rewrite a journal or replay an uncertain response to obtain consent.
Missing standard-destination or public-delivery automation is a Builder defect
to repair in the shared workflow, not work for the evaluator to do privately.

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

Optional provider integrations use the same app-owned composition for new and
existing apps. Follow the [optional integration authoring reference](../agent/skills/create-app/references/optional-integrations.md)
to discover actual provider recipes, bind generated schema fields, and run
`install-app-integrations` as part of implementation. Its fixed repository
operation installs only opted-in provider ingress and an optional shared
integrations surface. The app DAL supplies real central connection/binding
authority and safe presentation data; a generated page or passing install is
not a connected or activated provider. AppSpec integration prose carries product
intent; executable app definitions carry recipe selection and target bindings.
Existing navigation composes the generated navigation entry explicitly.

The [App Builder / Autograph integration delivery handoff](optional-integrations-delivery.md)
records the ordered runtime and migration prerequisites, owner roles, current
PR evidence, public acceptance and recovery boundaries. Follow that sequence
before describing the optional capability as ready for live use.

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

The agreed app requirements guide implementation and validation. Repository
publication, provider resources, production data changes, and activation remain
separately approved outward effects. A blocked public run must retain its
session and precise failed operation; manual implementation cannot replace it
in acceptance evidence.

## Repository runtime contract

Use `app:describe` for selected release, declared roles, database environment and
validation tasks. For a source-owned Vercel build profile, declare
`autograph.deployment` in that app's package manifest with explicit `framework`,
`sourceFilesOutsideRootDirectory`, and optional `buildCommand`; `app:describe`
emits it with the selected release, while `app.workspacePath` supplies the
delivery root directory. An absent declaration remains valid for older source.
Use `app:runtime prepare` for isolated authenticated validation;
its protected environment and session files are injected by Builder into app
validation and Preview startup. Author `test-e2e` to consume `APP_TEST_IDENTITIES_FILE`
and exercise real browser submissions with those sessions. Backend validation
runs this task after repository checks and reports missing tasks as blocked.
The shared `@autograph/playwright-config` configuration uses `APP_TEST_BASE_URL`
for the prepared Preview and omits its local server when that origin is supplied.
Where the selected repository exposes `@autograph/playwright-config/normal-actors`,
import its `test` and `expect` for authenticated product tests. Select
`actorContext({ actorKey, organizationId })` from the private manifest; the same
account may have separate sessions in several organizations. Open a page on that
context and exercise the accepted journey. Keep actors with `roles: []` available
for assignment-denial cases. The fixture preserves actual cookie files and
closes the contexts; do not copy credentials, rewrite cookie domains, or insert
workload tokens into browser requests. Improve a missing shared capability in the
repository workflow instead of making the evaluator implement it or duplicating
it in each generated app.

Assertions should cover the accepted product behavior and access boundaries.
Do not require incidental DOM positions, exact opaque IDs, file names, internal
call counts or event ordering. Additional valid actors, ordinary UI revisions and
normal source changes must not become admission gates. A shared fixture supplies
sessions; app-owned tests still need to exercise the full accepted actor and
organization scenarios.

No passing command substitutes for observed hosted readback after a restart and
a new native deployment. Legacy app-owned roles must be recorded explicitly;
authenticated runtime preparation cannot guess the accepted role policy.

For approved hosted Preview persistence, follow
[hosted app runtime preparation](hosted-app-runtime.md). Builder uses the
owner-selected Vercel installation and existing native Neon branch, keeps
installer credentials protected, and journals restricted branch bindings and
private recovery state. A missing native connection is a precise path blocker.

## Authenticated routes and readiness

For native Next App Router apps, read the installed framework guides and the
repository's cache-component guidance before implementing request-dependent
reads. Put uncached session, tenant and database reads beneath the appropriate
Suspense boundary. Exercise the initial form route and the destination after a
successful Server Action: a committed row does not prove navigation rendered.

Use the repository-described mounted schema receipt path. In Arrusted, a mount
`/<app-id>` places the protected handler at
`app/<app-id>/api/schema/route.ts`, serving `/<app-id>/api/schema`.
A root `app/api/schema/route.ts` does not serve that mounted path. Preserve
server-derived authentication, no-store responses, checked release tracing and
the harmless scoped read required by the repository contract. Verify the app
page and receipt through the Gateway, checking readiness, app, tenant and
selected release values rather than HTTP status alone. Do not change scaffolded
configuration through implementationFiles; report an infrastructure repair to
its repository owner when tracing or route discovery needs an update.

A fresh-process persistence check stops and starts the app against the same
database. Recreating the fixture database or reusing the original app process
cannot establish this result. Preserve failures and mark cases skipped after a
failure as unassessed; a schema receipt does not replace the product journey.

For hosted delivery, follow [Production handoff](production-readiness-handoff.md)
for reviewed Auth identity, runtime binding and QA access requirements. Missing
operator/provider capabilities remain explicit handoff work, not a reason to
bypass authentication or block ordinary private app authoring.

Application roles in accepted product prose must be implemented in the app's
CUE `authorization.roles` and matching model/operation/field/row grants. The
compiler's checked `extras.authorization_policy` supplies canonical role IDs
to `app:describe` and authenticated runtime preparation. Builder does not infer
those grants from Markdown or inject default runtime roles. When accepted
requirements name roles missing from the compiled policy, update the same app
through ordinary Builder implementation controls and regenerate its checked
release.

Authentication does not require business roles. An accepted app with no business
roles retains its empty role list and accepted authentication/access design. If
repository-owned local runtime setup rejects that list, Builder reports and
repairs a platform/local setup issue without asking the creator for schema roles,
adding a default role, injecting `APP_RUNTIME_ROLES`, or weakening access checks.
The actual command failure remains failed and affected runtime behavior remains
unassessed. Use the normal delivery and applicable source-validation flow;
optional local Preview does not add a release qualification gate, and selected
required checks still must pass.

A reconciled draft candidate runs selected browser tests with its own prepared
runtime and local Auth origin, or its ordinary frontend server. Do not borrow
launch authority from the original app's working preview. Keep protected-runtime
refusals, actor and tenant isolation, recording protections, cancellation and
actual test failures intact.
