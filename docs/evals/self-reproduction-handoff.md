# Self-reproduction eval handoff

This handoff preserves the current self-reproduction baseline and defines the next acceptance run. It does not claim results for other evals and does not authorize manual candidate repair, evaluator feedback during generation, a better reroll, deployment, or publication.

The supported public commands and response schemas remain authoritative in [self-reproduction.md](self-reproduction.md). Separate cross-eval regression evidence is recorded in [cross-eval-regression-2026-09-14.md](cross-eval-regression-2026-09-14.md); do not infer those results from this candidate baseline.

## Latest baseline — 2026-09-15 UI recovery

The public session `wrun_01M2HDSVR946GBKNWQJP0CY1D8` used clean Builder revision `47ff6a01d1002235d032ac0abaed51ab272671ea` after main CI `34919959091` passed, with the normal development entrypoint supplied clean Arrusted revision `8b311f7dfee7a51215b16551ec13008ef43bd16b`. This supplied starter is not evidence that the generator independently cloned upstream. The fixed brief SHA-256 was `ccb356910ff02563f3f89333241de19b3da0d7b2c41592e320c40b4908daeb78`; the answer sheet was `20baed495f447bb4babc2092a61357921cf9a2e6d6802b225a60ff0ff498af4e`.

The result is a **failed replica with a reachable preview**, not successful self-reproduction. After two ordinary private build approvals and one ordinary “Please continue with the original app request.” response, the preview was verified at `2026-09-15T02:44:29.850Z` and the session returned waiting at cursor 94. No evaluator findings, internal tool instructions, candidate patches, manual installation, or manual startup were supplied. Observation reconnects remained in the same session. One incorrectly formatted approval was rejected before the corrected structured approval was accepted; this harness error is retained separately from product behavior.

Browser observation at all three desktop viewports found HTTP 200 and only the “Autograph App Builder” heading after settling, with no application controls. Visible authentication, brief/configuration, draft, creation, account, and documentation entry requirements failed. Runtime persistence, tenant isolation, provider callbacks, cancellation/retry/session recovery, independent child creation, and framework navigation behavior could not be exercised. Absent requested functionality is not converted into a pass by those unassessed runtime checks. Anonymous entry remains excluded.

The final assistant explicitly acknowledged that durable authentication, tenant persistence, provider OAuth, recovery orchestration, and child-app generation remained unfinished. Retained historical source readbacks show a heading-only page and an MCP skeleton with process-local state and no child generation. These are bounded source observations, not a complete final filesystem export or proof about every authentication boundary.

Two normal preview starts returned HTTP 502. The retained Arrusted wrapper source proves that dev/start discard forwarded CLI arguments, including the requested port. The actual listener port was not retained, so a specific observed port mismatch remains an inference. Normal agent recovery used direct Next with the requested port and delivered the preview without subsequent source writes. The shared wrapper repair merged in Arrusted PR #1392 as `73734b82a5f5e9cc9f1c9426183cc30fac071c61` after exact-head checks passed at `a6968f117b62a1f392c19522f3d055965e6ea5fb`; post-merge main CI remains pending. Its 13 focused tests include the actual installed Next 16.3.4 CLI parser, verifying explicit port and hostname options override defaults. Gateway access success alone does not prove upstream application readiness.

The repeated “Build this app?” request appeared about 10.55 seconds after the first accepted approval, with effectively identical scope and no explanation. This is an observed usability gap; its internal cause is not yet established. The implementation/completion gap remains P0: technical checks and a reachable heading do not satisfy the accepted product brief. Canonical action receipts show one apply, one technical validation (two commands), three preview attempts, and no `accept_change_set` invocation. Validation reported product acceptance unassessed with no behavioral evidence while retaining the full requested walkthrough. The existing independent source assessment is reached through `accept_change_set`; actual Astra review is therefore unverified in this attempt. There is no evidence that a reviewer omitted the original brief or that the generator ignored reviewer findings. The follow-up shared repair runs the existing independent source assessment automatically after fresh or reused successful technical validation. Explicit review reuses the same evidence cache; source or requirement changes invalidate it. Technical success, source findings, and runtime product evidence remain separate. Sixteen focused tests plus lint, formatting, and type checking passed locally; exact-head CI and a future unassisted baseline remain required. This fixes shared automation rather than instructing the evaluator to call internal stages.

