---
name: create-app
description: Guide creation or revision of a route-owned Next.js app in a supported Autograph repository, from product design through a usable prototype, implementation plan, reviewed changes, and separately approved publication. Use as the primary entry point when a user asks to create a new app or improve an existing app. Route explicitly bare/local-only Next.js workspace requests to $scaffold-app-workspace.
---

# Create App

Create one working private app without crossing provider or deployment authority.
Keep product acceptance separate from approval to mutate source and topology.

For optional React 19.3 UI and security capabilities, follow
[React 19.3 guidance](references/react-19-3.md). These capabilities are never
implicit starter defaults.

Use only discovered builder-owned tools. If the required identity, planning,
prototype, apply, review, or publication operation is unavailable, stop at the
last completed receipt and report that implementation gap. Never replace a
missing operation with a raw shell command or generic file write.

## Workflow

Use the same component-backed `record_ui_preview` path locally and hosted.
Prepare automatically, infer a useful design, and compose it with current
Arrusted public components/compositions and their token entrypoint. Do not use
a standalone HTML prototype, invent components, or substitute custom controls.
Adapt catalog gaps with existing components or explain a product alternative.
Continue from the Browser preview to the implementation plan without asking for
setup or design-recording approval. For existing apps, inspect their current
app-owned files and reuse the same component-backed preview flow.

1. If the user explicitly requests only a bare Next.js workspace, follow
   [$scaffold-app-workspace](../scaffold-app-workspace/SKILL.md) and stop this
   route-owned flow. Do not interpret a generic “create an app” request as bare
   scaffolding.
2. Resolve one concise user-facing app name and one lowercase kebab-case app id.
   Preserve each explicitly supplied valid value. When either is omitted, infer
   it from the product brief, tell the user the inferred value in one short
   sentence, and continue without confirmation. Derive an inferred id
   deterministically from the chosen name by lowercasing it, replacing each run
   of non-alphanumeric characters with one hyphen, and trimming hyphens. Ask
   only when the result is unsupported, the prepared source proves a real
   workspace/package/prototype collision, or the brief is materially ambiguous.
   When the user names an existing path as `apps/<app-id>`, preserve that exact
   final path segment as the app id for inspection and planning. Never rename,
   pluralize, or re-infer it.
   The selected adapter's builder-owned identity operation remains authoritative
   for target planning; never construct or guess a repository script path.

3. Select the source before any hosted sandbox inspection or preview. Call
   `source_status` with `sourceKind: "fresh-template"` for a new app's canonical starter, or
   `resolve_github_source` for an existing GitHub app. Then prepare a writable
   builder workspace automatically. Use source discovery and repository commands as context, not
   as approval gates. Do not require separate inspection or source-acquisition
   questions, and do not ask the user for internal paths or setup details. Use
   the runtime's local or hosted source directly without asking for internal
   paths. Inspect useful files and components opportunistically. Do not request
   approval for source inspection, workspace preparation, or prototypes.
   Source-layout and preflight observations are diagnostic. Fresh acquisition
   does not require a named template CI check or a guessed package scope. Keep
   the identity command's required fields and repository-owned project name;
   ignore additional producer metadata. Source receipts are not CI evidence.
   Use `inspect_repository` to read the selected checkout's
   `docs/guides/building-apps-with-app-builder.md`, then the app's `README.md`
   and `AGENTS.md`. For CUE-backed features, read `docs/generated-data-operations.md`
   and `docs/schema-compiler.md`. Follow current repository docs and actual
   commands; missing documentation is context to investigate, not a build gate.
   Preserve unrelated changes.
   When the brief requests an existing app revision from an agreed historical
   version while retaining current shared platform capabilities, select that
   baseline in this first `resolve_github_source` call, before reading any app
   source. Use `appBaseline: { appId, source: { kind: "merged-pr",
pullRequestNumber } }` for a named merged PR, or `{ kind: "commit", commitSha }`
   for an explicitly supplied full commit. The platform branch/open PR remains
   the ordinary source selection. Builder verifies and projects the app itself;
   never ask the evaluator to restore files or manually construct a baseline.
   Retry the saved selection after a preparation failure. Report the receipt's
   historical app source and actual platform base separately from newly authored
   changes. Retained later release archives are not initial implementation input;
   do not inspect them to copy a later revision. A baseline is provenance only,
   and grants no publication, deployment, or readiness authority.
   For a hosted existing repository named as `owner/name`, use only
   `resolve_github_source` with `selectedInstallationId: null`; it owns the
   current access readback, source inspection, and isolated preparation without
   a preceding access tool. When
   it requests GitHub authorization, allow the structured Store In control to
   collect or expand repository access and wait for the parked turn to resume.
   Never ask “Repository selected?” or request installation ids, SHAs, trees,
   settings changes, or other access mechanics in chat. When the tool returns
   `scope-selection-required`, present its one product-facing GitHub-account
   choice using the exact installation ids as option ids, then retry
   `resolve_github_source` with the selected `selectedInstallationId`. Do not
   make scopes selectable inside an authorization request.
