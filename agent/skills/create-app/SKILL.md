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
   it from the product brief, tell the user the inferred product name in one
   short sentence, and continue without confirmation. Mention the inferred id
   only when it helps the user identify the app or resolve a real collision.
   Derive an inferred id
   deterministically from the chosen name by lowercasing it, replacing each run
   of non-alphanumeric characters with one hyphen, and trimming hyphens. Ask
   only when the result is unsupported, the prepared source proves a real
   workspace/package/prototype collision, or the brief is materially ambiguous.
   When the user names an existing path as `apps/<app-id>`, preserve that exact
   final path segment as the app id for inspection and planning. Never rename,
   pluralize, or re-infer it.
   The selected adapter's builder-owned identity operation remains authoritative
   for target planning; never construct or guess a repository script path.

3. Select the source before any hosted sandbox inspection or preview. For a new
   private app explicitly requested in Production in a selected existing
   Arrusted repository, use `resolve_github_source` for that repository's
   default branch before planning. The verified repository is both the source
   and delivery destination. Use the same tool for an existing GitHub app
   revision, following the requested source selection. For other new apps,
   acquire the canonical starter through `source_status` with
   `sourceKind: "fresh-template"`. Carry a named publication repository into
   `prepare_github_draft_review` without replacing an occupied checkout. If an
   unbuilt starter plan already exists and the user requests direct Production,
   read the release subject using `release-app-production` with that named
   destination and the planned storage; let Builder verify the repository and
   retain the same app and plan. Then prepare a writable Builder workspace
   automatically. Source
   discovery and repository commands provide context for the build. Do not
   require separate inspection or source-acquisition
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
   When the brief requests provider data or an integrations management surface,
   follow [optional integrations](references/optional-integrations.md) for
   discovery, typed recipes, the repository installer and shared composition.
   When the brief requests an existing app revision from an agreed historical
   version while retaining current shared platform capabilities, select that
   baseline in this first `resolve_github_source` call, before reading any app
   source. Use `appBaseline: { appId, source: { kind: "merged-pr",
pullRequestNumber } }` for a named merged PR, or `{ kind: "commit", commitSha }`
   for an explicitly supplied full commit. The platform branch/open PR remains
   the ordinary source selection. Builder verifies and projects the app itself;
   never ask the evaluator to restore files or manually construct a baseline.
   Retry the saved selection after a preparation failure. Report the app source
   and actual platform base separately from newly authored changes; include
   receipt details in supporting context when useful. Retained later release archives are not initial implementation input;
   do not inspect them to copy a later revision. A baseline is provenance only,
   and grants no publication, deployment, or readiness authority.
   For an existing app in a hosted repository named as `owner/name`, use only
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
   from the id and current catalog. Accepted Markdown stays in the private
   durable artifact and external planning input, outside repository source.
   Successful new-app creation writes its product-document snapshot directly
   to `apps/<id>/.config/app-spec.md`. Existing-app iteration preserves that
   snapshot unless the approved app-owned changes explicitly update it.
   Preserve existing source Markdown and CUE; only
   `.config/app-specs/<id>.cue` selects CUE-backed generation. Markdown alone
   never requests a backend. Additional routes require a separately reviewed
   topology edit. For existing apps, supply exact app-owned changes
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
   concrete framework versions resolved by the accepted build plan and the scripts
   present in the prepared workspace. New-app plans resolve the latest stable
   compatible Next.js, React/React DOM, and React types once. Preserve that
   selection through retries; never guess versions from model knowledge.
   For a complete app, Builder owns the backend and persistence implementation
   as well as the UI. Follow [full app authoring](../../../docs/full-app-authoring.md), including
   its authenticated route, mounted receipt and fresh-process persistence requirements.
   Use the Arrusted CUE/PostgreSQL data boundary for owned durable data: derive
   the CUE model and policies from the accepted product decisions, compile the
   checked release, and implement the authenticated server reads and actions.
   For new CUE-backed Arrusted apps, build product features on the generator's
   protected request proxy, server-only data context, and Next release tracing.
   Put feature-specific reads and mutations in separate modules; do not author
   replacements for the scaffold's `proxy.ts`, `next.config.ts`,
   `app/data/protected-config.ts`, or `app/data/context.ts`.
   The user supplies product meaning, not schema source or backend code.
   When accepted access requirements name application roles, declare the CUE
   `authorization.roles` and matching model/operation/field/row `grants` in the
   app schema. Follow the selected repository's generated-data-operations
   contract. Use the compiler's canonical role IDs throughout app policy and
   runtime consumers; product labels are not PostgreSQL identifiers. Inspect
   `app:describe` after compiling: its checked release must expose the intended
   roles. AppSpec prose, a role literal in application code, or a fixture actor
   does not declare a schema grant. Repair missing compiled roles and grants
   through ordinary app implementation only when the accepted requirements
   actually name those roles, then regenerate the checked release.
   For each screen backed by generated data, use the smallest explicit, typed
   `select` on server-side reads. For example, a list showing a title can use
   `record.list({ select: ["id", "title"] as const })` through the authenticated
   app DAL. Match that projection, filters, and sort fields to the screen's
   intended role and row policy. Omitting `select` can request metadata or other
   fields the reader cannot access, even if the UI never shows them. Request a
   field such as `$version` only where the behavior needs it and the checked
   policy grants it. When exercising data behavior, use the actual page read
   under the intended app actor after a save, including the list or detail page
   after reload. Fix an overbroad read before considering a policy change.
   An authenticated app may intentionally have no business roles. Preserve its
   accepted authentication and access design, including an empty role list.
   If local setup rejects that list, treat it as a platform/local runtime setup
   issue for Builder to repair; do not ask the creator to define schema roles,
   add a default role, manually inject `APP_RUNTIME_ROLES`, or weaken access
   checks. Keep the command failed and affected behavior unassessed. Continue
   the existing normal delivery and source-validation flow without making
   optional local Preview an additional release gate or bypassing selected
   required checks.
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
   At persistence boundaries, inspect the selected repository's datetime codec
   and exact-replay contract. Keep server-issued timestamps consistent across
   writes, database readback, retained retries and pagination; preserve the
   contract's timezone and precision instead of assuming database wire text
   equals browser text or reducing microseconds through a JavaScript Date.
   Retain the original mutation intent and idempotency key for an exact retry;
   do not regenerate timestamps. Match cursor comparison to the actual query's
   ordering, null handling and unique tie-break. The generated runtime's
   documented offset pages are deterministic for a stable dataset, not snapshots
   across concurrent requests; do not invent a cursor or timestamp format.

   Separate a committed mutation from subsequent refresh or revalidation.
   A refresh failure after commit must report saved-but-not-refreshed state,
   preserve recovery context and offer a read retry, rather than claim the write
   was unsaved or submit a new mutation. An uncertain write requires the existing
   replay/readback contract before claiming success or failure. For these concrete
   defects, reuse focused behavior checks with actual database-returned timestamp
   values, equal sort keys across pages, and commit-success/refresh-failure paths;
   synthetic fixtures alone do not prove database interoperability.

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
   For an explicit direct Production request for an eligible private Arrusted app
   or presentation revision,
   read the `directProduction` subject with `release-app-production` and include
   it with those implementation files. This presents **Build and release to
   Production?**. For private preview, the card is **Build this app?**. Do not
   request approval for session work, source access, inspection, design,
   prototypes, internal drafting, or planning. Never invoke the target command
   through generic shell access.

