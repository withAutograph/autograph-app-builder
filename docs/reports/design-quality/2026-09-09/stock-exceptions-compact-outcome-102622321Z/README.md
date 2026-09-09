# stock-exceptions-compact-outcome — 2026-09-09T10:26:22.321Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 95/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.83%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 22         | 0             | 3          | 100% (22/22) |
| api       | 58         | 0             | 9          | 100% (58/58) |
| styling   | 13         | 0             | 4980       | 100% (13/13) |

Scores from different evaluator versions or captured states are not directly comparable.

This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 4/4   | The page title, filters, exception list, selected record identity, stock evidence, and replenishment action form a clear decision path. Severity pills, selected-row treatment, and large modeled quantities make priorities easy to scan across the reviewed states.                                                                                                                                                                                                         |
| layout         | 4/4   | The wide list-detail composition is consistently aligned, spacing is controlled, and information density suits an inventory-review workflow. At 1024px the narrower columns remain usable, while the 700px view appropriately switches between list and detail rather than compressing both.                                                                                                                                                                                  |
| typography     | 4/4   | Heading levels, field labels, values, supporting copy, and emphasized quantities are visually consistent and readable. Bold product names and days-of-cover values support rapid exception scanning without introducing competing styles.                                                                                                                                                                                                                                     |
| responsive     | 4/4   | The composition behaves strongly across 1920px, 1440px, 1024px, and 700px desktop windows. Controls resize cleanly, list rows preserve their information, and the constrained detail view provides a visible Back action. Some 1024px expanded or modeled states require modest document scrolling, but content and actions remain intact.                                                                                                                                    |
| productClarity | 3/4   | Location and severity filters, exception selection, stock and supplier evidence, and the mock replenishment flow are understandable. Confirmation clearly explains the 96-unit calculation and repeatedly states that inventory is unchanged. The constrained initial view is slightly ambiguous because a row appears selected even though its detail is intentionally withheld until activation, and helper text varies despite an established selection remaining visible. |

## Strengths

- The primary workflow closely matches the brief: filter exceptions, select an item, review stock and supplier facts, and model replenishment.
- Exception rows combine product identity, SKU/location, shortage, severity, and days of cover in a compact, highly scannable format.
- The modeled action is safely framed with current, added, and projected quantities plus a plain-language calculation and explicit simulation-only messaging.
- Expanded supplier facts expose useful operational details such as case pack, last receipt, contact, and minimum order terms without crowding the default view.
- The constrained desktop-panel treatment preserves context with a clear Back to exceptions action rather than forcing two cramped panes.
- The supplied captures report no accessibility violations, and tested mock, reset, projected-quantity, and disclosure interactions passed at each reviewed width.

## Improvements

- **medium — desktop-custom-700x900-0:** Atlas is rendered with the same highlighted selected-row treatment used in wide list-detail views, but no detail or replenishment action is shown in this constrained initial state. The nearby instruction says to activate a row, so the distinction between default selection and user-established selection is not immediately obvious. In the constrained list state, defer the selected-row styling until the user activates a record, or explicitly label the highlighted record as a preview and state that opening it will show details.
- **low — desktop-1:** The helper says “Select an exception to review stock and supplier details” while Atlas remains visibly selected and its replenishment review is already open. The copy no longer reflects the current state. Make the helper state-aware—for example, “Review the selected exception or choose another”—and keep that wording consistent through confirmation and result states.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/233) |
| desktop-0                | typography | 0/0                         | 0% (0/522) |
| desktop-0                | spacing    | 0/0                         | 0% (0/271) |
| desktop-0                | radius     | 0/0                         | 0% (0/116) |
| desktop-0                | border     | 0/0                         | 0% (0/125) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/233) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/522) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/271) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/116) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/125) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/233) |
| desktop-window-0         | typography | 0/0                         | 0% (0/522) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/271) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/116) |
| desktop-window-0         | border     | 0/0                         | 0% (0/125) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/141) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/292) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/164) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/70)  |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/78)  |
| desktop-custom-700x900-0 | shadow     | 0/0                         | 0% (0/74)  |

