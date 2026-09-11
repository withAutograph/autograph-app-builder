# Stacked explanations comparison

This on-demand evaluation scores the existing component-backed Stock Exceptions preview after two changes: long assumption/replenishment fields use Arrusted's new supported `layout: "stacked"` option, and the priority-order summary uses the existing primary Typography tone. No palette overrides or scoring changes were made. Shared capability: Arrusted commit `88dd4b586587d3cd54bc2fb80f274131503bbb92` ([PR #1318](https://github.com/withAutograph/arrusted-development/pull/1318)).

## Result

- Subjective design score: **90/100**, unchanged from the supplier-constraints report. Hierarchy, responsive composition, and product clarity scored 4/4; layout and typography scored 3/4.
- All 20 fixture interaction checks passed across four desktop sizes. The four initial captures have no interaction to run; there are 24 screenshots total.
- Adherence is **100% of assessed evidence, partial**. Component evidence: 19 conforming / 2 unassessed. API evidence: 49 conforming / 10 unassessed. Styling evidence: 13 conforming / 5,181 unassessed. Overall observation coverage is 1.54%; this is not comprehensive proof of styling adherence.

## What changed and what remains

The wider explanation text removes the prior narrow-value-column wrapping. The judge now finds mixed stacked/inline rows less consistent in the constrained confirmation view. A next composition experiment can use a consistent layout throughout the confirmation summary. This is a product-specific composition choice, not a rule that every app must use stacked fields.

The existing shared primary Button contrast remains an informational concern. This report does not authorize palette changes, duplicated action copy, or app-level Button restyling merely to obtain a higher score. The expanded supplier-section anchor is a secondary review observation; intentional scrolling remains supported and all measured interaction outcomes passed.

Compare with [the preceding supplier-constraints report](../stock-exceptions-supplier-constraints-072705375Z/index.html). Keep both reports: the score did not improve, and subjective findings can vary. No score was selected from repeated identical runs.