7. **Build this app?** covers editing, validating, and running the
   implementation in the private App Builder checkout. **Build and release to
   Production?** also covers publishing the reviewed draft, managed Production
   setup, and marking Ready and merging after required checks.
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
8. For an explicitly protected Preview journey, when the user requests
   restoration of the currently published app and defers
   unpublished changes, recover the existing hosted Preview before continuing
   private candidate validation or review. Preserve the candidate and its
   diagnostics for later iteration. Use `plan-app-hosted-runtime` with
   `releaseIntent: "prepared-preview"` and normal effect approvals to select the
   exact frozen prepared release and its matching recorded publication. A newer
   private capture is not a validation or publication prerequisite for this work.
   For source-recording recovery when delivering changed source, omit that intent
   and inspect `inspect_github_draft_pr_reconciliation` with
   `kind: "publication-recovery"` and follow its returned recovery call. Retained
   metadata grants no authority; provider verification and equivalent
   selected-release checks still apply.
   Reuse approval only for the exact unchanged operation; changed plans require
   ordinary approval. Open the protected native route with `start_app_preview`
   before preparing private local data. Keep unavailable native delivery and
   unassessed authenticated behavior explicit. Resume the candidate's full
   validation, review and separate publication approval when delivering its
   changes; do not reset it or pin ongoing revision work to published source.
   For delivery of applied changes with approved optional integrations, run
   `install-app-integrations` against the executable app definition after apply
   and before validation. When an accepted revision explicitly defers integrations,
   remove the executable provider selection and reconcile it with that same
   operation; `status: "omitted"` proceeds with normal app/Auth delivery without
   connecting a provider or changing retained bindings/data. Follow the optional
   integration reference for app-owned UI conflicts and source-only removal.
   After apply and any requested integration installation
   succeed, show a private working preview by default. Start it with
   `start_app_preview` and share the returned route before optional browser checks.
   An approved direct Production release goes straight to required validation and
   review. Lint is advisory. Run it separately when explicitly requested.
   If the applied app is still a scaffold or its preview needs a repair, use
   `validate_app_creation` with `repairOnly: true` and the corrected
   `implementationFiles`. This writes under the original Build approval and
   returns before running repository checks. Then open the updated app with
   `start_app_preview`. Keep the existing proposal for these repairs.
   An unapplied same-app repair proposal can leave the workflow in `planned`
   while the previously approved implementation is still saved. When the user
   wants that implementation and preview or repair diagnostics identify this
   case, call `prepare_app_creation({ resumeApprovedBuild: true })` to return
   to its applied workspace. After `resumed_approved_build`, start the preview.
   For a concrete source fix within the original Build scope, resume that
   workspace first, then pass the corrected files to `validate_app_creation`
   with `repairOnly: true`. Builder retains the unapplied draft in repair
   history. When the user wants those changes, follow the ordinary planning
   and Build controls for the changed scope.
   For reviewed delivery, continue with `validate_app_creation`. It runs the
   selected repository's native build and declared tests against the current
   applied app. If a saved attempt failed in the old lint checker, keep that
   diagnostic and use the current delivery validation in the same scope. When it
   reports a repairable failure, provide corrected `implementationFiles` to
   `validate_app_creation` and retry in the same approved checkout. Use the
   returned diagnostics and status; do not invent extra validation capabilities
   or treat a pending attempt as passed. Successful commands establish
   technical validation, not product acceptance. Use `get_validation_log` with
   each returned cursor when a repair excerpt is truncated. Inspect the current
   changes with `change_set_status`; final acceptance below records their review.
   Review is neither publication nor proof of working user interactions.
   Leave `runBrowserTests` unset for ordinary delivery. Set it only when the
   app calls for its declared authenticated browser task.
   Reuse current executed behavioral evidence for the scenarios it actually
   covers; run additional scenarios only for missing coverage or changed behavior.
   A new tool invocation or business phase alone is not a reason to repeat an
   independent model judgment or an already covered browser test.
   After the ordinary build succeeds, inspect `change_set_status` and use
   `accept_change_set` to record the reviewed source. Leave `runSourceReview`
   unset for ordinary delivery. An independent assessment is optional and may
   be requested explicitly when it serves the app's needs. Report any
   assessment and its findings as advisory evidence.
   For requested GitHub delivery, save that technically validated source through
   normal destination review and the approved native draft-publication operation
   before optional private browser qualification. Direct Production continues
   without waiting for a preview or optional browser result. A failed or unavailable browser
   check stays failed or unverified and does not turn passing repository commands
   into a failure or prevent draft review. A draft is reviewable work, not a usable
   app, Ready, merge or deployment. Keep repairing accepted behavior.
   If the retained starter checkout lacks an identified shared tooling repair now
   present in the destination repository, publish the ordinary reviewed repair
   draft, then use that open draft's normal reconciliation and candidate validation
   to adopt the current base and rerun the affected browser tests. Preserve the
   original private work and app resources; do not replace source or hot-patch
   shared files. Builder handles this continuation without outside stage instructions.
   Repair cited product contradictions through `validate_app_creation` with
   corrected implementation files, then accept the repaired change set again.
   Read cited findings through `change_set_status` with `view: "acceptance"`,
   `detailSection: "source-assessment"`, and both existing review/source bindings.
   Follow each returned `nextCall` and join its content until complete. A long
   walkthrough or truncated tool history is not a reason to discard the finding
   or start another paid review; the saved assessment remains readable.
   A review interruption alone does not require another technical validation.
   For requested hosted delivery of changed generated-app source, technical
   validation and source review precede publication of the source needed to
   deploy the app. Keep hosted
   behavior unassessed while completing that publication; exercise the pending
   hosted checks after delivery instead of waiting for a Preview before reviewing
   and publishing its source.
   An unavailable or clean source review never proves runtime
   success. Keep incomplete previews inspectable and report remaining checks;
   do not replace a requested backend outcome with a simulated transition.
   Use the saved Builder destination for delivery. If a new app has no
   destination, send the user to the destination setup link returned by
   `prepare_github_draft_review`, then continue the same saved build. If the user
   explicitly chose an existing repository, carry that repository into the
   review and use its ordinary GitHub connection flow if access is missing.
   Show the resolved repository during review.
   Before initial draft publication, run `prepare_github_draft_review` to bind the
   actual destination snapshot. If a saved new app acquired the delivery
   repository as its source, use the same preparation in the saved session.
   Builder verifies the app was absent from the exact acquired source and is
   still absent from the current destination. It includes the complete app and
   the repository-produced registration in that first review. Keep the saved
   app, source and destination together through review and approval.
   Inspect its before/after content as needed with
   `change_set_status`, `view: "next-page"`, and the selected `contentSide`.
   Each call uses the current session's saved cursor; `view: "read-progress"`
   reports optional inspection progress and continuation calls. Complete-side
   coverage is not an acceptance or publication prerequisite. Then call
   `accept_change_set` and seal the proposal. Pass its returned `approvalReceipt`
   unchanged with the proposal digest to `publish_github_draft_pr`; that invocation
   presents the ordinary approval control and waits before any GitHub write.
   The receipt is the reviewed subject, not user consent. Do not wait for a separate
   approval-request tool or ask the user to create a receipt.
   Preserve the actual destination, source-content and approval protections.
   After initial publication, use `read_github_pr_delivery` when reporting the
   current pull request, required checks, or merge. Explain draft deferral as
   checks starting when the pull request is ready for review. Keep the observed
   GitHub result separate from authenticated hosted verification.
   If the user requests a merge and that tool returns an approval input, pass
   it unchanged to `finish-github-pr-delivery`. Present the exact Ready and
   merge effects through the native approval. A changed revision requires
   review and approval of the new candidate. An unresolved effect needs
   readback of the same pull request before any further action.
   When revising an existing draft pull request, first use
   `prepare_github_draft_pr_reconciliation` to inspect its live base and head
   commits and prepare the private merge candidate. This step determines actual
   conflicts even when GitHub's mergeability status is stale. Resolve
   only reported conflicts under the selected app: read each file with
   `inspect_github_draft_pr_reconciliation`, then write its complete resolved
   content with `resolve_github_draft_pr_conflict`. Report a platform-owned conflict
   with its path and leave it for its owner. If a repair requires one app-owned
   file exactly as retained in the draft head, use
   `edit_github_draft_pr_candidate` with `kind: "restore"` and that file's `path`.
   This restores its exact bytes and mode, including binary and executable files,
   while preserving other repairs. Do not retype historical bytes or supply an
   alternate revision. Restore invalidates saved validation and review; validate
   the complete candidate and review both diffs again. Run the selected app's
   schema preparation, native build, and declared tests on the reconciled
   candidate with `validate_github_draft_pr_reconciliation`. Request browser
   tests and additional checks for the specific changes they cover. Keep
   explicitly requested lint separate and advisory.
   If the frozen Bun install returns an exact composition repair `nextCall`,
   use that call for the same PR. Builder verifies its own original first
   publication and rebuilds shared composition from the current base plus the
   selected app. Do not guess a dependency to normalize or ask the creator
   for repository paths. Validate and review the repaired candidate before
   its normal exact update approval.
   If an existing app dependency needs shared Bun catalog alignment, use
   `normalize_github_draft_pr_dependency_catalog` with its package name. It operates
   on this candidate, preserves the existing concrete version, normalizes its
   declared workspace consumers, and generates lock metadata with pinned Bun and
   install scripts disabled. Inspect its exact metadata paths and command outcome;
   a lock failure is not success. Retain the candidate and retry the same operation
   after resolving the actual failure. Do not hand-edit shared files, guess a
   version, or misuse framework upgrades. Complete normal current-source validation
   including `check:package-manifests`, then review all changed metadata before
   publication approval. Additional check failures have durable, session-scoped
   `additional-check` logs discoverable through `get_validation_log`; missing
   excerpts are not a reason to rerun app tests or invent another readiness gate.
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
   `review_github_draft_pr_reconciliation` to record the exact validated
   candidate and two-parent metadata review. Its bounded summary reports honest
   full counts and all repository head metadata. An assessment retained through
   `accept_change_set` covers the earlier applied source, not this reconciled
   candidate. Do not rerun it to obtain a candidate assessment or repeat paid
   review against that earlier source. If an independent assessment of the exact
   candidate is unavailable, report that honestly without calling it clean and
   continue normal publication from the deterministic candidate review. No extra
   review or human Continue reply is required. Preserve requested app-authored
   behavior checks; unavailable hosted behavior remains unverified until delivery.
   Use `inspect_github_draft_pr_reconciliation` only when
   additional inspection is useful: `kind: "changes"` pages the file index;
   `kind: "diff"` supports raw byte cursors and path selection for the final
   diff against the current base or the delta from the old PR head. Neither
   pagination must be exhausted before sealing. Seal the validated, reviewed
   result with `seal_github_draft_pr_reconciliation`. Pass its returned
   `approvalReceipt` verbatim to `reconcile_github_draft_pr`; the
   receipt names the existing PR branch head, not the PR's base branch. Ask
   for a separate update approval before moving the branch. If the
   base or PR head moves, prepare, validate, and review the new result again.
