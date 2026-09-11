# Remaining gap after task-first composition

The unchanged GPT-5.6 Sol rubric 2 returned **90/100**: hierarchy 4, layout 3, typography 3, responsive composition 4, product clarity 4. Twenty scenario checks passed across four desktop sizes; automated layout findings and axe violations were empty. This is not full accessibility certification.

## Most useful next refinements

1. Clarify the active sort locally: “Sorted by: lowest cover” near the result count. Keep it contextual; do not return it to the page subtitle or make a passive sort label look like an interactive control.
2. Make wide row navigation as explicit as narrow Review. Prefer an existing shared row-action capability while retaining visible selection. Do not add a global instruction paragraph or override DecisionOptionCard internals.
3. Give delivery outcome a concise summary using one supported Tag beside “Delivery impact,” backed by the lead-time facts. Avoid restoring the old repeated badge + bold sentence + paragraph. Use wording such as “Stock gap: 0.6 days,” not “delivery late,” which could imply a missed supplier promise.
4. Exercise a longer quantity/action label at the constrained desktop width. The current footer fits; wrapping is a resilience improvement to verify, not a confirmed defect or reason to introduce an arbitrary breakpoint.

These recommendations address the judge's stated deductions. They cannot guarantee a future 100: 100 requires all five subjective axes to receive 4 in one judgment, and previous judgments varied. Preserve the human-approved structure rather than repeatedly rerolling or changing the rubric.

## Separate adherence-confidence gap

All assessed observations conform, but the score is partial:

| Dimension  | Conforming / assessed | Assessed / total | Coverage |
| ---------- | --------------------- | ---------------- | -------- |
| Components | 45 / 45               | 45 / 49          | 91.84%   |
| APIs       | 75 / 75               | 75 / 81          | 92.59%   |
| Styling    | 28 / 28               | 28 / 5885        | 0.48%    |

The six API unknowns are callbacks; four component unknowns concern dynamic branches. Type-compatible callback signatures could be assessed separately from callback behavior using TypeScript evidence, but function typing would not prove the correct visible outcome. Existing interaction results remain separate behavioral evidence, not automatic static adherence credit.

The dominant gap is 5,857 browser style observations without attributable source provenance. A credible improvement needs stylesheet/source-map evidence tracing matched rules back to generated versus shared source. Matching colors/classes, unused imports, or broad assumptions about an inline bundle are insufficient. This would be evaluator/renderer evidence work, not a UI defect. Runtime instrumentation remains outside the previously approved evaluation scope.

No palette change, new runtime gate, source rewrite to eliminate legitimate dynamic behavior, or denominator manipulation is warranted. Full confidence for every runtime state is not established by these 24 captures.

## Evaluation continuity

Obsolete interactions opening the removed Supplier tab were removed; supplier inspection is now directly visible. The delivery assertion was updated to the equivalent current fact (4-day lead time minus 2.1-day cover = 1.9-day gap). The same five scenario purposes and four desktop sizes were retained. Historical reports and scoring code were not changed.

The preceding manual composition notes were moved, intact, to `docs/reports/design-reviews/2026-09-09/stock-exceptions-task-first-composition/` so they do not masquerade as an automated archive with a report.json file.