Local diagnostic evidence is retained under `/private/tmp/self-reproduction-ui-recovery-20260915`, including public transcripts, exact responses, `candidate-browser`, and `post-session-diagnosis`. Private URLs and raw owner state must not be checked in. The portable sanitized report remains separate from source. Reporting-only PR #461 subsequently merged as `93f65f303a5c84034bd4dd178e0c0896e535891a`; main CI `34920771252` passed. That reporting revision did not change the pinned baseline checkout.

## Historical baseline — 2026-09-14 04:11 UTC

- Product brief generation used the normal public entrypoint at source revision `04dbe04823b95c975d5483b635c8d8ed44010908`.
- Public session: `wrun_01M2F1SPPJ8ND6ZK7K7Z0FTBZY`.
- Session start: `2026-09-14T04:11:25.865Z`.
- Private working-preview verification: `2026-09-14T04:27:39.014Z`.
- Post-run known-path source retrieval: `2026-09-14T05:27:50.850Z` to `2026-09-14T05:28:06.507Z`.
- The frozen result remains a failed replica: the preview was reachable, but all three candidate captures showed only the title and no usable app-entry workflow.

The resumed source retrieval read 33 known paths, found 6 missing, and encountered 0 blocked reads. The retained `app/page.tsx` renders only the title. Retained `app/actions.ts` stores drafts in a process-local `Map` and returns status objects for creation, cancellation, retry, and recovery. Retained `scripts/test.mjs` prints seven success marks from a loop without assertions or app operations. These exact files confirm failures for the visible workflow, restart durability, independent child orchestration, and meaningful behavioral validation.

The retrieval resumed an existing stopped Sandbox after generation. It was a fixed known-path inventory, not a complete filesystem export, an observation of the original active runtime, a new app launch, or a new browser test. It does not assess global authentication, tenant isolation, restart behavior, full framework behavior, or files outside the inventory. Local evidence under `/private/tmp/self-reproduction-public-ws-20260914` is machine-local diagnostic material and must not be treated as portable evidence. Owner-only preview authority, private URLs, credentials, and private transcript content must stay out of checked-in reports.

## Landed shared repairs

PR #440 merged as `64b09286663a348f73c42e7e9a88b39eeae1a196`:

- preserves approved implementation files across partial apply retries;
- permits repair writes after validation or review;
- adds verifier-owned JSON POST/GET readback evidence with explicit partial coverage;
- invalidates stale behavior evidence and preview eligibility before implementation writes; and
- translates authenticated Next HMR origin only on the internal HMR path while retaining public origin and authentication checks.

Its exact-head CI passed at `d06042978452f388bdac3ceaadd991ce418ee623`; post-merge main CI `34807550364` passed.

PR #441 merged as `32dddc257beb1cd2e10cc95ce020f4ef0f286cee` and marks validation pending before repair writes, preventing prior technical success from surviving a failed repair. Its exact-head CI passed at `6202121b5a690bda784a241f71915fecfcfc8cf0`; post-merge main CI `34808709258` passed.

These repairs are framework evidence, not proof of a successful self-reproduction. The later 21:03 UTC baseline below ran after they landed.

## Original gap inventory

This inventory describes the earlier baseline. The latest status and evidence below supersede its capture and setup gaps; product failures remain open.

