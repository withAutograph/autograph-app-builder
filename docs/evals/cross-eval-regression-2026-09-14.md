# Cross-eval regression assessment — 2026-09-14

The shared self-reproduction repairs preserved the existing deterministic CI coverage. This is not proof that every generated product improved, or that every checked-in eval ran.

## Verified revision and evidence

- Before repairs: `04dbe04823b95c975d5483b635c8d8ed44010908`.
- After PRs [440](https://github.com/withAutograph/autograph-app-builder/pull/440) and [441](https://github.com/withAutograph/autograph-app-builder/pull/441): `32dddc257beb1cd2e10cc95ce020f4ef0f286cee`.
- [Completed main CI run 34808709258](https://github.com/withAutograph/autograph-app-builder/actions/runs/34808709258): every job succeeded. Counts below come from job logs, not inferred from job names.
- Between those revisions, no `evals/` cases, `.config/mise/tasks/` mappings, or `.github/workflows/` definitions changed. Existing tests gained coverage; seven new test files cover staging, behavioral readback, and repair integration. No new skip or removed case was found in those changes.

## Executed coverage

| Lane                                | Result                                                                        | Scope and limit                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Repository unit suite               | 1,896 passed; 13 skipped across 281 files (280 passed, one skipped)           | Includes shared workflow repairs; skips are not success                         |
| Repository secondary suite          | 85 tests in 22 files passed                                                   | Storybook component suite                                                       |
| Repository browser                  | Two passed                                                                    | Existing deterministic browser cases                                            |
| Eve general                         | Six cases / 73 gates, plus one disabled-publication case / eight gates passed | Mock models, simulated target and publication; not live generation              |
| Product quality                     | 11 unit tests and two browser cases passed                                    | Curated fixtures; CI does not run the broader `test:product-evals` Eve scenario |
| Sandbox toolchain                   | 14 passed; 12 skipped                                                         | Backend contracts; not a hosted generation or fresh clone proof                 |
| Production navigation               | 11 browser cases passed                                                       | Reference-app behavior, not candidate behavior                                  |
| Authentication/provider E2E         | 79 passed                                                                     | Emulated external effects, real test database/browser flows                     |
| Package and Vercel deployment proof | Jobs passed                                                                   | Packaging/provider status proof; no generated-app correctness credit            |

There are 45 checked-in `.eval.ts` files. That inventory must not be reported as 45 executed or passing evaluations. Twelve retired template-backend tests and one opt-in live-model test remain skipped; these skips predate the repairs. The fresh-bootstrap suite has an entrypoint but no job in this CI run.

## Additional checks and repairs in this follow-up

`mise run test:product-evals` passed on the post-repair source: 11 unit tests, one Eve scenario with 12 gates, hard prototype/AppSpec/composition gates, and two browser cases. These use a mock model and a recorded prototype, not new generated-app proof. The CI product-quality entrypoint now delegates to this existing full task, retaining unit/browser checks and adding the missing Eve scenario and report generation.

`mise run test:fresh-bootstrap-evals` initially failed its first case, `fresh-bootstrap-publication`, on both post-repair `32dddc257` and pre-repair `04dbe048`. The helper expected obsolete tool name `apply-app-creation`; the retained event contained exactly one `apply_app_creation` request. The identifier was corrected without weakening the exact-one-request or explicit-approval requirement. This was a pre-existing harness failure, not a regression introduced by PRs 440/441. The initial fail-fast run did not execute the remaining five cases. After that correction, the first case reached a second failure: the shared receipt producer and verifier reconstructed identical fields in different JSON key orders, rejecting a valid outer receipt digest. Both files also predate the repairs. The verifier now reconstructs the outer receipt through the existing producer, preserving strict field checks. That exposed a second serialization mismatch: strict Zod parsing appended an executable identity digest field after `uid`, changing signed JSON bytes. Its schema now preserves the producer order without allowing extra or malformed fields. Six focused regression cases cover both contracts. These are real shared contract defects, not grounds to weaken the eval. Follow-up execution results are recorded below.

With only the approval identifier corrected, independent runs exposed the same receipt failure in publication, empty publication, negative publication, and recovery (each reached four passing gates before failing its next approval expectation). Wrong-source passed all 10 gates and capabilities passed all eight. This avoids hiding the remaining cases behind the suite's fail-fast behavior.

The publication eval now asserts one approval in the publication turn rather than counting the earlier apply approval again. Negative fallback checks use the actual underscore tool identifier; they are stronger than the obsolete-name checks. Recovery idempotence now checks that the retry requests neither another recovery call nor another approval, while retaining exactly one recovery call across the complete scenario. This replaces a brittle expected sentence with behavioral assertions; the original recovery operation already passed.

The existing `ci-eve-fresh-bootstrap` task is added as a required CI lane so these six cases cannot silently fall outside the aggregate check again. Ubuntu supplies its Node/Git/Python/flock requirements; it uses isolated local filesystem/Git operations with mock models and simulated target/publication authority, not hosted provider infrastructure. The product-quality CI lane now invokes the existing full deterministic task.

These helper scenarios intentionally exercise internal contracts with mocked models; they remain separate from the public-entrypoint self-reproduction benchmark and cannot count as dogfooding evidence.

## Final local results for this follow-up

All six fresh-bootstrap cases passed after the repairs: publication 14/14 gates, empty destination 13/13, rejection 13/13, recovery 17/17, wrong source 10/10, and capabilities 8/8 (75 gates total). The first three completed in the suite run; after correcting the recovery prose assertion, recovery and the remaining two were run together through the same task. No failure was reclassified as a pass without a repair and new execution.

Commands: `mise run test:product-evals`; `mise run test:fresh-bootstrap-evals`; then `mise run test:fresh-bootstrap-evals fresh-bootstrap-recovery fresh-bootstrap-wrong-source fresh-bootstrap-capabilities`. Six integrated receipt/schema regression cases, repository typecheck, touched-code lint, formatting, relative documentation links, and `git diff --check` passed. The required CI lanes provide Linux and full-suite verification for the submitted revision. Local raw diagnostics are `/private/tmp/eval-product-quality-extra.log`, `/private/tmp/eval-fresh-bootstrap-acceptance.log`, and `/private/tmp/eval-fresh-bootstrap-final-three.log`; the durable summary here preserves counts and limitations without private runtime data.

## Remaining cross-product risks

1. **Live model behavior remains unassessed after the repairs.** Tool/state tests establish the new verifier's behavior, not that the agent chooses it or repairs a generated app. Next live acceptance must use the normal public entrypoint and fixed brief; record every outcome without reroll selection.
2. **Behavioral coverage is incomplete across all generated products.** Action/readback is only partial evidence. Add shared browser walkthrough and authenticated persistence/restart verification, then cover a small CRUD app and an existing-app revision as well as the Builder replica. Never replace existing suites with the self-reproduction score.
3. **The wider eval inventory exceeds active CI coverage.** Record the execution mode and last verified revision for each relevant task before relying on it. Retired backend cases should be migrated to active shared-workflow contracts where they protect still-supported behavior; do not simply enable incompatible legacy paths.
4. **Reference warnings remain visible.** CI logs contain missing React key warnings in Builder/AuthenticatedBuilder, preview reconciliation diagnostics, Node action deprecation, punycode deprecation, and local Eve stream-listener warnings during the fresh-bootstrap run. They are not test failures and their causes were not established here. Invalid provider callbacks in negative scenarios are expected test traffic, not evidence of a regression.

## Continuing without narrowing quality

For every shared workflow repair, name affected capability families (creation, existing-app iteration, persistence, recovery/cancellation, auth/provider isolation, visual composition, navigation, and package delivery). Add focused regression coverage for the actual defect, retain existing expectations, and inspect every exact-head CI lane before merging. Record skips, blockers, and unassessed live behavior explicitly. Use a live public-entrypoint acceptance when claiming generated-product improvement; mock-model success cannot supply that claim.

See [self-reproduction handoff](self-reproduction-handoff.md) for the frozen failed baseline and ordered remaining work. Local raw logs under `/private/tmp/eval-main-ci.log` are convenient diagnostics, not portable evidence; the immutable GitHub run above is the durable source.