4. If the conventional AppSpec is absent or incomplete, follow
   [$design-app](../design-app/SKILL.md) in this same task. Synthesize its
   build-ready handoff from stated decisions and safe revisable defaults, then
   validate and record it silently. If validation reports technical or schema
   errors, repair completeness and retry automatically. Ask only when an
   unresolved choice materially changes the product; otherwise do not prompt
   for artifact recording or formal AppSpec acceptance.
5. Accepting the product design automatically prepares its private durable
   creation state. New apps use `mise run create:app <app-id>` through the
   builder-owned apply tool. The command derives identity and default routes
   from the id and current catalog. The accepted Markdown is staged at
   `.config/app-specs/<id>.md` and copied into the generated app as a snapshot.
   Only `.config/app-specs/<id>.cue` selects CUE-backed generation; Markdown
   alone never requests a backend. Additional routes require a separately
   reviewed topology edit. For existing apps, supply exact app-owned changes
   when accepting the design; inspect the returned paths to repair a missing
   preimage and retry acceptance. When creating or evolving a native Next App
   Router zone, load `$arrusted-next-app-like-experience` before applying it.
6. Carry `productAcceptance.implementationPrompt` from design acceptance into
   implementation: it contains the accepted walkthrough, not a new product brief.
   Keep its user actions and independent readbacks visible in behavioral tests.
   When later tools return `productStatus: unassessed`, describe technical checks
   as passed without claiming the product outcomes have been verified.

   For a new app, compose the actual product implementation from the prototype,
   brief, and inspected Arrusted conventions, using only existing public
   components and compositions without local replacement components. Include the app-owned TSX,
   styles, and focused tests needed for the described experience. Preserve the
   prototype's navigation and action outcomes from `design-app`'s interaction
   walkthrough, adapting preview hash routes to the generated app's actual
   router. Test visible state changes, form validation/cancellation, and
   cross-screen consistency; do not replace working prototype actions with
   inert buttons or toast-only success.

   Keep the scaffolded repository infrastructure authoritative. Do not include
   `package.json`, lockfiles, `next.config.*`, `tsconfig.json`, Turbo config, or
   duplicate frontend entrypoints in `implementationFiles` for a new app. Use
   the dependency versions and scripts already present in the prepared
   workspace; never guess or pin framework versions from model knowledge.
   For a complete app, Builder owns the backend and persistence implementation
   as well as the UI. Follow [full app authoring](../../../docs/full-app-authoring.md), including
   its authenticated route, mounted receipt and fresh-process persistence requirements.
   Use the Arrusted CUE/PostgreSQL data boundary for owned durable data: derive
   the CUE model and policies from the accepted product decisions, compile the
   checked release, and implement the authenticated server reads and actions.
   The user supplies product meaning, not schema source or backend code.
   Preserve `catalog:` and `workspace:*` references. The generator profile owns
   the standard scaffold toolset, not every app-specific dependency. Additional
   dependencies need the appropriate reviewed app manifest/lockfile changes,
   rather than an automatic shared-profile change.
   Implement production workflows as production behavior: durable drafts and
   recovery use server-owned storage and Server Actions or route handlers;
   provider returns use real callback routes and the repository's emulator or
   provider boundary; creation, cancellation, retry, and preview access use the
   app's real orchestration path. The generated app must own its backend and
   orchestration; do not delegate its product behavior to App Builder itself.
   An explicitly requested alternative backend requires a supported repository
   runtime and persistence lifecycle. If unavailable, report that capability
   gap; do not substitute filesystem or browser persistence for a hosted app.
   Browser storage, timers, and local state may
   support transient presentation, but never stand in for those outcomes.
   Prefer Server Component route shells and small interactive client leaves.
   Architecture source-pattern observations are advisory, not rejection gates.
   Verify durable writes, authentication, and tenant isolation through the
   repository checks and exercised behavior; client presentation alone does
   not establish server-owned persistence.

   Pass those
   model-authored files as `implementationFiles` to `apply_app_creation` with
   the concise product summary. For an existing-app iteration, the planned
   changes already carry the implementation and `implementationFiles` may be
   empty. File changes use `{path, content}` or `{path, operation: "upsert", content}`
   for complete contents and `{path, operation: "delete"}` for removal. Rename
   by deleting the old path and adding the new path in the same proposal.
   Preserve unrelated files; do not leave retired backend/demo modules behind.
   This produces the first normal user prompt: **Build this app?** Do not request approval before this point for
   session work, source access, inspection, design, prototypes, internal
   drafting, or planning. Never invoke the target command through generic shell
   access.