| Priority | Gap                            | Required evidence or repair                                                                                                                                                                                                                                                    |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0       | Complete usable replica        | A fresh public run must deliver the brief/configuration workflow, durable drafts, provider-return handling, creation progress, preview access, cancellation, retry, recovery, account settings, and documentation without evaluator implementation assistance.                 |
| P0       | Durable authenticated data     | Generated code must bind writes and reads to a synthetic authenticated tenant and survive reload and a controlled restart. A process-local Map cannot pass.                                                                                                                    |
| P0       | Independent child creation     | The replica must create one small independent child through its own backend and expose real progress, cancellation, retry, and recovery outcomes. Status-only stubs fail. Stop recursion after that child.                                                                     |
| P0       | Honest validation and recovery | Technical command success must not establish product completion. Retain real action/readback evidence and prove that a failed repair leaves validation pending.                                                                                                                |
| P1       | Complete final-source evidence | The supported delivery boundary must retain a complete final manifest or artifact with hashes. A known-path recovery is useful but cannot establish absence elsewhere.                                                                                                         |
| P1       | Private preview transport      | Verify the landed HMR fix through the normal authenticated preview. Record browser, console, page, script, and WebSocket outcomes without exposing launch authority.                                                                                                           |
| P1       | Paired functional comparison   | Exercise equivalent synthetic users, data, settings, and states in reference and candidate for authentication, reload persistence, provider callback return, creation, preview, cancellation, retry, and recovery.                                                             |
| P1       | Paired visual comparison       | Capture matching desktop viewports and states, including resizing, keyboard use, loading, empty, and error states. Keep visual findings advisory and separate from functional status.                                                                                          |
| P1       | Next.js behavior assessment    | Inspect the complete final source and exercise server-first rendering, client boundaries, durable server writes, auth/cache isolation, Suspense, Cache Components, partial prefetching, navigation continuity, and pending/optimistic behavior. Flags alone receive no credit. |
| P2       | Portable evidence bundle       | Produce sanitized Markdown, JSON, and HTML plus screenshots, hashes, revisions, workflow outcomes, and coverage statuses outside candidate source, then retain an approved portable artifact rather than relying on `/private/tmp`.                                            |

Actual hosted publication and provisioning remain unassessed. Reference-app shortcomings must be listed separately when paired assessment occurs.

## Next acceptance run

1. Start from current green `main` and record its immutable revision, model/settings, bundled skills, product brief hash, answer-sheet hash, and public session ID.
2. Start the ordinary stack with `mise run dev`, then invoke the public Streamable HTTP MCP driver once with `mise run eval:self-reproduction -- --endpoint http://127.0.0.1:64613/mcp --output-dir /absolute/external/evidence/public-baseline`. Use a new external output directory, the checked-in brief, the normal App Builder workflow, real model, project-scoped OIDC, Vercel Sandbox, and allow-all networking. A reachable GitHub acceptance endpoint may replace the local endpoint.
3. Answer product questions only from the fixed answer sheet and record each response. Resume structured approval/question cards with `--resume --responses-file /absolute/external/evidence/product-responses.json`; use the documented structured responses such as `{ "kind": "approve" }`. Resume an ordinary chat question with `--resume --message-file /absolute/external/evidence/recovery-reply.txt`. Allow ordinary model self-correction. Do not provide evaluator findings, patch candidate files, redirect the candidate to the reference source, or select a reroll.
4. Use ordinary private approval cards for requested build effects. Do not approve publication or live provider effects; use supported emulators for callback and publication scenarios.
5. Preserve partial evidence immediately: prompt, sanitized public transcript, model settings, timings, usage if available, source revisions, validation transitions, and a complete final-source manifest/artifact. Never copy bearer URLs or credentials into reports.
6. Before the receipt expires, open the delivered existing working preview with `mise run eval:self-reproduction-observe -- --state-file /absolute/external/evidence/public-baseline/state.json --output-dir /absolute/external/evidence/browser-observation`. This observation command must not install, host, repair, or launch the candidate; the App Builder product owns the candidate lifecycle. Capture matching desktop viewports and browser failures; use `--brief-file` only for the optional known brief-field assertion and only when its exact supported label and Continue control exist.
7. Exercise the required functional matrix with equivalent synthetic identities and data. Restart only through the supported product flow, then verify draft and session recovery. Test one independent child creation and stop recursion.
8. Observe whether the shared App Builder invokes its limited JSON action/readback verifier on its own for an exact accepted walkthrough outcome and current same-Sandbox preview. Do not direct internal tools or stages from the evaluator. If present, retain its `action-readback-only` result and keep authentication, browser behavior, restart durability, provider behavior, and overall product completion unassessed by that result.
9. Compare reference and candidate using passed, failed, blocked, or unassessed for each requirement. Missing candidate behavior is failed; unavailable infrastructure is blocked. Preserve incomplete results and keep visual scores advisory, without an aggregate pass threshold.
10. Publish no external effects. Review the sanitized evidence bundle, prioritize gaps by user impact and responsible layer, and keep confirmed causes separate from hypotheses.

The acceptance is informative when it can show exactly what ran and what did not. A reachable preview, a successful build command, or a model claim never substitutes for observed product behavior.