9. For published-version restoration, use `start_app_preview` to open the
   protected native app route first; its existing hosted runtime supplies data.
   Use the implemented app's private preview with `start_app_preview` for
   requested local delivery or uncovered behavioral checks. For requested
   hosted delivery of changed source, publish technically validated and reviewed
   source through the
   existing publication approval flow without waiting for successful private UI
   startup.
   For a normal release into an existing repository with native Production
   delivery, continue through the approved PR merge flow once the repository's
   required checks pass. Native Git delivery owns deployment. Treat optional
   app tests and private Preview as iteration tools. Use the app's own tasks
   for any behavior checks that its requirements call for. Report actual build
   or deployment failures and the provider's observed delivery result.
   If the app needs managed storage or Auth, use its supported owner-scoped
   setup and resume any saved operation. Keep provider details inside Builder.
   Run the hosted Preview setup only when the user asks for a hosted Preview.
   For private local preview or candidate checks, if the repository defines
   `app:local` for the selected app and needs local data, use
   `prepare-app-local-preview` first in the approved sandbox.
   Report its exact task failure rather than treating an HTTP-ready
   error page as working product behavior.
   Use the default `start_app_preview` call for a planned Arrusted app. It
   selects the repository's development script, app workspace, port and
   registered route. When a custom repository needs an explicit command,
   pass its actual executable and argument array without shell wrappers.
   Repair actual startup diagnostics
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

   Builder chooses synthetic verification actors and their tenant/role fixture
   topology from accepted permissions and required coverage. Do not ask the user
   to map test actors, labels, memberships or roles. Derive the profiles needed
   for allowed and denied actions, tenant isolation, self-action denial,
   revocation, concurrency and history when those behaviors apply. An empty
   app-role set means no app assignment. Actor labels and counts are fixture
   choices, not product quotas. Preserve the real owner's existing tenant and
   membership. Creating real accounts, granting access or provisioning resources
   still requires the specific effect review. Questions about real people,
   product role meaning or tenant business rules remain material product choices.
   Synthetic unit fixtures do not prove real hosted authentication or access:
   when an accepted walkthrough requires actual hosted actors, exercise them
   through the authorized hosted path and report their independent readbacks.

   When the app needs new Production runtime bindings and validation returns
   `productionHandoff`, follow
   [Production handoff](../../../docs/production-readiness-handoff.md) for
   reviewed Auth identity, explicit QA access and runtime binding delivery.
   Include its declared app route, roles, and blockers in the result. Keep the
   checked release and operator-guide references in supporting context when
   useful. Keep the handoff
   separate from private validation and GitHub checks: a protected operator
   owns tenant preparation, access grants, and hosted activation. Missing
   Production metadata is not a private build failure. Preserve the selected
   app's authentication requirements; do not reintroduce a retired local-demo
   bypass to obtain a passing walkthrough.

   Deliver the actual private preview with a concise account of what works,
   what was checked, and any remaining incomplete or unverified outcomes.
   When the brief includes deployment or submission, carry that requested delivery
   through supported capabilities and effect approvals; report operator handoff
   work or unavailable capabilities precisely. A private preview alone does not
   complete a requested hosted outcome. Publication is optional when the brief
   does not request it, and separately authorized; do not make an unsolicited
   repository or pull-request offer a required completion step. The configured output
   directory is a publication destination, so an empty destination does not
   mean the private implementation is missing. If the user requests publication,
   use the current Production approval for that app and destination. Otherwise
   present the ordinary effect approval. Keep internal execution mechanics and
   approval identifiers out of the public conversation.

