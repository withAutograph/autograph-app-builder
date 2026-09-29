# Build and revise Arrusted apps with App Builder

Use the web App Builder or its [five public MCP tools](public-mcp-contract.md)
to submit a product brief and continue the saved session. The workflow owns
source acquisition, setup, implementation, validation, recovery, and review.
Do not reproduce those steps with direct app edits or private workflow calls
when measuring public Builder behavior.

## Source and setup

New apps use `withAutograph/arrusted-development`; existing apps use the selected
GitHub repository and exact app ID. Builder resolves provider access and prepares
an isolated writable checkout. Local development instead uses the live Arrusted
checkout supplied to `mise run dev`. Source inspection, preflight observations,
package layout, and template CI are diagnostic context, not acquisition gates.
A source receipt records acquired bytes, not passing GitHub checks.

The repository's mise configuration owns its toolchain and commands. Arrusted
uses Bun: retain the target's installation sequence rather than substituting
Builder's own dependency task. Existing draft reconciliation starts with
`mise exec -- bun install --frozen-lockfile`. Cache misses use normal setup.

Obtain identity through
`mise run repository:exec -- app-identity.ts --app <app-id>`. Its required fields
own the package, project name, workspace, default routes, and specification
paths. Preserve repository-owned project names; additional producer metadata
is not a reason to reject the identity.

After the component-backed prototype and implementation plan are ready,
**Build this app?** authorizes only private implementation and validation.
Accepted Markdown is staged at `.config/app-specs/<id>.md` and copied as the
app's specification snapshot. Optional `.config/app-specs/<id>.cue` selects
CUE-backed generation. Markdown alone does not request a backend. The public
creation operation is `mise run create:app <app-id>`; existing-app iterations
carry reviewed app-owned changes instead of recreating the workspace.

Generated manifests use `catalog:` for repository catalog versions and
`workspace:*` for internal packages. Generator profiles define the standard
scaffold dependency/tooling set. App-specific dependencies need appropriate
reviewed manifest and lockfile changes; they do not automatically require a
shared profile or catalog addition. Preserve scaffolded infrastructure and use
the supported review/apply path rather than replacing it in implementation files.

## Implementation and private validation

Carry prototype interactions into the actual app and focused behavioral tests.
Repository conventions guide architecture; source-pattern heuristics remain
advisory. Repository checks and exercised behavior establish durable writes,
authentication, and tenant isolation. A reachable page or success toast alone
does not establish those outcomes.

Builder invokes the selected app's normal `app:check` and `app:test` tasks.
For stale checked CUE artifacts, use `compile-app-schema-release`, then rerun
validation on the compiled checkout. Prepare local data only when the selected
app declares it and the walkthrough requires it, using
`prepare-app-local-preview`. Run app-owned browser tests through
`run-app-browser-tests` when applicable. Report actual task failures and repair
their diagnostics rather than weakening the product to pass a probe.

`start_app_preview` returns the running implementation's private expiring URL.
Reuse it for the same build and launch settings. Exercise the accepted walkthrough
and independent readbacks; report uncovered outcomes explicitly. Spend Review's
current workflow is authenticated-only. Its retired local-demo path is not an
alternative to verifying the current access requirements.

## Recovery and draft updates

Continue the saved session after interruption. Validation logs are tenant and
session scoped, sanitized, and paged: when an excerpt is truncated, use
`get_validation_log` with the returned reference and continuation cursors to
retrieve the full output. Do not substitute an excerpt for the complete evidence.
Legacy source receipts and checkpoint recovery remain supported.

For an existing draft PR, use `prepare_github_draft_pr_reconciliation` to prepare
an isolated current-base candidate. Resolve only selected app conflicts with
the inspection/resolution tools; leave platform-owned conflicts to their owner.
If formatting is needed, `format_github_draft_pr_candidate` runs the
repository-owned formatter on that candidate and may change only the selected
app. Formatting invalidates earlier validation and review.

Run `validate_github_draft_pr_reconciliation` with `incremental: true` and
`expectedCommand: "mise exec -- bun install --frozen-lockfile"` on the first
call. Continue with each exact returned `nextCommand` until `status` is
`validated`. After interruption, repeat the pending command in the saved
session. A changed checkout restarts validation. Review and page through both
complete diffs: the final changes against current base and the changes against
the old PR head. Seal that result and pass its approval receipt unchanged to
`reconcile_github_draft_pr` after separate approval to update the named PR.
A moved base or head requires a newly prepared, validated, reviewed result.

## Delivery evidence and Production

Private validation, exercised behavior, GitHub checks, hosted Preview proof,
and Production readiness describe different outcomes. Publication is optional
and requires its own approval; a successful private build does not authorize a
push, PR update, merge, deployment, or provider mutation. Keep Arrusted's
explicitly deferred draft-CI switch deferred.

When validation returns `productionHandoff`, include the declared route, roles,
checked release, operator guide, and blockers. Missing Production metadata does
not invalidate private validation. The handoff starts a separate Production
iteration: a protected operator owns tenant preparation, access grants, and
hosted activation. Protected Preview access and denied paths still need proof;
native provider activation precedes Gateway routing and semantic read-only
Production proof. Builder does not claim readiness or activate resources merely
because local tests, a draft PR, or source metadata look complete.

The [create-app skill](../agent/skills/create-app/SKILL.md) specifies internal
tool sequencing; [repository compatibility](repository-compatibility.md)
defines its integration boundary.
