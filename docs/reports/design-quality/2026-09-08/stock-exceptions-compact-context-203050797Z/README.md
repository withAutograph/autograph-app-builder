# stock-exceptions-compact-context — 2026-09-08T20:30:50.797Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 85/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.04%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 15         | 0             | 4          | 100% (15/15) |
| api       | 34         | 0             | 12         | 100% (34/34) |
| styling   | 13         | 0             | 5880       | 100% (13/13) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 4/4   | The page establishes a clear sequence from “Stock exceptions” and review count, through location/severity filters, grouped exception records, selected-product detail, and the replenishment action. Selected rows, detail tabs, delivery guidance, and simulation confirmation are visually distinct across desktop-0, desktop-1, and desktop-2.                                                                                                                                                           |
| layout         | 3/4   | The master-detail composition is consistently aligned and comfortably spaced at 900, 1024, 1440, and 1920 pixels. Cards and controls use predictable dimensions, but the fixed two-column arrangement produces substantial unused space after filtering to one record in desktop-wide-3, and the 1024-pixel view requires a separately scrolling product list.                                                                                                                                              |
| typography     | 3/4   | Headings, product names, cover values, metadata, and action labels form a consistent and readable type hierarchy. However, key-value labels such as “Estimated cover,” “On hand,” and supplier fields are visually faint; the supplied accessibility evidence repeatedly reports a 2.24:1 contrast ratio for these labels.                                                                                                                                                                                  |
| responsive     | 3/4   | Across the supplied desktop windows from 900 to 1920 pixels, controls remain usable, text does not visibly collide, and both panes preserve their task context. At 1024×768 the product list becomes an intentional local scroll region and includes explanatory text, though the weak visual indication of that scrolling slightly reduces discoverability.                                                                                                                                                |
| productClarity | 4/4   | The task is immediately understandable: filter low-stock products, select a record, compare stock and supplier information, and simulate a suggested order. Quantity-specific button labels, “Preview only · No supplier contacted,” delivery-gap guidance, and the post-action “Order simulated. Stock levels are unchanged.” message make the mock nature and consequences unusually clear; the supplied interaction checks passed for filtering, supplier inspection, delivery guidance, and simulation. |

## Strengths

- The exception count and “Lowest cover first” description clearly communicate scope and prioritization.
- Critical and warning records are grouped, while location, severity, product name, and days of cover remain easy to scan within each row.
- Selected-record styling creates an unambiguous relationship between the left list and right detail panel.
- Stock position and supplier details are separated without losing the selected product’s identity and location context.
- Delivery guidance is contextual: the warning treatment calls out a delivery gap, while the neutral treatment confirms when standard delivery fits current cover.
- The replenishment action includes the proposed quantity, and the simulated state explicitly confirms that no order was sent or stock changed.
- The composition scales cleanly across the supplied desktop widths without document-level horizontal overflow.

## Improvements

- **medium — desktop-0:** The labels in the replenishment summary are much lighter than their values. This weakens rapid comparison of cover, on-hand quantity, reorder point, and suggested order; the supplied accessibility report also identifies these labels at 2.24:1 contrast. Use a supported RecordDetail composition or available text-emphasis variant that gives field labels a stronger semantic role, or recompose the information into compact labeled rows with clearer weight and proximity. Keep the authoritative Arrusted palette rather than overriding colors.
- **low — desktop-window-0:** The product pane scrolls independently at 1024×768, but the list has no strong persistent visual cue that another record is below the fold. The helper sentence appears outside the cards and can be overlooked during scanning. Keep the intentional scroll region, but place a persistent list count or supported scan summary in its header/footer and retain a visible edge cue near the clipped content so the remaining record is easier to discover.
- **low — desktop-wide-3:** When filtering leaves one result, the left pane becomes mostly empty while the selected detail remains separated in a fixed right column. The interface is still usable, but the filtered state feels less compositionally connected on a wide window. For very short result sets, allow the detail panel to align closer to the result or let the detail area expand within the existing centered container. Preserve the master-detail relationship and avoid introducing a different workflow solely for this state.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/226) |
| desktop-0                | typography | 0/0                         | 0% (0/560) |
| desktop-0                | spacing    | 0/0                         | 0% (0/313) |
| desktop-0                | radius     | 0/0                         | 0% (0/114) |
| desktop-0                | border     | 0/0                         | 0% (0/137) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/226) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/560) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/313) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/114) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/137) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/226) |
| desktop-window-0         | typography | 0/0                         | 0% (0/560) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/313) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/114) |
| desktop-window-0         | border     | 0/0                         | 0% (0/137) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-900x900-0 | color      | 0/0                         | 0% (0/226) |
| desktop-custom-900x900-0 | typography | 0/0                         | 0% (0/560) |
| desktop-custom-900x900-0 | spacing    | 0/0                         | 0% (0/313) |
| desktop-custom-900x900-0 | radius     | 0/0                         | 0% (0/114) |
| desktop-custom-900x900-0 | border     | 0/0                         | 0% (0/137) |
| desktop-custom-900x900-0 | shadow     | 0/0                         | 0% (0/120) |

