---
title: "App Builder consumption of the Arrusted template"
created_at: 2026-08-31
type: implementation-plan
topic: arrusted-template-consumption
status: active
---

# App Builder consumption of the Arrusted template

Every new App Builder application starts with a detached clone of the private
`https://github.com/withAutograph/arrusted-development.git` at
`refs/heads/main`. The source transport resolves that ref once, records the
observed commit/tree, verifies the successful Arrusted `Template readiness`
GitHub Check Run for that exact SHA, and runs the repository-owned planning,
generation, and validation contract from that exact source. App Builder does
not reconstruct a starter project from a generic internal template.

## Clone boundary

The canonical remote and ref are constants, never user input. The source
transport mints one per-acquisition installation token through the existing
Autograph GitHub App. Its only deployment configuration beyond the existing
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` is
`APP_BUILDER_TEMPLATE_READER_INSTALLATION_ID`. It is never selected from a
user’s publishing installation. The current deployment-owned installation may
retain all-repositories access while the existing App supports publication;
each reader token is explicitly minted for only the fixed
`withAutograph/arrusted-development` repository ID and cannot access another
repository through this reader path.

This deliberately accepts the existing App private key’s shared-registration
blast radius. An all-repositories installation is weaker than the planned
dedicated selected-repositories installation: possession of the App private key
could mint a broader installation token outside this code path. The runtime
reader token restriction is defense in depth, not a replacement for a dedicated
reader App.

The token request is constrained to `Contents: read` and `Checks: read`.
App Builder validates that those capabilities are present and that every
returned capability is read-only; an additional read-only permission does not
invalidate an otherwise repository-scoped token. It also validates the
installation’s live repository inventory before cloning. It uses the token only
to validate that inventory, make the one direct workspace clone, and read Check
Runs for the resolved SHA. The source transport writes it only to a temporary owner-only
askpass credential file, removes the file on every success or failure path,
and restores `deny-all` networking after cloning. It disables prompts,
inherited Git configuration, hooks, SSH/file protocols, and submodules, and
refuses an origin, ref, tree, or clean-worktree mismatch. The token, reader
installation ID, authorization header, and credential digest never appear in
the receipt, Git remote/config, persisted sandbox files, or command output.

An existing repository remains an explicit allowlisted local source. It never
falls through to the fresh-template clone path.

## Provenance and execution

New template clones produce source-receipt V4. The receipt binds the canonical
repository, requested ref, source SHA/tree, adapter eligibility and contract
digests, and a digest of the successful readiness Check Run's immutable
metadata (ID, name, completion time, and conclusion). Before fixed target
commands, the locked dependency closure is bootstrapped once under a fixed
allowlist, keyed by source SHA and sandbox platform, made read-only, and
followed by a restored `deny-all` network policy. V3 receipts remain readable
for sessions that began before clone provenance existed.

## Readiness admission

Arrusted CI runs `mise run repository:template-readiness -- --expected-sha <sha>`
in its `Template readiness` job. It produces its own sanitized JSON attestation,
while App Builder independently checks the completed successful Check Run through
GitHub's commit Check Runs API using the reader token and records the metadata
digest above. The Check Run is admission evidence only; it is not a control
file, provider credential, or authorization for any App Builder provider
mutation.

A newly pushed Arrusted `main` commit is unavailable to new-app sessions until
that exact commit's `Template readiness` job has completed successfully. The
resolver stops before dependency bootstrap or target commands when the evidence
is missing, pending, failed, malformed, or bound to another SHA/tree. This
makes the Arrusted push and its CI proof an ordered deployment boundary rather
than treating a default-branch update as readiness by itself.

App Builder performs one fixed HTTPS detached clone directly into the
session-owned `/workspace/repository`. That checkout resolves the ref, emits
the closed source-inspection snapshot used for the V4 receipt, and becomes the
prepared workspace after exact-SHA readiness admission. It verifies the
remote, ref, SHA, tree, clean status, and submodule absence before recording
the prepared-workspace manifest. Approval and preparation re-verify that same
checkout; they do not fetch, clone, or reconstruct it. All fixed repository
planning, generation, apply, and validation commands run from this detached
workspace clone. It is never mutated by user work or published directly.

Fresh-repository publication still requires its own approval and provider
read-back. Its result is a new parentless `main` commit containing the reviewed
generated workspace, not Arrusted history or an upstream remote.

## Possible improvement: visual inheritance

The repository starter and the visual prototype are separate surfaces. App
Builder currently consumes the complete Arrusted repository for eligibility,
planning, generation, apply, and validation, but the first Browser preview is
a self-contained HTML design artifact. It is not the rendered output of the
generated Arrusted application and must not be presented as evidence that the
production application already inherits Arrusted's visual system.

The Arrusted app generator also provides a deliberately minimal Next.js
workspace today. Its initial page contains only the generated application
title, and its package manifest does not automatically depend on the Arrusted
design-system package or install a shared application shell. Builder guidance
directs the agent to inspect current semantic tokens, Storybook stories,
package exports, and working applications, but that guidance alone does not
structurally guarantee visual consistency. A visually unrelated prototype is
therefore possible even when source selection and repository generation are
correct.

A future visual-inheritance improvement should preserve the fast, disposable
HTML prototype for early product exploration while adding a later preview of
the actual generated application. The bounded improvement should:

1. define an Arrusted-owned route-app starter surface containing the supported
   shell, semantic tokens, and public component dependencies;
2. update the canonical Arrusted generator to consume that surface without
   copying private app-specific workflow or stale token values;
3. require planning to name the current target-owned tokens, exports, stories,
   or reference application patterns used by the generated UI;
4. render the applied generated app in the integrated Browser before the final
   review boundary, while retaining the standalone HTML artifact as an earlier
   and cheaper design tool; and
5. add focused checks proving the generated app uses the declared public shell
   and design-system entrypoints rather than merely approximating their look.

Acceptance should distinguish three independent facts: the full Arrusted tree
was selected, the repository-owned generator and validation commands ran, and
the resulting application uses the supported Arrusted visual foundation. None
of those facts should be inferred from either of the others.

This section records a possible improvement only. It does not authorize an
Arrusted generator change, a design-system API change, or an App Builder runtime
change.

## Possible improvement: composition-only application UI

A stricter follow-up should require App Builder to construct application
interfaces exclusively by composing components that already exist in the exact
Arrusted source selected for the build. The builder must not design, generate,
copy, fork, or restyle a custom UI component to fill a catalog gap. It must not
treat a familiar component name, a screenshot, generated JSX, or a component
available from an unrelated package as proof that Arrusted provides it.

An eligible component must be verifiable from the selected Arrusted tree and
must be exposed through a supported public package entrypoint or an explicitly
documented application-composition surface. Existing private implementation
files are not a reusable API. The builder may supply product-specific content,
data bindings, routes, event handlers, permissions, and configuration through
the public component contracts, but it must not create new visual primitives,
component-local styling systems, replacement design tokens, or copied variants
inside the generated application.

The future composition-only workflow should:

1. inventory current public component exports, supported compositions,
   Storybook stories, required providers, and semantic tokens from the exact
   selected Arrusted tree before producing the interface plan;
2. express every visible interface region as a reference to one of those
   verified components or compositions, including its public import path and
   supported variant or properties;
3. generate route and data-wiring code that imports the existing components
   directly instead of emitting new component implementations;
4. constrain the early Browser prototype to the same verified catalog, using an
   Arrusted-owned preview harness or a faithful catalog-backed representation
   rather than free-form invented HTML controls;
5. fail closed when a requested interaction cannot be expressed with the
   existing catalog, recommend the closest supported product composition, and
   record any genuinely missing reusable component as separate Arrusted work;
   and
6. keep the missing-component work outside the generated app so a one-off local
   component cannot silently become the workaround.

Focused acceptance checks should prove that every application UI import resolves
to an approved Arrusted public entrypoint, every declared component exists at
the selected source tree, and the generated app adds no local React component
definitions or app-owned visual CSS beyond explicitly allowlisted route-layout
glue. The Browser preview and applied application should share the same
component-composition manifest so the prototype cannot promise an interface the
generated app implements differently.

This policy intentionally favors consistency and reuse over unconstrained UI
generation. If the existing Arrusted catalog cannot deliver a material product
requirement, App Builder should explain the visible limitation and offer a
supported alternative; it must not invent a component. Adding a reusable
component to Arrusted is a separately reviewed prerequisite, after which a new
build may consume it from the updated exact source.

This section also records a possible improvement only. It does not authorize a
component-catalog expansion, a generator change, or generated application
mutation.

## Validation

The source boundary is tested for required read-only reader permissions and
exact repository scope, rejection of unavailable, write-capable, or mismatched
reader tokens, canonical origin/ref resolution, detached checkout state,
immutable V4 receipt validation, clone drift rejection, and token cleanup on
success and failure. Explicit existing repository behavior remains unchanged. Local and
hosted runtime paths use the same clone provenance contract and fail closed
before bootstrap when reader configuration, token minting, cloning, or readiness
evidence is unavailable.