## Production delivery

For a new private app explicitly requested in Arrusted Production, call
`release-app-production` to read the exact release subject. A plan acquired
from Arrusted's default branch already binds the verified destination. The tool
can read it from the plan or accept the same repository name again. For an
existing starter plan, supply the named Arrusted destination and keep the
starter source. Request `storageKind: "postgres"` if the new implementation
submits a CUE schema. Pass the subject unchanged with the complete
`implementationFiles` to `apply_app_creation` for the combined approval.
For an explicitly requested Production update to this session's already live
private Arrusted app, prepare the presentation revision and call
`release-app-production` before Build. Use the returned revision subject and
empty `implementationFiles` with `apply_app_creation`. After publication,
`finish-github-pr-delivery` verifies existing data and access before Ready and
merge. Use the same app and destination for the native activation observation.
If the user asks to release after private Build, use that subject with
`release-app-production` to show one release approval. Follow the exact sealed
publication, protected setup and reviewed merge continuations under that approval.
For an existing repository with native deployment, use its reviewed PR delivery. After the approved merge,
`finish-github-pr-delivery` follows the managed destination's provider-owned
activation. Share the observed public app URL when available and state what
that observation establishes. A live app may already be available while delivery
of the newly merged revision remains unconfirmed. Use `observe-app-production`
to check the same saved app again after a service interruption or return to the
session. A separate Preview,
synthetic storage, private browser run, or managed public-release plan is not a
step in this route. If the app actually needs new runtime bindings, use the
repository's protected Production setup for those bindings and keep the same
destination and app identity.