## Latest-run screenshots

### desktop-0 — initial

Interaction: not-run.

![desktop-0 initial](desktop-0.png)

### desktop-1 — Select and inspect supplier

Interaction: passed.

![desktop-1 Select and inspect supplier](desktop-1.png)

### desktop-2 — Simulate replenishment

Interaction: passed.

![desktop-2 Simulate replenishment](desktop-2.png)

### desktop-3 — Filter records

Interaction: passed.

![desktop-3 Filter records](desktop-3.png)

### desktop-4 — Review delivery within cover

Interaction: passed.

![desktop-4 Review delivery within cover](desktop-4.png)

### desktop-wide-0 — initial

Interaction: not-run.

![desktop-wide-0 initial](desktop-wide-0.png)

### desktop-wide-1 — Select and inspect supplier

Interaction: passed.

![desktop-wide-1 Select and inspect supplier](desktop-wide-1.png)

### desktop-wide-2 — Simulate replenishment

Interaction: passed.

![desktop-wide-2 Simulate replenishment](desktop-wide-2.png)

### desktop-wide-3 — Filter records

Interaction: passed.

![desktop-wide-3 Filter records](desktop-wide-3.png)

### desktop-wide-4 — Review delivery within cover

Interaction: passed.

![desktop-wide-4 Review delivery within cover](desktop-wide-4.png)

### desktop-window-0 — initial

Interaction: not-run.

![desktop-window-0 initial](desktop-window-0.png)

### desktop-window-1 — Select and inspect supplier

Interaction: passed.

![desktop-window-1 Select and inspect supplier](desktop-window-1.png)

### desktop-window-2 — Simulate replenishment

Interaction: passed.

![desktop-window-2 Simulate replenishment](desktop-window-2.png)

### desktop-window-3 — Filter records

Interaction: passed.

![desktop-window-3 Filter records](desktop-window-3.png)

### desktop-window-4 — Review delivery within cover

Interaction: passed.

![desktop-window-4 Review delivery within cover](desktop-window-4.png)

### desktop-custom-900x900-0 — initial

Interaction: not-run.

![desktop-custom-900x900-0 initial](desktop-custom-900x900-0.png)

### desktop-custom-900x900-1 — Select and inspect supplier

Interaction: passed.

![desktop-custom-900x900-1 Select and inspect supplier](desktop-custom-900x900-1.png)

### desktop-custom-900x900-2 — Simulate replenishment

Interaction: passed.

![desktop-custom-900x900-2 Simulate replenishment](desktop-custom-900x900-2.png)

### desktop-custom-900x900-3 — Filter records

Interaction: passed.

![desktop-custom-900x900-3 Filter records](desktop-custom-900x900-3.png)

### desktop-custom-900x900-4 — Review delivery within cover

Interaction: passed.

![desktop-custom-900x900-4 Review delivery within cover](desktop-custom-900x900-4.png)

## Limitations

- Only static screenshots and reported interaction assertions were supplied; hover, focus, open-select, empty-result, and error states were not observed.
- The evidence covers desktop windows from 900 to 1920 pixels. Per the evaluation constraints, phone and tablet responsiveness was not assessed even though the brief mentions phones.
- No visual implementation plan or publication state was supplied, so whether the deliverable stopped before building/publication cannot be determined from these images.
- Passed interaction assertions confirm displayed state changes only; they do not establish backend or real ordering behavior.
- Arrusted styling provenance has very low assessed coverage in the supplied report, so no broader token-adherence conclusion is drawn.
