# Stock Exceptions composition and evidence improvement

The evaluator/report changes landed through [PR #338](https://github.com/withAutograph/autograph-app-builder/pull/338)
at `296452aec61bbfcd8e4f3ed7f70fc8770af0908b`. Both exact-head and resulting-main
CI passed. The subsequent improvement work is a local candidate, not a production
deployment or proof that generation always produces this result.

## Results

| Observation                                                                            | Subjective design | Evidence notes                                                                                                   |
| -------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Saved baseline](stock-exceptions-adherence-v2-181423365Z/README.md)                   | 75/100            | Evaluator 2; initial states only                                                                                 |
| [First composition pass](stock-exceptions-composition-first-pass-185811538Z/README.md) | 65/100            | Supplier fixture used the wrong locator; vertical scrolling was not reported; retained rather than discarded     |
| [Corrected composition](stock-exceptions-composition-corrected-190303519Z/README.md)   | 80/100            | Evaluator 3; all nine selection/supplier, simulated-order, and filter checks passed across three desktop windows |
| [Tabbed detail](stock-exceptions-tabbed-detail-191819290Z/README.md)                   | 80/100            | Existing shared tabs keep each detail group and action visible; all nine interaction checks passed               |

The judge model and rubric remain unchanged. Captured states and evaluator
capabilities differ, so these are directional observations, not a controlled
statistical benchmark or a guarantee of improvement. No judge result was rerolled
unchanged to select a higher score. The corrected pass fixed actual copy and
fixture defects before one new judgment. Original screenshots and reports remain
unchanged. No palette adjustment or generated color override was introduced.

## What changed

- The table keeps product, severity, and cover; secondary values remain in the
  selected record. The unsupported `narrowLayout` option was removed.
- Selection persists across filters when still applicable; otherwise the first
  matching record becomes the current selection.
- The existing detail composition uses its scrollable body and persistent footer.
  Supplier fields use the existing disclosure, not a custom control.
- Simulation is explicit in the visible subtitle and action label, including the
  completed state. The record-count sentence handles singular and plural.
- These are manual composition changes to the saved generated source, rendered
  against the existing Vercel Sandbox checkout. A new model-driven walkthrough
  was not run. The report JSON includes the exact supplied source.
- Corresponding domain-neutral generation guidance is in the agent instructions
  and the existing Arrusted consumption plan; it does not mandate this layout for
  other products.

### Same initial state, 1440 × 900

Baseline:

![Baseline initial composition](stock-exceptions-adherence-v2-181423365Z/desktop-0.png)

Corrected:

![Corrected initial composition](stock-exceptions-composition-corrected-190303519Z/desktop-0.png)

## Adherence confidence

The corrected report says **100/100 partial**, with **0.49% overall evidence
coverage**. This is not whole-app adherence. Component evidence covers 8/9
observations; API evidence covers 7/30; generated styling evidence covers 6/4272.
The large unassessed styling denominator comes chiefly from compiled inline CSS
whose shared/generated origin is unresolved.

The evaluator now checks finite nested props using the selected checkout's real
TypeScript APIs and reports actual diagnostic text. It detected an unsupported
configuration in the earlier source that the old literal-only checker missed.
Any/unknown, recursive, callback-shaped, and unresolved types stay unassessed.
Rendered tag/class matches provide review candidates only: shared components can
assemble identical classes dynamically, so those matches never earn score credit.
Vertical scrolling is now explicitly reported as observed behavior rather than
mistakenly omitted from the judge's evidence.

## Remaining work toward a genuine 100

1. Review the existing detail composition's compact field/disclosure capabilities
   to keep supplier, lead time, and pack size together in shorter desktop windows.
   Improve the shared API only if an actual missing capability is confirmed.
2. Check supported title/status and metadata arrangements; do not introduce
   bespoke generated controls or change Arrusted colors for a score.
3. Verify whether table density actually affects header typography before using
   the judge's suggestion. A model recommendation is not proof of an API.
4. Improve build-time stylesheet/source-map provenance if available. Keep unknown
   browser origins unassessed; do not manufacture confidence from token matches,
   unused imports, or class names. No runtime instrumentation or generation gate.
5. Re-evaluate only after meaningful implementation changes. The target remains
   advisory 100, not a release condition or an excuse for repeated score sampling.

No deployment, package release, provider reconfiguration, or Arrusted shared
component publication is part of this comparison.

## Incremental update: tabbed detail

The newest pass reuses the existing `RecordDetailPanel` tabs, ordinary field
rows, footer, and subtitle plus a public `StatusPill`. No shared component or
palette was changed. Stock position and supplier information occupy separate
views; the long product title no longer competes with the badge on the same row.
Estimated cover is a normal readable field, and simulation remains explicit.
The source and all twelve screenshots are in the new report; earlier runs remain
unchanged.

![Tabbed detail in a 1024px desktop window](stock-exceptions-tabbed-detail-191819290Z/desktop-window-0.png)

![Supplier detail after selecting another record](stock-exceptions-tabbed-detail-191819290Z/desktop-window-1.png)

