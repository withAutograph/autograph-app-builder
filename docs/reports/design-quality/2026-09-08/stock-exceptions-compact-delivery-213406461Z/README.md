# stock-exceptions-compact-delivery — 2026-09-08T21:34:06.461Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 85/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.59%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 28         | 0             | 3          | 100% (28/28) |
| api       | 49         | 0             | 8          | 100% (49/49) |
| styling   | 17         | 0             | 5808       | 100% (17/17) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 3/4   | The page title, review count, filters, severity groups, selected row, and detail card form a clear scan path. Selected items receive a strong outline and the replenishment action is isolated at the lower right. Critical and Warning rows remain visually very similar, however, so urgency depends heavily on reading group headings and small pill text.                                                                     |
| layout         | 4/4   | The master-detail composition is consistently aligned, with filters matching the list column and detail values using clean label/value alignment. Spacing remains balanced from 900px through 1920px, and the centered maximum-width treatment prevents the wide view from becoming overly stretched.                                                                                                                             |
| typography     | 4/4   | Product names, section headings, metadata, quantities, and explanatory copy use a restrained and consistent hierarchy. Labels and secondary text remain readable at every provided size, while bold numeric values support quick comparison without excessive typographic variation.                                                                                                                                              |
| responsive     | 3/4   | The two-column workflow remains usable at 900, 1024, 1440, and 1920 pixels; controls resize, copy wraps cleanly, and buttons remain visible without horizontal overflow. At the 1024-by-768 capture, the full page reaches 802px and therefore requires modest vertical scrolling, and no narrower desktop panel state was supplied to show how the composition adapts when two columns can no longer fit comfortably.            |
| productClarity | 3/4   | The interface clearly communicates that users should filter exceptions, select a product, inspect stock or supplier information, and run a non-destructive simulation. Counts update after filtering, selected records remain obvious, and the completed state explicitly says no order was sent. On the Supplier details tab, however, the action quantity is presented without the suggested-order row that explains its basis. |

## Strengths

- The master-detail workflow closely matches the inventory-review task and keeps list context visible while inspecting a product.
- Location and severity filters are prominent, labeled, and shown updating both the result count and visible records.
- Products are grouped by severity and sorted by cover, with location, severity, and days of cover available directly in each row.
- Stock and supplier tabs expose relevant operational details without overcrowding the detail card.
- Replenishment is unambiguously framed as a preview, and the simulated state confirms that stock was unchanged and no order was sent.
- The Arrusted palette and restrained component styling remain visually consistent across the supplied states.

## Improvements

- **medium — desktop-1:** The Supplier details view shows supplier, lead time, and order pack, then offers “Simulate 24-unit order,” but the suggested-order value that explains 24 units is only visible on the Stock position tab. This weakens the decision context immediately before the action. Keep a compact “Suggested order: 24 units” summary visible above the tabs or repeat it near the action, while retaining supplier-specific details in the selected tab.
- **low — desktop-0:** Critical and Warning rows use nearly identical card treatment and similarly neutral status pills. The section headings provide differentiation, but rapidly scanning urgency still requires reading the small labels. Strengthen non-color hierarchy within the existing palette—for example, make the severity group headings more prominent, include a concise cover-range cue in each heading, or give the lowest-cover value a more consistent leading emphasis using supported component variants.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/221) |
| desktop-0                | typography | 0/0                         | 0% (0/557) |
| desktop-0                | spacing    | 0/0                         | 0% (0/298) |
| desktop-0                | radius     | 0/0                         | 0% (0/114) |
| desktop-0                | border     | 0/0                         | 0% (0/142) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/221) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/557) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/298) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/114) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/142) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/221) |
| desktop-window-0         | typography | 0/0                         | 0% (0/557) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/298) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/114) |
| desktop-window-0         | border     | 0/0                         | 0% (0/142) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-900x900-0 | color      | 0/0                         | 0% (0/221) |
| desktop-custom-900x900-0 | typography | 0/0                         | 0% (0/557) |
| desktop-custom-900x900-0 | spacing    | 0/0                         | 0% (0/298) |
| desktop-custom-900x900-0 | radius     | 0/0                         | 0% (0/114) |
| desktop-custom-900x900-0 | border     | 0/0                         | 0% (0/142) |
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

### desktop-5 — Read the stock-view delivery assumption

Interaction: passed.

![desktop-5 Read the stock-view delivery assumption](desktop-5.png)

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

### desktop-wide-5 — Read the stock-view delivery assumption

Interaction: passed.

![desktop-wide-5 Read the stock-view delivery assumption](desktop-wide-5.png)

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

### desktop-window-5 — Read the stock-view delivery assumption

Interaction: passed.

![desktop-window-5 Read the stock-view delivery assumption](desktop-window-5.png)

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

### desktop-custom-900x900-5 — Read the stock-view delivery assumption

Interaction: passed.

![desktop-custom-900x900-5 Read the stock-view delivery assumption](desktop-custom-900x900-5.png)

## Limitations

- The screenshots demonstrate only desktop widths from 900px to 1920px; narrower desktop panels and intermediate widths were not provided.
- Static captures cannot establish keyboard behavior, focus order, select-menu composition, or backend behavior. Reported interaction checks only confirm the supplied expected text states.
- The brief also requests an implementation plan and stopping before build or publication, but those deliverables and process states cannot be assessed from the visual screenshots.
- Token and component provenance are not inferred from appearance; the supplied adherence evidence is static and leaves most styling behavior unassessed.
