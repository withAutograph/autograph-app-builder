# Arrusted and AG2 — six-case design evaluation

Six Development App Builder previews, generated with real Arrusted components
through Vercel Sandbox and evaluated at 1440×900, 1920×1080 and 1024×768. All
actions use synthetic, in-memory data. These are design examples, not evidence
that six production backends exist.

[Case library and source references](../../../design-quality-cases/README.md) ·
[All historical reports](../README.md)

## Results

| Case and report                                                         | Subjective design /100 | Assessed adherence /100 | Evidence coverage | Fixture outcomes                             |
| ----------------------------------------------------------------------- | ---------------------: | ----------------------: | ----------------: | -------------------------------------------- |
| [Position request](position-request-131250013Z/README.md)               |                     85 |                     100 |             1.77% | 12/12                                        |
| [Spend import and review](spend-import-review-132244628Z/README.md)     |                     75 |                      96 |             2.76% | 9/12 initially; corrected selector 3/3 below |
| [Revenue analysis](revenue-analysis-131950277Z/README.md)               |                     80 |                      98 |             2.29% | 6/6                                          |
| [Reorganization scenario](reorganization-scenario-131430037Z/README.md) |                     90 |                      99 |             1.05% | 6/6                                          |
| [Compensation planning](compensation-planning-131305302Z/README.md)     |                     75 |                     100 |             2.22% | 6/6                                          |
| [Vendor spend forecast](vendor-spend-forecast-131521865Z/README.md)     |                     80 |                      99 |             5.04% | 6/6                                          |

The six main reports contain **66 screenshots** and **48 interaction observations**.
The original reports record 45 passed and three failed; a focused correction of
the import selector subsequently passed those three observations. Do not describe
this as a single all-green run. The three supplemental screenshots below preserve
the correction without replacing the original report or rerolling its score.

Adherence is **partial in every case**. A 100 among assessed observations is not
100% application conformity. No score threshold was imposed. Different cases,
source coverage and captured states make these directional findings rather than
a calibrated leaderboard or a comparison with the earlier Stock Exceptions 95.

## What generalized well

- The builder produced a form, analytical overview, organizational comparison,
  compensation review, forecast, and multi-step import rather than six copies
  of the exception queue.
- Position salary/date errors were actionable and values survived correction;
  the saved fixture summary was explicit.
- Reorganization made current versus proposed facts and hypothetical effects
  clear. Compensation explained band assumptions, and revenue connected account
  movement to the headline total.
- Simulated outcomes appeared without provider writes, publication, or building
  the full apps. Runs stopped at or before the build decision.

## Reusable improvements revealed by the batch

1. **Put each number's basis beside it.** Compensation leaves the package total's
   current/proposed basis unclear. Forecast variance lacks its plan denominator
   and the renewal uplift's base. Guidance should require comprehensible units,
   periods, assumptions and comparisons when the task depends on them—not a
   mandatory KPI layout.
2. **Keep actions consistent with the recorded state.** Compensation and
   reorganization retain a strongly emphasized recommendation after a different
   decision. Forecast says review complete while the watch item remains unresolved.
   Distinguish acknowledgement, recommendation and resolution in product terms.
3. **Keep decision-relevant columns and evidence usable in desktop panels.** The
   import result column scrolls out of view; count pills wrap awkwardly. Shared
   composition choices should prioritize the task without forbidding useful
   horizontal scrolling or inventing minimum widths.
4. **Show important context using readable supported variants.** Small metadata
   and status text recur. Preserve Arrusted's palette; investigate composition,
   typography and supported emphasis rather than generated color overrides.
5. **Make fixture behavior representative, not merely clickable.** Source review
   found that import mapping state does not affect the static preview rows;
   compensation assumptions are explanatory rather than editable; the reorg
   names only two of 18 people. Revenue has no period picker or export. Passing
   the selected scenarios does not certify these unimplemented outcomes.

These are follow-up candidates, not changes applied automatically by this batch.
No new component registry, score gate, automatic repair loop or palette was added.

## Import selector correction

The failed scenario clicked the `sr-only` radio itself. Playwright reported that
the containing element intercepted pointer events. Clicking its visible
`DecisionOptionCard` label, as a user does, records the simulated match correctly.
The checked-in scenario now targets that label. Only that action sequence was
retested; no full rerun, regeneration, or second AI judgment was performed.

- [1440×900 passing match](import-match-supplement/match-corrected-1440.png)
- [1920×1080 passing match](import-match-supplement/match-corrected-1920.png)
- [1024×768 passing match](import-match-supplement/match-corrected-1024.png)

The original import score of 75 includes this failed harness interaction and
should be interpreted with the correction, not silently revised upward.

## Capture and input corrections

- An early position URL became a 404 when the run replaced its preview. Its blank
  capture is invalid, not a design score. The evaluator now stops on an actual
  failed HTTP response before scoring. A focused 404 browser regression passed.
- Final previews were saved locally to avoid URL replacement during capture.
  This copies rendered bytes; it does not regenerate or rebuild the apps.
- The first position judgment (60) used a later, overly specific brief requiring
  a particular job, budget and owner that were absent from the generation prompt.
  Its corrected judgment (85) reuses the exact screenshots and unchanged rubric
  with the actual manager drafting brief. The superseded local judgment was
  retained. This is an input correction, not evidence of a design improvement.
- Revenue's first scenarios used visible text “Select” instead of the actual
  accessible names “Explain movement: Expansion/Contraction.” The corrected report
  uses those names on the same preview. This is not a generator defect.
- Import received one same-session refinement because the original brief omitted
  the planned mapping and save-feedback steps. Its only design report evaluates
  that revised preview.

## Research and reproducibility

Research used Arrusted checkout `ba2808f0e1664ef299868abac999859fbfc6a974`
and AG2 checkout `5b087b75c986f3ca88b1949eb7a8e92e4d5b599c`. References are
diagnostic, not runtime requirements. Each case links implemented code and planned
extensions separately. AG2 supplies finance/operations requirements; Arrusted
remains the visual component and token source.

Use `mise run eval:design -- --list-cases`, then evaluate one existing preview
with `--case`, `--source-dir`, and optionally `--fixture-interactions`. The archived
JSON includes the generated source, screenshots, evidence counts, model and rubric.
Source and browser provenance remain incomplete; no backend is validated by this
report. Existing historical reports remain unchanged. No deployment, release,
marketplace publication or live business-data mutation was performed.