## Additional open eval gaps

The cross-eval milestone landed through PRs #444 and #446. All 39 deterministic cases (553 gates), all five real Sandbox cases (128 gates), and post-merge main CI at `8550300364b69621cc30649997ebf75edcca345b` passed. See [other eval follow-ups](other-eval-followups.md) for the frozen failures and their closure evidence. These results do not establish self-reproduction.

A new public baseline started at that main revision with brief SHA-256 `44d84f9a13978521acc1fccf99e5bc72614e274a3ac2e9f6d33d683ca4265c9d`. Its input omitted explicit MCP support; retain that as an input-coverage gap. The updated brief adds the five public MCP tools for future runs only. Never retroactively apply that requirement to the frozen prompt or replace the existing session with a better reroll. Current reference assessment must also use the server-owned shell/form composition, rather than inherit the historical whole-page-client finding. Account settings, onboarding, and MCP need explicit supplemental findings alongside the legacy parity matrix.

## Public baseline after cross-eval repairs — 2026-09-14 21:03 UTC

The single public session `wrun_01M2GVQHMMAS77Z3VGKXD9CVCN` ran against immutable main `8550300364b69621cc30649997ebf75edcca345b`, with clean Arrusted `f992cee2f301c57fe3289a26f26e36b15b683d2f`. It used the frozen brief hash above, normal model settings, one ordinary build approval, and two ordinary continuation messages. No evaluator findings or implementation instructions entered the generation. The Builder recovered its own preview and delivered it at 21:26:42 UTC.

This is an improvement over the earlier title-only output, but **still a failed independent replica**:

- Browser interaction confirms brief entry, proposal review, approval, and visible creation states. The exact brief survives a same-browser reload; a fresh browser context starts empty. That does not prove authenticated server persistence.
- Generated `app/page.tsx` is a whole-page client component. It stores drafts in localStorage, replaces sign-in with a notice, and renders an inert account label. Provider connections directly update component state.
- Creation advances a counter through a manual “Advance generation” button. `app/child-preview/page.tsx` is a fixed page rather than an independently generated app. These are functional failures, not infrastructure blockers.
- Generated CSS defines a replacement palette instead of preserving the instructed Arrusted semantic tokens. Three desktop captures render the entry page but report Next instant-validation errors and failed resources. WebSocket creation alone earns no transport-health credit.
- The original development command failed because the shared Arrusted launcher resolved Next from app-local node_modules for development, although validation resolved it from the repository root. The Builder recovered with a different command and corrected the landing path. Shared launcher repair remains separate; the frozen candidate is untouched.

Read-only observation retained a stable, complete manifest within the explicitly selected `apps/autograph-app-builder` subtree (40 entries, two observations, completed 21:30:45 UTC). This is not a whole-repository completeness claim. The separate full-repository observation completed at 22:05:04 UTC: 3,020 entries, 2,475 regular files, no unreadable files, and two matching observations within documented exclusions. All regular file hashes were verified again during owner-only archival. This establishes capture coverage, not semantic correctness or an atomic snapshot. The later limited reference comparison below does not establish full paired coverage. Authentication isolation, actual provider callbacks, server restart durability, independent child execution, and framework navigation behavior receive no success credit from the simulated UI.

Local diagnostic directories are `/private/tmp/self-reproduction-live-main-20260914`, its `-preview`, `-functional`, `-app-source`, and `-source` siblings. Private state and source bytes must not be published. Browser evidence, source findings, and sanitized recovery diagnostics must be retained in the portable report before calling the comparison complete. Observer PR #448 merged as `81601ac2b6c4fe7603551b8b96ea4e9624f68295` with passing main CI. Full paired workflows and a fresh post-repair run remain outstanding.

## Shared repair acceptance — 2026-09-14 22:27 UTC

The ordinary `mise run dev` entrypoint now has an explicit synthetic web mode,
using the existing emulated authentication/provider preparation, independent
local dependencies, external runtime state, trusted localhost TLS, and the local
Eve adapter with project OIDC. See [local development lifecycle](../local-development-lifecycle.md).
This is shared development setup, not eval-specific hosting or a generation driver.