## Latest-run screenshots

### desktop-0 — initial

Interaction: not-run.

![desktop-0 initial](desktop-0.png)

### desktop-1 — Select record and review modeled quantity

Interaction: passed.

![desktop-1 Select record and review modeled quantity](desktop-1.png)

### desktop-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-2 Confirm modeled replenishment](desktop-2.png)

### desktop-3 — Read projected quantity

Interaction: passed.

![desktop-3 Read projected quantity](desktop-3.png)

### desktop-4 — Reset fixture result

Interaction: passed.

![desktop-4 Reset fixture result](desktop-4.png)

### desktop-5 — Read expanded supplier facts

Interaction: passed.

![desktop-5 Read expanded supplier facts](desktop-5.png)

### desktop-wide-0 — initial

Interaction: not-run.

![desktop-wide-0 initial](desktop-wide-0.png)

### desktop-wide-1 — Select record and review modeled quantity

Interaction: passed.

![desktop-wide-1 Select record and review modeled quantity](desktop-wide-1.png)

### desktop-wide-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-wide-2 Confirm modeled replenishment](desktop-wide-2.png)

### desktop-wide-3 — Read projected quantity

Interaction: passed.

![desktop-wide-3 Read projected quantity](desktop-wide-3.png)

### desktop-wide-4 — Reset fixture result

Interaction: passed.

![desktop-wide-4 Reset fixture result](desktop-wide-4.png)

### desktop-wide-5 — Read expanded supplier facts

Interaction: passed.

![desktop-wide-5 Read expanded supplier facts](desktop-wide-5.png)

### desktop-window-0 — initial

Interaction: not-run.

![desktop-window-0 initial](desktop-window-0.png)

### desktop-window-1 — Select record and review modeled quantity

Interaction: passed.

![desktop-window-1 Select record and review modeled quantity](desktop-window-1.png)

### desktop-window-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-window-2 Confirm modeled replenishment](desktop-window-2.png)

### desktop-window-3 — Read projected quantity

Interaction: passed.

![desktop-window-3 Read projected quantity](desktop-window-3.png)

### desktop-window-4 — Reset fixture result

Interaction: passed.

![desktop-window-4 Reset fixture result](desktop-window-4.png)

### desktop-window-5 — Read expanded supplier facts

Interaction: passed.

![desktop-window-5 Read expanded supplier facts](desktop-window-5.png)

### desktop-custom-700x900-0 — initial

Interaction: not-run.

![desktop-custom-700x900-0 initial](desktop-custom-700x900-0.png)

### desktop-custom-700x900-1 — Select record and review modeled quantity

Interaction: passed.

![desktop-custom-700x900-1 Select record and review modeled quantity](desktop-custom-700x900-1.png)

### desktop-custom-700x900-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-custom-700x900-2 Confirm modeled replenishment](desktop-custom-700x900-2.png)

### desktop-custom-700x900-3 — Read projected quantity

Interaction: passed.

![desktop-custom-700x900-3 Read projected quantity](desktop-custom-700x900-3.png)

### desktop-custom-700x900-4 — Reset fixture result

Interaction: passed.

![desktop-custom-700x900-4 Reset fixture result](desktop-custom-700x900-4.png)

### desktop-custom-700x900-5 — Read expanded supplier facts

Interaction: passed.

![desktop-custom-700x900-5 Read expanded supplier facts](desktop-custom-700x900-5.png)

## Limitations

- The screenshots do not demonstrate opened filter menus, filtered result sets, no-result handling, or the Portland Hub zero-result state.
- Only the Atlas record is shown in detail; selection and content behavior for the other exceptions were not visually reviewed.
- Static captures cannot establish persistence, authorization, inventory updates, or other backend behavior.
- The requested implementation plan and evidence that work stopped before building or publication are not represented in the supplied visual captures, so those deliverables cannot be assessed.
- Token and component provenance cannot be fully established from screenshots; the supplied adherence evidence is conservative and has especially limited styling coverage.
