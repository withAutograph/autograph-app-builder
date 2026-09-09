# Advisory design-quality cases

This source-backed, synthetic corpus gives the advisory design evaluator six decision-shaped scenarios. Each directory contains a `brief.md`, synthetic `fixtures.json`, and selector metadata in `case.json`.

`evidence.status` is deliberately per-source: `implemented` identifies a checked-in domain artifact, while `planned` identifies a documented direction only. A case is advisory material, not proof that a described workflow ships.

## Choose a case

| Case                      | Task and intended variety                                                     |
| ------------------------- | ----------------------------------------------------------------------------- |
| `position-request`        | Draft a position; correct salary/date errors and confirm the draft            |
| `spend-import-review`     | Map an import, preview changes, distinguish saved rows from uncertain matches |
| `revenue-analysis`        | Explain revenue movement and investigate a contributing account               |
| `reorganization-scenario` | Compare a proposed structure with current people and costs                    |
| `compensation-planning`   | Review a package, band comparison, assumptions, and next decision             |
| `vendor-spend-forecast`   | Separate actuals, expected charges, commitments, and renewal assumptions      |

AG2 supplies product/workflow examples, not a second component system. Use the
selected Arrusted checkout's current public components, tokens and catalog.
Evidence paths are research references, never runtime eligibility checks. Read
their current contents and distinguish a domain model or template from a complete
working product. Repository commits in reports are diagnostic only.

## Applying the recurring findings

Use the [generation composition guidance](../../agent/skills/design-app/references/information-composition.md)
and [current Arrusted capabilities](arrusted-composition-capabilities.md) together.
The guidance applies across product domains; the capability notes point into the
existing public API rather than defining a second component registry.

- Keep the selected choice, available action, recorded outcome, and status copy
  consistent. Acknowledging an issue is not the same as resolving it.
- Put material units, periods, current/proposed values, denominators and
  assumptions beside the decision they explain. Do not impose a KPI layout.
- Keep decision-relevant detail readable when desktop panels resize, using
  supported typography and composition variants without changing the palette.
- Make synthetic interactions update the data being reviewed. Mapping, editing
  an assumption, and recording a decision should have observable consequences,
  not merely display a success message.

The import and compensation examples include small, reusable fixture-state
examples. They demonstrate interaction semantics, not a mandatory application
architecture or proof of a working backend. Historical reports remain unchanged.
When comparing a revised example, keep the original brief and clearly distinguish
a hand-edited reference example from a fresh model-generated result.

These are authoring principles and advisory review questions—not runtime checks,
score thresholds, automatic repair loops, or new user approval steps. Test concrete
interaction changes once, then let CI handle broad regression coverage.

```sh
mise run eval:design -- --list-cases
mise run eval:design -- --case revenue-analysis --preview-url URL \
  --arrusted-root PATH --source-dir GENERATED_SOURCE --fixture-interactions
```

Generate a fixture preview from the brief and synthetic data once, using the
Development App Builder. Wait until its preview revision settles, then inspect
the actual controls before binding scenarios. Evaluate the existing preview;
the evaluator never generates, restarts, or publishes an app. A saved local copy
of its rendered HTML can avoid a later preview revision invalidating the URL.

`fixtures.json` supplies representative synthetic data. User outcomes are the
contract, not exact names, amounts, layouts, selectors, or screenshots. Generated
source and the report record the values actually used. Do not score an app against
requirements that were added after its generation prompt.

## Interaction evidence

The checked-in `scenarios.json` files bind to the first batch's generated controls,
not every future app. Prefer actual accessible roles/names (including aria-labels,
not merely button text). Rebind them after inspecting a new preview. Use an
explicit `--scenario FILE` to override the case file. Scenario actions run only
when `--fixture-interactions` is supplied; without it the report is observational.
Never execute these scenarios against real imports, compensation, organization,
or financial writes. The captured fixture effects are in-memory simulations.

Record unimplemented outcomes as gaps; do not manufacture controls or silently
weaken assertions to make a report pass. A successful click and expected message
does not prove every data transformation, backend, or user outcome works.

## Reading and extending the batch

Keep subjective design scores separate from adherence percentages, coverage, and
interaction results. All are advisory; there is no 90/100 threshold, automatic
polish loop, CI score gate, or required layout. Partial evidence remains partial.
Use the existing desktop sizes and palette unchanged.

Archive a report with `mise run eval:design-archive -- --report-dir PATH --name CASE`.
Preserve historical reports and link each new run from a dated batch summary under
`docs/reports/design-quality/`. Record harness/input corrections rather than
discarding inconvenient scores. Compare findings and captured states, not just
numbers from different briefs or evaluator versions.

To add a case, add its brief, synthetic data, source/status references, review
questions and observable outcomes. Favor a genuinely different task. Do not add
a duplicate component registry or prescribe a queue/dashboard for all cases.