### Builder-created deployment destinations

Use the managed public-release capability for an owned Builder-created
repository and project. App sign-in uses the application's Auth at its public
domain. Keep the resource preparation and release in that same project.

- Keep the accepted app and saved session. Use its normal owned provisioned
  destination. If setup reports `builder_destination_required`, direct the user
  to the returned normal Store In / Deploy To destination control and continue
  that session. Builder owns reservation, attachment, creation and independent
  project readback. Do not invent a handoff, adopt a project by name, or copy an
  old approval to a different destination.
- Keep Gateway, Auth and the app in that same repository-root Services project.
  The privileged operator is separate infrastructure. Preserve the normal
  `apps-<app-id>` naming and recorded project for later revisions.
- Finish technical validation, source review and the ordinary separately
  approved publication path. Record its actual reviewed source association.
  A draft PR or local source change is not public delivery. Use the shared
  runtime setup tools for the selected isolated resources and compiled release.
  A fresh Preview resource-installation plan may prepare schema and Auth in
  this same project; it does not require visiting a Vercel-protected Preview or
  create another delivery destination.
- Use `plan-app-public-release` and the separate exact-plan approval from
  `release-app-public-release`. An Auth-bootstrap plan first makes the normal
  public Auth entry point available. It does not prove app schema readiness,
  login or application behavior. Follow its ordinary signup and identity
  continuation in this same Builder session. Then finish the app's restricted
  schema and assignment setup and request a fresh application-release plan.
  Bootstrap consent is not consent for that later plan.