7. Treat approval of **Build this app?** as permission to edit, validate, and
   run the implementation in the private App Builder checkout. It is not
   permission to push a branch, open a pull request, deploy, provision app
   resources, publish a package, or change the user's external repository.
   Use `apply_app_creation` for the approved implementation. The prepared
   checkout remains the live working source; do not assume apply creates a
   fresh overlay or that normal source edits require a new workspace.
   When apply rejects a submission, send corrected files as an incremental
   retry: omitted files from the same approved proposal remain staged, and
   supplied paths replace their earlier contents. A new proposal starts a new
   staged implementation.
   Preserve unrelated changes. Repair actual reported technical failures
   through the supported tools when safe, without requesting the same approval
   again. If recovery is unavailable, explain the incomplete product outcome.
8. After apply succeeds, continue with `validate_app_creation`. It runs the
   repository's normal commands against the current applied app. When it
   reports a repairable failure, provide corrected `implementationFiles` to
   `validate_app_creation` and retry in the same approved checkout. Use the
   returned diagnostics and status; do not invent extra validation capabilities
   or treat a pending attempt as passed. Successful commands establish
   technical validation, not product acceptance. Use `get_validation_log` with
   each returned cursor when a repair excerpt is truncated. Use
   `change_set_status` and `accept_change_set` after validation to record the
   current reviewed changes;
   review is neither publication nor proof of working user interactions.
   Successful validation automatically runs the independent source assessment
   against the original request and accepted plan. An unchanged later review
   reuses that assessment; you do not need a separate tool call to obtain it.
   Repair cited product contradictions
   through `validate_app_creation` with corrected implementation files, then
   review again. An unavailable or clean source review never proves runtime
   success. Keep incomplete previews inspectable and report remaining checks;
   do not replace a requested backend outcome with a simulated transition.
   When revising an existing draft pull request, first use
   `prepare_github_draft_pr_reconciliation` to inspect its live base and head
   commits and prepare the private merge candidate. This step determines actual
   conflicts even when GitHub's mergeability status is stale. Resolve
   only reported conflicts under the selected app: read each file with
   `inspect_github_draft_pr_reconciliation`, then write its complete resolved
   content with `resolve_github_draft_pr_conflict`. Report a platform-owned conflict
   with its path and leave it for its owner. Run the selected app's schema,
   repository checks, browser tests, and applicable guard on the reconciled
   candidate with `validate_github_draft_pr_reconciliation`.
   If CI reports app formatting defects, run the repository-owned formatter
   with `format_github_draft_pr_candidate` on the isolated candidate before
   validation. It may change only the selected app. Revalidate and review both
   diffs after formatting; earlier validation and review no longer apply. For long
   reconciliation checks, set `incremental: true` and pass
   `expectedCommand: "mise exec -- bun install --frozen-lockfile"` on the first
   call. Each successful call returns the completed command and `nextCommand`;
   call the same tool again with `expectedCommand` set to that exact value until
   `status` is `validated`. A result of `in_progress` means checks remain; do
   not review or seal yet. If a tool call is interrupted, resume the same
   saved session and repeat the pending command. A changed checkout restarts
   validation from the first command. Use
   `review_github_draft_pr_reconciliation`, then page through both complete
   diffs with `inspect_github_draft_pr_reconciliation`: the final diff against
   the current base and the delta from the old PR head.
   Seal that exact result with `seal_github_draft_pr_reconciliation`. Pass its
   returned `approvalReceipt` verbatim to `reconcile_github_draft_pr`; the
   receipt names the existing PR branch head, not the PR's base branch. Ask
   for a separate update approval before moving the branch. If the
   base or PR head moves, prepare, validate, and review the new result again.