At shared setup revision `97690943`, against Arrusted `c3ff29dad22e80c0f7f9a429b04d33b2ca4a858f`,
ordinary emulated GitHub signup, authenticated workspace rendering, and account
navigation passed in a browser with strict TLS and no captured page or HTTP errors. The normal
auth endpoint returned HTTP 200. No session or database state was injected.
Passkeys remained unassessed because the optional feature flag was disabled.
Two observer attempts are retained: one incorrectly assumed that flag was enabled;
the other used an exact button name that omitted the accessible icon label.
The third used the actual visible GitHub control. These were observation retries,
not generation rerolls. Evidence: `/private/tmp/shared-reference-web-acceptance-20260914-attempt3`.

This closes the local reference-authentication configuration blocker for the repaired
setup. It does not retroactively complete the frozen baseline comparison: the
reference revision changed, and equivalent candidate states still need paired
observation. Draft durability, tenant isolation, provider connections, independent
child creation, cancellation/recovery, and instant-navigation behavior remain
separate runtime requirements.

Shared product review now retains the original request through normal session
events and independently examines implemented source during change-set acceptance.
Cited contradictions return to the normal repair loop; compiler success does not
mean product success. Missing original requests in legacy sessions, unavailable
review, omitted dependencies, and changed source remain explicit. Source review
never awards a runtime pass. A separate live invocation of the shared source judge against the preserved
candidate completed with seven mechanically cited contradictions (10,183 input
and 5,582 output tokens). Evidence: `/private/tmp/source-judge-baseline-acceptance`.
This proves the judge invocation and cited findings, not integration through a
normal `accept_change_set` turn or repaired product behavior. The raw judge also
mentions anonymous entry from the frozen brief; that subclaim remains excluded
from the current repair scope. Normal end-to-end repair-loop acceptance is still
outstanding.

Arrusted launcher PR #1379 merged as `c3ff29da`. Its exact PR checks passed; the
first main run failed because main advanced during template readiness. PR #1382
repairs that race by fetching the explicitly requested revision. Its Preview
currently has a separate `lookup_migration_forward_only` database-state blocker
for `business_unit`; do not bypass the guard or modify data to turn it green.
Retain both issues separately and merge only after the final revision is green.

## Landed repair and current coverage — 2026-09-14 23:15 UTC