- Public release uses Standard Protection and a public production domain, with
  Better Auth enforcing user sessions, organizations and app assignments.
  Public delivery may use explicitly isolated development provider resources;
  it does not grant customer Production provider access. Never weaken operator
  protection, insert base/admin credentials, manually deploy, promote or alias,
  or select a deployment by a source SHA or Git history.
- If the release reports pending, use `observe-app-public-release` with the
  same frozen plan to continue reading the native deployment. Preserve the
  operation and its approval while the provider is still working. When ready,
  report the app's ordinary public URL and the observed deployment result.
  App-owned behavior and integration checks can run when the app calls for
  them. They are separate from the normal release result.
- Preserve old protected Preview intents and history. Changed targets and
  exposure require new supported plans and ordinary approvals. Unknown effects
  stay visible and are reconciled through the saved operation; never resend an
  uncertain public response or start a replacement app to hide the outcome.

When developing Builder itself, use the local Builder and parallel isolated
instances described in `docs/local-development-lifecycle.md`. Fix shared
mechanics, then continue the saved work. Do not finish generated app files or
force private stages on the evaluator's behalf. Local runs remain local proof;
hosted acceptance still requires the app's actual public delivery and provider
behavior.

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
- Publish only with the current release or publication approval. Connected Preview
  database and environment changes use `prepare-app-hosted-runtime` with a
  separate approval naming the selected project and exact branch; follow
  `docs/hosted-app-runtime.md`. A missing native Neon connection is a path
  blocker. Preview teardown uses separately approved `cleanup-app-hosted-runtime`
  with the same selected app, project and branch. Preserve recoverable resources
  across ordinary turn stops. Another runtime's shared branch Auth bindings
  block preparation; do not replace them.
  A current `pending` status means the approved work is unfinished. Reading
  status does not execute work or prove that a worker is running. Treat a prior
  failed attempt as historical evidence, not a current refusal. After an
  ordinary factual reply that the prerequisite was repaired, continue the same
  original session and accepted participant program through the existing
  preparation, reconciliation or planning path. Retry an unchanged preparation
  with its retained approval; resolve a changed plan, including changed worker
  inputs, through the existing planner and required approval before execution.
  Report confirmed completion of the same operation under verified human
  approval even if an earlier request said proposal-only; that earlier wording
  does not undo the later approval or require repeat approval. Approval must
  come from the authenticated durable approval outcome, never assistant
  narration, a client acknowledgement or tool arguments. New or changed effects
  require their own exact approval.
  An `auth-bootstrap` plan intentionally prepares Auth and Gateway before
  account capture. Continue the returned prerequisite through
  `prepare-app-hosted-runtime` with approval for its exact effects. Follow its
  ordinary account connection link for the existing account and resume that
  same approved preparation to read back capture. Then plan again for the same
  app/session and release intent; the renewed full app plan supplies app
  installation, access, delivery and routing through their normal approval
  flow. Do not stop because the first plan contains only bootstrap effects or
  require an app deployment before initial account connection. Reconcile unknown
  outcomes before retrying; account capture alone does not prove app readiness.
  A current authority, credential, isolation or provider refusal remains a
  blocker; never treat that fresh refusal as stale or infer readiness from a
  repair report.
  Keep credentials out of inputs and output. Never mutate `amp.yaml`,
  deploy, promote, alias, activate, or claim admission or Production readiness.
