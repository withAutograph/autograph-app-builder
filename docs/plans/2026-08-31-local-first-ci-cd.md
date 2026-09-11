---
title: "Local-First App Builder CI/CD plan"
created_at: 2026-08-31
type: implementation-plan
status: normative
---

# Local-First App Builder CI/CD

This is the normative CI/CD plan for the Local-First App Builder SDLC. It
separates fast developer iteration, deterministic review evidence, and
authorized publication. CI/CD is a consumer of reviewed App Builder bytes and
receipts; it is not an additional builder authority and it never hides provider
or marketplace mutation inside the builder runtime.

## Operating model

Developer iteration remains:

```text
mise run dev  ->  live code  ->  Vercel Sandbox  ->  local/browser proof
```

The developer owns the running process and the Vercel Sandbox session. The
local flow may use live source and ephemeral artifacts, but it does not publish
the plugin, write GitHub `main`, mutate the marketplace, or deploy Production.
Microsandbox, OCI image publication, and GHCR are not part of this design.

PR pushes are the review boundary. GitHub Actions checks the exact PR commit
with the repository-managed mise toolchain, then runs deterministic provider-
backed Vercel Preview proof using project-scoped OIDC. Preview proof may read
and exercise the configured Vercel project, but it must not mutate Production,
GitHub repository state, the release marketplace, or unrelated Vercel
projects. A preview URL and an attestation bound to the PR SHA are review
evidence, not publication authority.

Pushes to `main` are the release boundary. Exact-main CI must pass first; only
then may the workflow build the final package and deployment output once,
record immutable digests, publish the identical bytes, and perform CD. The
deployment and package publication steps are separately authenticated,
receipt-bound, and fail closed. Laptop-driven publishing and static provider
keys are forbidden.

## Required gates

The implementation must retain mise as the command authority. CI bootstraps
the pinned Node and pnpm versions through the repository configuration and
installs the locked dependency closure. Every gate must report the commit SHA,
tool versions, command, result, and sanitized artifact/receipt references.

### PR gate

The required aggregate check is `check`, which must depend on and require all
of these lanes for the exact PR head:

1. `repository`: format/lint/typecheck and repository contract checks via
   `mise run ci-repository`.
2. `eve-general`: deterministic general Eve evaluations via
   `mise run ci-eve-general`.
3. `eve-fresh-bootstrap`: fresh-repository bootstrap evaluations via
   `mise run ci-eve-fresh-bootstrap`.
4. `sandbox-toolchain`: the pinned sandbox toolchain proof via
   `mise run ci-sandbox-toolchain`.
5. `package-build`: canonical plugin validation and deterministic package
   build via `mise run ci-package-build`.
6. `auth-e2e-emulated`: local provider-emulation authentication and callback
   coverage via `mise run ci-auth-e2e-emulated`; it must never contact a real
   provider.
7. `vercel-preview`: build/deploy the exact PR head to the allowlisted Vercel
   project, exercise the provider-backed Preview path, verify health and the
   expected public contract, and emit a signed or otherwise provider-verifiable
   attestation. The job uses GitHub's short-lived OIDC identity exchanged only
   for the Vercel project-scoped deployment permission.

The Preview job must verify that the deployed commit and returned deployment
identity match the checked-out PR SHA. It must clean up only its own preview
resources. No secret named `VERCEL_TOKEN`, static Vercel project key, cloud
provider key, registry password, or marketplace credential may be required by
this lane.

### Main gate and CD

The `main` push workflow reruns the same deterministic gates against the exact
`main` SHA; a successful PR run is not substituted for exact-main evidence.
After the aggregate exact-main `check` succeeds, it must run, in order:

1. **Final build:** create one clean, reproducible application/plugin and
   deployment candidate from the exact SHA. Capture source SHA/tree, package
   version, deployment identity, file manifest, and SHA-256 digests.
2. **Byte verification:** validate the candidate with the repository-owned
   release validator and prove that all derived manifests, archives, checksums,
   and deployment inputs are mutually consistent. Any rebuild after this point
   creates a new candidate and requires the gates again.
3. **Immutable publication:** publish the exact verified plugin bytes and
   release receipt through the controlled GitHub release path. Publication
   must be idempotent and reject a changed candidate, tag, version, source
   SHA/tree, or digest.
4. **CD:** deploy or promote only the verified deployment bytes to the intended
   Production Vercel project, then verify readiness, exact-source identity, and
   health. Promotion must not rebuild.
5. **Marketplace handoff:** provide the immutable release identity to the
   marketplace's reviewed import flow. The builder repository must not receive
   marketplace-main credentials or directly mutate marketplace state.

The existing `mise run release:prove` semantics remain the model for candidate
creation and `mise run release:publish` remains an explicitly authorized
mutation boundary. The automated workflow may invoke equivalent repository
tasks only with short-lived workload identity and an environment-protected
approval where required; it must never silently turn a developer command into
publication.

## Failure behavior and stop conditions

Every gate is fail closed. A failed, cancelled, timed-out, missing, malformed,
or SHA-mismatched result blocks the aggregate check or its downstream stage.
Provider unavailability, OIDC exchange failure, deployment drift, missing
receipt binding, digest mismatch, dirty candidate, unexpected tool version, or
ambiguous release state is an explicit blocked result—not a reason to fall back
to a static key, local laptop, Microsandbox, OCI/GHCR path, or manual mutation.

PR failures leave no Production or marketplace side effect. Main failures stop
before the first unauthorized downstream mutation; if a controlled publication
has already succeeded, the workflow records the immutable receipt and stops CD
until an operator-approved, receipt-bound retry can continue. Retries are safe
only for idempotent operations against the same exact identity. A new source
SHA or changed bytes require a new full run.

## Ownership and authority

- **Developers** own local iteration, test diagnosis, and PR changes.
- **GitHub Actions** owns reproducible CI, exact-head attestations, candidate
  digesting, and receipt publication under protected workflow permissions.
- **Vercel** owns deployment execution and project-scoped OIDC trust policy;
  the workflow may address only the allowlisted project and environments.
- **The release owner** owns the protected approval for Production and the
  decision to continue after an already-recorded immutable publication.
- **The marketplace** owns import, review, publication, and rollback of its
  catalog. App Builder supplies release evidence but has no marketplace write
  authority.

No builder request, Eve tool, local shell, or generated app may mint or relay
these authorities. Runtime provider connections remain scoped to their product
contracts and are not reused as CI/CD credentials.

## Rollout

Roll out in ordered, reversible stages:

1. Land this plan and agree the required-check names, allowlisted Vercel
   project/environment, OIDC claims, retention policy, and protected owners.
2. Implement PR CI and the Preview attestation in shadow/report-only mode;
   compare exact-SHA and byte-manifest evidence without publication.
3. Make `check` and the Preview proof required for PR merge. Verify negative
   cases for wrong SHA, wrong project, provider outage, OIDC denial, and
   attempted Production/marketplace mutation.
4. Implement exact-main final-build and immutable publication in a protected
   environment. Run against a non-production release candidate and verify
   idempotent retry and digest mismatch rejection.
5. Enable Production CD with manual/protected approval, then enable the
   marketplace reviewed import handoff. Retain rollback receipts and audit
   logs for every release.
6. Remove superseded workflow paths and credentials only after an observed
   successful release and a documented rollback drill. Keep the system
   fail-closed if any required provider or receipt readback is unavailable.

The implementation phase begins only after the coordinating task sends the
exact acceptance marker `LOCAL_DEV_ACCEPTED <sha>`. Until then this document is
the design artifact; no workflow, release task, runtime code, provider state,
or marketplace code is changed under this plan.