9. Continue to the implemented app's private preview with `start_app_preview`.
   If the repository defines `app:local` for the selected app and the preview
   needs local data, use `prepare-app-local-preview` first in the approved
   sandbox. Report its exact task failure rather than treating an HTTP-ready
   error page as working product behavior.
   Discover the repository's actual development command and supply its
   executable and argument array without shell wrappers. For a nested app
   package, set `workingDirectory` relative to the applied repository root;
   `landingPath` is the browser route, not the package directory. Configure the
   command to listen on the supplied port. Repair actual startup diagnostics
   through available supported capabilities; do not guess executable paths,
   reset the source, or start competing listeners to work around unresolved
   startup ownership.

   Use only the actual working URL returned by the tool. Never invent a
   localhost link or substitute the component-backed prototype. A reachable
   page alone does not prove hydration, working controls, persistence, or a
   backend. Exercise the accepted walkthrough against the implementation using
   available supported observation capabilities and focused behavioral tests:
   verify visible interaction outcomes and independent server readbacks for
   durable writes, reload/recovery, and the app's real orchestration where
   applicable. For an app-owned JSON write/read workflow, use
   `verify_app_behavior` with the exact accepted walkthrough outcome and the
   implemented app-relative routes. It supplies its own synthetic marker,
   performs the write, and checks a separate read. Report its result only as
   action/readback evidence: it does not test restart durability, authentication,
   tenant isolation, or child generation. Do not add a fake verification route
   or weaken the product to satisfy this check. Apps using other interaction
   contracts still need appropriate behavioral evidence; do not rewrite them
   merely to fit this tool. When the user is inspecting the private URL, keep
   using that same preview for the same applied build and launch settings;
   `start_app_preview` reuses it. Start a replacement only after the build or
   launch settings change, or when the current server is no longer running.
   Fixture interactions and command exit codes cannot substitute
   for this evidence. If an observation capability or external dependency is
   unavailable, identify the affected outcome as unverified rather than
   inventing a tool or claiming success.
   When the selected app has a repository-owned `test-e2e` task, use
   `run-app-browser-tests` for browser-only workflows that `verify_app_behavior`
   cannot exercise. Prepare required sandbox-local data first. Report the exact
   cases the tests covered and any missing behavior separately.

   When validation returns `productionHandoff`, follow
   [Production handoff](../../../docs/production-readiness-handoff.md) for
   reviewed Auth identity, explicit QA access and runtime binding delivery.
   Include its declared app route,
   roles, checked release, operator guide, and blockers in the result. Keep it
   separate from private validation and GitHub checks: a protected operator
   owns tenant preparation, access grants, and hosted activation. Missing
   Production metadata is not a private build failure. Preserve the selected
   app's authentication requirements; do not reintroduce a retired local-demo
   bypass to obtain a passing walkthrough.

   Deliver the actual private preview with a concise account of what works,
   what was checked, and any remaining incomplete or unverified outcomes.
   Publication is optional and separately authorized; do not make a repository
   or pull-request offer a required completion step. The configured output
   directory is a publication destination, so an empty destination does not
   mean the private implementation is missing. If the user requests publication,
   obtain the separate effect-based approval for the named destination and
   action. Present it with a short action title and one-click Accept and Cancel
   choices. For a draft pull request, name the repository and pull request,
   summarize the reviewed changes, and state that it remains a draft and will
   not be merged or deployed. Do not show commit IDs, content digests, receipt
   JSON, or other internal verification values. One approval never authorizes
   another outcome. Keep internal execution mechanics out of the public
   conversation.

## Boundaries

- Infer only safe, revisable prototype defaults. Never infer Production
  authority. Never mutate the prepared source or target checkout, or publish
  reviewed changes, without effect-based approval for that exact outcome.
- Never use `$scaffold-app-workspace` as the apply step for a planned route-owned
  app; the complete command owns contract, workspace, and topology composition.
- For a complete app, author the CUE schema from accepted product requirements;
  infer mechanical fields, relationships, indexes and technical defaults. Ask
  only when an unresolved role, ownership rule or destructive data change
  materially changes the product. A visual-only request does not authorize a
  backend build.
- Never publish without the separate publication approval. Connected Preview
  database and environment changes use `prepare-app-hosted-runtime` with a
  separate approval naming the selected project and exact branch; follow
  `docs/hosted-app-runtime.md`. A missing native Neon connection is a path
  blocker. Preview teardown uses separately approved `cleanup-app-hosted-runtime`
  with the same selected app, project and branch. Preserve recoverable resources
  across ordinary turn stops. Another runtime's shared branch Auth bindings
  block preparation; do not replace them.
  Keep credentials out of inputs and output. Never mutate `amp.yaml`,
  deploy, promote, alias, activate, or claim admission or Production readiness.
- If the complete command reports stale, conflicting, or ambiguous recovery
  state, reconcile it automatically when safe. Otherwise translate the visible
  product effect into one recommended product choice or an unavailable outcome
  with an alternative. Do not delete or overwrite user-modified state.
- Keep every public update product-facing. Never name internal specifications
  or acceptance, artifact recording, receipts, digests, workspace/source
  machinery, validation gates, protocol operations, or opaque validator and
  blocker copy. Translate unavoidable constraints into the smallest
  product-domain question with a recommended default, or offer a product-level
  alternative when no answer can make the requested outcome available.

For a new CUE-backed app, include `.config/app-specs/<id>.cue` in
`implementationFiles` with the reviewed schema contents. Apply stages this
convention input before creation and preserves the resulting app-owned CUE and
checked release. Do not request a backend through Markdown metadata.