- For protected hosted signup, carry accepted signup eligibility, the exact
  organization, and initial membership and app roles in the approved app-scoped
  policy. The protected installer persists it for the selected Auth resource,
  app and verified native public origin before signup is offered. Do not treat
  ordinary signup as owner delegation or grant access to every app. Existing
  eligible accounts must be enrolled idempotently through the same server-owned
  policy. Continue the same approved operation only after server readback proves
  the signed-in user, organization membership, app roles and usable app route.
  For this signup-policy/readiness surface, report only safe
  `waiting_for_signup`, `ready` or `blocked` status and the public app URL.
  These statuses do not replace intermediate operator outcomes. Never ask users
  to confirm an Auth connection in Builder or expose passwords, cookies or
  private proof.
- For a requested private data export, use the explicitly selected `customerId`
  or `customerScope: "owner-organization"` when the user chooses their original
  owner organization. The protected planner resolves the latter from approved
  owner identity into a currently approved installed tenant. Never substitute a
  QA organization or guess an ID; if selection remains ambiguous, ask for the
  organization's product name. The concrete export plan still needs its separate
  extraction approval before any data is exported.
- When accepted requirements need several authenticated participants, derive
  `normalActorProgram` for `plan-app-hosted-runtime` from those accounts,
  organizations, memberships and app roles. Use the verified native public
  origin and preserve the program and original public session through approved
  preparation and recovery. It describes required product participants and does
  not restrict ordinary signup to a test roster when the approved policy allows
  normal users. Never ask the evaluator to insert fixture users, repair grants
  or drive private stages. Read `docs/hosted-app-runtime.md` for the app-scoped
  enrollment contract. Do not invent actor quotas, source-layout assertions or
  regular-app-change gates. Keep passwords and session state out of tool inputs
  and conversation.
  Report the returned current stage and confirmed effects separately from the
  program's future intent. `auth-schema-prepared` confirms only the reported
  Auth/bootstrap facts; the status alone does not prove Gateway readiness.
  `participants-prepared` confirms accounts and private sessions only, not
  organization creation, memberships, app access or business test writes, even
  when the program describes those later effects. `prepared` still requires
  actual signed-in behavior evidence before claiming app readiness. Preserve
  pending, unknown and blocked outcomes; a journal lease is not execution proof.
  For authenticated `test-e2e`, use the target repository's shared normal-actor
  fixture when exposed at `@autograph/playwright-config/normal-actors`. Select by
  `actorKey` and `organizationId`, preserve no-assignment actors, and exercise
  every accepted actor/organization journey. Its context uses the prepared
  `APP_TEST_BASE_URL` and unchanged private session files. Improve missing shared
  support through the repository workflow; never ask the evaluator to copy
  cookies or repair the app. Keep assertions about product behavior and access,
  without exact internal call counts, opaque IDs or incidental DOM positions.