[PR #451](https://github.com/withAutograph/autograph-app-builder/pull/451)
merged as `440257e5b1004aee5b4942593852a35da04c5bce`. Its final revision
`206076624b2bcb2449fc12507aad7bcc5dd99705` passed all required checks in
[CI 34905012790](https://github.com/withAutograph/autograph-app-builder/actions/runs/34905012790).
[Post-merge CI 34905947175](https://github.com/withAutograph/autograph-app-builder/actions/runs/34905947175)
passed all eleven jobs, including exact-main package publication. The deterministic
inventory remained **39 cases / 553 gates**; authentication passed **80 tests**
on both the final PR revision and main, with no retry markers in the retained logs.
The five real Sandbox checks were not rerun for this PR; their earlier acceptance
remains separately recorded in the cross-eval ledger.

A limited retrospective comparison uses the exact synthetic brief at 1440×900:
“Create an authenticated stock exceptions workspace to assign owners and resolve
an exception with a note.” Reference revision `206076624` acknowledged its server
save and restored the brief after reload. Ordinary account and documentation
navigation also worked. Two fresh browser contexts then used normal emulated
GitHub login and restored the same brief for the same synthetic identity, without
new writes or injected session/database state. These observations establish bounded
reference persistence, not candidate persistence or process-restart durability.

The reference and candidate differ in revision and full-page height. The candidate
cannot establish an equivalent authenticated identity. The paired form captures
support advisory layout comparison only: they do not complete the functional
matrix. The reference screenshot contains a Next issue badge; a lack of captured
page/HTTP errors is not proof of a clean browser console.

The sanitized portable bundle is retained at
`/Volumes/Home/jasonmorganson/.config/codex/visualizations/2026/09/12/01a095af-7cdc-7171-b268-bfc3a087175b/self-reproduction-20260914/index.html`.
It includes Markdown, JSON, screenshots, hashes, source findings, usage coverage,
CI evidence, and comparison limitations. Raw source, capability URLs, identity
hashes, and continuation state remain private. Machine-local supporting evidence:
`/private/tmp/retrospective-reference-form-20260914` and
`/private/tmp/reference-fresh-context-persistence-20260914`.

| Priority | Current gap                                           | Next proof and boundary                                                                                                                                                                                                                    |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0       | Independent replica still failed                      | One new normal public session after shared repairs. Keep authentication, durable data, real child orchestration, provider return, cancellation/retry/recovery, account and docs requirements; exclude anonymous entry only.                |
| P0       | Normal source-review repair loop unassessed           | Retain ordinary structured product answers in shared session state, then observe actual review findings and subsequent implementation/review during the public run. Standalone judging and temporal adjacency alone do not prove the loop. |
| P1       | Preview observation can miss delivery                 | Capture each newly delivered receipt while polling the public session, without extra product calls or candidate setup. Preserve observer failures separately from session outcomes.                                                        |
| P1       | Full paired runtime and framework coverage unassessed | Match supported authenticated states, exercise remaining workflows and navigation behavior, and record missing candidate functionality as failed. Source and configuration flags cannot substitute for runtime proof.                      |
| P1       | Arrusted #1382 post-merge verification pending        | The normal Preview and required PR checks passed and the repair merged; see the setup milestone below. Main verification remains separate from replica quality proof.                                                                      |

The original candidate and evidence remain immutable. The next run must record
new revisions, brief and answer-sheet hashes, session identity, and normal replies.
A missing feature is a failure even when a browser cannot exercise it. An
infrastructure blocker or incomplete observation remains open, not success.

The future-run brief now explicitly excludes anonymous creation and anonymous-draft
carryover while retaining working sign-in, sign-up, authenticated creation, and
tenant isolation. This implements the requested scope exclusion and prevents the
shared source judge from treating it as a missing requirement. The frozen baseline
brief and its recorded hash are unchanged; record a new hash for the next run.

## Post-repair baseline: identity compatibility failure

PR #455 merged as `b2e25707dc0c724ebf283c088bba5ae5450ac7d1`. Main CI
`34910591756` passed 39 deterministic scenarios / 553 gates and 80 authentication
tests. These results do not establish autonomous self-reproduction.

A new public session, `wrun_01M2H5W1TRBC0BEX52C8WV66CB`, used that clean Builder
revision and brief SHA-256
`ccb356910ff02563f3f89333241de19b3da0d7b2c41592e320c40b4908daeb78`.
Authentication and MCP remained required; anonymous entry was excluded. The only
reply after the brief was “Please continue with the original app request.”
No build approval was reached and no implementation assistance was supplied.

The supported development stack used clean Arrusted
`c3ff29dad22e80c0f7f9a429b04d33b2ca4a858f` as its source input. Its canonical
source receipt identifies an existing-repository development snapshot, with
synthetic commit `e2fb36a399f2949ad630e17852704ebed2b9a445`; this is not an
upstream revision or evidence of fresh repository cloning. Preserve that
coverage distinction in future reports.

Three canonical planning results failed with “Target identity command returned
an invalid shape.” The bound Arrusted producer includes `prototypeCuePath`,
while Builder rejected fields beyond the eight it consumes. Raw command stdout
was not retained; the field-level diagnosis combines the bound source with a
focused reproduction. The shared consumer now projects the consumed fields,
ignores additive metadata, and still rejects incorrect app, workspace and
AppSpec identities before planning. The fixture follows the current producer.

This run failed to deliver the independent replica. Its visual comparison,
runtime workflows, source-review repair loop and child-app creation remain
unassessed. A prototype or accepted specification earns no implementation
credit. The compatibility repair requires fresh public acceptance after landing;
do not rewrite this failed baseline or treat integration checks as a reroll.
Sanitized machine-local evidence is under
`/private/tmp/self-reproduction-next-main-20260914/assessment` and
`post-session-diagnosis`; private continuation state remains owner-only.

## Landed identity and setup milestone — 2026-09-15

[Builder PR #458](https://github.com/withAutograph/autograph-app-builder/pull/458)
merged as `014e5e688e7c0d0fdb8b6320366d175059d7f767`.
[Main CI 34914189856](https://github.com/withAutograph/autograph-app-builder/actions/runs/34914189856)
is green. This lands the additive target-identity compatibility repair described
above; it does not replace the failed `b2e25707` public baseline.

[Arrusted PR #1382](https://github.com/withAutograph/arrusted-development/pull/1382)
passed all required checks in
[CI 34915283696](https://github.com/withAutograph/arrusted-development/actions/runs/34915283696)
and normal Vercel Preview at exact revision `a116fb65`. It merged as
`a24c87eb97bd138446ed425030c0522e0075206e` at `2026-09-15T01:03:39Z`.
Normal Preview deployment `dpl_5tr1BPxGRbEXv5jW7wDqTtKhJcvF` passed HC and Vendor
materialization: HC reports 9/10 steps and Vendor 11/12, with materialization
passed rather than a claim that every step was completed. The repair preserves
existing tenant data and the forward-only migration guard; no manual database
repair was performed. Arrusted post-merge [main CI 34915728778](https://github.com/withAutograph/arrusted-development/actions/runs/34915728778)
reports Kernel Workspace, Rust, and Kernel failures under investigation. Main is
not green; the setup milestone remains open despite successful PR and Preview
proof.

The portable historical replica report remains at
`/Volumes/Home/jasonmorganson/.config/codex/visualizations/2026/09/12/01a095af-7cdc-7171-b268-bfc3a087175b/self-reproduction-20260914/index.html`.
Keep its failed product behavior and evidence limits distinct from these shared
setup and integration results. No new full self-reproduction baseline is part of
this milestone. Independent replica delivery, durable authenticated data, child
orchestration, the normal source-review repair loop, and paired framework/runtime
coverage still need the separate public-entrypoint acceptance already described.

The subsequent five-case real Sandbox rerun passed **128/128 gates**: design17,
existing iteration40, identity/planning23, reviewed changes38, and toolchain10.
Each case completed in `/private/tmp/builder458-real-sandbox-evals.log`. This is
shared setup/compatibility evidence with a mocked model, not a new full baseline.
Its source declaration is retained separately from the merged Builder SHA; see
[the cross-eval follow-up](other-eval-followups.md#identity-compatibility-rerun--2026-09-15).

The five-case rerun used coordinator checkout
`06bc0df47989b759a5f81e178d3f32a1f7e854d3`. Toolchain assertions verify their
declared command-execution scope: raw diagnostics still reported
`toolchainReady: false`, pnpm unavailable, and legacy image/cache evidence
unconfigured or unverified. The 10 passing assertions do not make those
configuration diagnostics true or establish broader readiness.

Portable repair validation is retained at
`/Volumes/Home/jasonmorganson/.config/codex/visualizations/2026/09/12/01a095af-7cdc-7171-b268-bfc3a087175b/self-reproduction-20260914/next-baseline/repair-validation.json`.
The overall five-case runner exited0. Its toolchain checks establish available
executables and nonempty versions for bash, git, mise, Bun, and Node; optional
pnpm, cache, image, and legacy readiness diagnostics remain separate.

The post-merge failure was traced to a Vendor Rust test embedding the deleted
root `vercel.json` after the independent typed-configuration migration.
[Arrusted PR #1390](https://github.com/withAutograph/arrusted-development/pull/1390)
repairs that test integration while retaining callback-only routing coverage and
an explicit token-route negative test. Its required checks and post-merge main
verification remain the landing gate; the normal deployment and template-readiness
check at `a24c87eb` passed. This failure does not change the frozen replica verdict.

### Green-main baseline: UI revision recovery

The public baseline on `88aa9b53034bafe03d1ad948c87918114af25158`
(session `wrun_01M2HBJTVV5W4NNR67KZ22P5A5`) stopped before implementation after
one ordinary continuation. `record_ui_preview` returned the correct UI source
revision, but the model selected outer HTML and decisions-document revisions
for finalization. Those rejections were correct; no actual UI source change
was established. `artifact_workflow_status` omitted the current UI revision,
so its recovery response could not supply the value required by finalization.
The shared fix exposes `uiPreview.revision` separately from document revisions
and clarifies the tool guidance while retaining genuine stale-revision checks.
Focused regressions cover recovery and rejection; a new public acceptance run
is still required to establish end-to-end recovery. The frozen baseline remains
a failure, and this repair does not close downstream product-quality gaps.

Sanitized evidence: `/private/tmp/self-reproduction-green-main-20260915/post-session-diagnosis/ui-revision.json`
and the adjacent Markdown diagnosis. These observer artifacts were never supplied
to the generator.