The unchanged model/rubric scored this pass **80/100**, not 100. It no longer
identified the long scrolling detail body as a defect. It still identified the
repetitive selection column, plain severity text, and small table headers.
Its suggestions of a richer cell or typography variant are hypotheses: the
inspected DataTable supports serializable cells and row density, not arbitrary
cell rendering or a header typography variant. Do not invent those props or
override colors to follow a model recommendation.

Component evidence now covers **9/10**, API evidence **13/33**, and generated
styling **8/4277** observations. The TypeScript checker no longer mistakes
independent sibling fields with the same type for recursion. True cycles,
unresolved values, and callbacks remain unassessed. Composition changes also
change the denominator, so this is not a controlled evaluator-only comparison.

The compiled preview contains one inline Tailwind stylesheet with no source map
or preserved stylesheet URLs. Its matched rules cannot identify which source
consumer supplied a utility. The **4269 unknown browser styling observations
remain unknown**. A Tailwind class match or ordinary source map alone cannot
prove that a utility came from Arrusted. Direct source stylesheet attribution
would require separately preserved generated/shared CSS assets at build time;
that renderer change has not been implemented or claimed by this PR.

PR #339's first CI attempt found missing TypeScript narrowing in the new
class-evidence helper. The follow-up guards absent initializers and namespaced
attributes and adds a focused regression. No check or scoring criterion was
removed.

## Incremental update: shared selectable cards

[The next report](stock-exceptions-shared-cards-192715403Z/README.md) scored
**90/100** with the same model and rubric. All nine scripted supplier,
simulation, and filter checks passed. In the integrated Browser, clicking Milk
and then pressing ArrowDown selected Avocado and updated its detail panel;
that separate keyboard observation is not claimed as an automated report check.

![Shared selectable cards in a 1024px desktop window](stock-exceptions-shared-cards-192715403Z/desktop-window-0.png)

The saved source now uses the existing public `DecisionOptionCard` and
`StatusPill`, sorted by lowest cover first. It removes the repeated Select column
and small table headers while preserving selection and the shared detail tabs.
This is a genuine composition alternative, not a new custom component or a
change to Arrusted's palette. The tradeoff is more vertical space; the short
desktop list scrolls within its panel. The table alternatives remain preserved.

The remaining findings are important: small shared colored status text has weak
contrast, and the detail's post-action status replaces severity with a mock-order
outcome. The latter is an actual semantic defect to repair by keeping severity
and action outcome separate. The former must be addressed, if needed, through
supported composition and readable redundant text—not palette overrides.
The evaluator still cannot establish most compiled styling provenance. This
report is not a claim of 100/100 quality or complete adherence confidence.

## Incremental update: stronger API evidence on unchanged source

The JSX checker now assesses reliable branches of recursive union types and
checks raw string attributes against the selected component's TypeScript props.
It does not assume that an unresolved type is valid, or that statically valid
JSX rendered in the browser.

Reanalyzing the **same source files saved in the shared-card report**, without
capturing screenshots again or rerunning the AI judge, changed these counts:

| Dimension       | Before assessed / total | After assessed / total | Remaining unknown |
| --------------- | ----------------------- | ---------------------- | ----------------- |
| Component usage | 10 / 11                 | 10 / 11                | 1                 |
| API usage       | 14 / 37                 | 25 / 37                | 12                |
| Styling         | 9 / 4419                | 9 / 4419               | 4410              |

API evidence coverage rises from **37.84% to 67.57%**. All assessed observations
conform, so the advisory adherence score remains **100, partial**. Combined
coverage is only **0.99%**, because unknown browser styling dominates the
denominator. The subjective design score remains **90/100**; this evidence
improvement is not a new visual-quality result.

The archived report and its original screenshots remain unchanged. The source
analysis is reproducible with `readReference`, `analyzeSource`, and
`scoreAdherence`, using that report's `sourceFiles`, its existing browser
observations, and the selected Arrusted checkout. Focused fixtures cover
recursive unions, reliable full unions, unresolved members, and equivalent raw
versus expression-wrapped JSX strings. No scoring formula or palette changed.

## Incremental update: readable status and honest action outcome

[The next report](stock-exceptions-readable-outcome-195532570Z/README.md) scored
**85/100**, down from 90, using the unchanged model and rubric. All nine fixture
checks passed and no layout measurement findings were reported. The invalid
radio-group container was repaired; shared muted-text contrast observations
remain informational.

![Severity remains visible after the simulation](stock-exceptions-readable-outcome-195532570Z/desktop-window-2.png)

The simulation now retains the record's original severity and separately says
that stock levels are unchanged. A narrower desktop window keeps both panes
visible. Supported neutral status pills improve the readability of labels, but
the reviewer found that the lost color distinction slows urgency scanning. It
also found that the fixed-width filter row straddles the narrower list/detail
boundary, and that the outcome message is too similar to muted metadata.

These are useful next changes, not a reason to reroll the judge. This report is
preserved alongside the stronger 90-point variant. No palette values, scoring
weights, or historical reports changed. The UI is still a manually refined
generated example, not evidence that every new generation reaches this quality.