- For requested protected hosted generated-app delivery, finish technical
  validation and independent source review, then use the existing destination
  diff review, `accept_change_set`, and `seal_github_draft_pr_proposal` workflow.
  Invoke `publish_github_draft_pr` with the sealed proposal's returned
  `approvalReceipt`. Eve uses the current scoped Production release approval
  when eligible and otherwise waits for the ordinary publication decision. Existing drafts use their approved
  update/reconciliation path. Do this before full app preparation and delivery.
  Initial Auth/resource bootstrap may happen first. Hosted behavior
  remains unassessed until the actual app is exercised; do not wait for that
  behavior before publishing the source needed for its Preview.
  After publishing or updating the reviewed draft PR, check `appSourceRecording`.
  `recorded` associates the actual published branch, commit and tree with this
  session's compiled release. Use that association for hosted Preview planning;
  never substitute the latest repository commit or manually supplied source IDs.
  If recording is `unavailable`, the GitHub publication already succeeded.
  Resume the same approved publication/update/reconciliation through its existing
  idempotent recovery to record the source before preparing that hosted Preview.
  Preserve the original session and reviewed release, report the recording blocker, and
  do not start another outward effect or claim hosted Preview source readiness.
  A `not-required` result means the static app does not require a compiled hosted
  release association. Source recording does not block static apps or local Preview.
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

## Upgrade an existing Next application

Follow [Builder-managed framework upgrades](../../../docs/framework-upgrades.md).

Treat a framework upgrade as an existing-app revision, never as creation or a
template overwrite. Inspect the current app's routes, Server Components,
request-scoped authentication, DAL, actions, cache invalidation, and tests.
Ordinary revisions retain their versions. When the user requests an upgrade,
pass `frameworkUpgrade: "latest"` to `accept_app_spec`. Version-only upgrades
may have no authored app file changes; navigation improvements include the
actual app-owned edits. New-app plans select current stable versions automatically.

When an existing Arrusted app has explicit Next.js, React/React DOM, or React
type pins in its own manifest, include the app-owned manifest migration to
`catalog:` in the planned changes, preserving unrelated dependencies and custom
configuration. A shared catalog change alone cannot upgrade an app that still
uses its own old pin. Use version-only upgrades with no authored app edits only
when its dependencies already follow the repository catalog.

The accepted plan retains concrete versions through apply, retries, and resume.
Use its version-matched installed Next docs and the published adoption skills.
Builder's repository adapter invokes the declared `repository:upgrade-framework`
operation; do not submit root manifests or hand-authored lockfiles as arbitrary
implementation files. In Arrusted, catalog and lock changes affect the workspace,
so include that scope in the same reviewed change set. Follow the existing build
approval and publication flow rather than asking for an additional upgrade approval.

Use `arrusted-next-app-like-experience` to modernize navigation while retaining
server reads and Server Actions. Preserve the app's identity, schema, product
behavior, and custom configuration. Verify direct loads, soft navigation and
Back/Forward; test cache reuse and successful-mutation invalidation where caching
is introduced. Use existing focused tests and report unexercised behavior. A
successful dependency installation alone does not prove a migrated app works.
