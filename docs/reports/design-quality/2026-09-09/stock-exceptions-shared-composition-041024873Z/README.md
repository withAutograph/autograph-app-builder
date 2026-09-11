# stock-exceptions-shared-composition — 2026-09-09T04:10:24.873Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 80/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 0.93%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 10         | 0             | 1          | 100% (10/10) |
| api       | 30         | 0             | 11         | 100% (30/30) |
| styling   | 10         | 0             | 5298       | 100% (10/10) |

Scores from different evaluator versions or captured states are not directly comparable.

This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 3/4   | The page title, filters, exception list, selected record, stock position, supplier details, and replenishment action form a clear review sequence. Selection highlighting and section headings scan well, although the primary action is placed after a tall detail card and can fall below the initial viewport.                                                                           |
| layout         | 3/4   | The list-detail composition is consistently aligned, with balanced spacing and compact record rows. At 1920px the filter fields and detail panel stretch considerably, creating long horizontal spans and unused space, while at shorter desktop heights the action requires page or panel scrolling.                                                                                       |
| typography     | 3/4   | Titles, product names, quantities, and section headings have a consistent readable hierarchy. Several metadata labels and severity pills use very small text; automated evidence repeatedly flags the 10–12px muted and status text as marginal or insufficient in contrast, so important severity and supporting details are less robust than the primary content.                         |
| responsive     | 3/4   | The composition adapts well from a two-column list-detail view at 1920/1440/1024px to a constrained detail view with a Back control at 700px. Controls remain usable and no horizontal overflow is shown, but short windows place the primary action below the initial viewport, and the 700px mock-result message is partially obscured at the panel footer.                               |
| productClarity | 4/4   | The task is immediately understandable: filter by location and severity, select a low-stock item, compare on-hand stock with its reorder point, review supplier information, and try a clearly labeled mock action. Counts, selected-state synchronization, empty-state copy, and explicit messaging that no order or inventory change occurred make the prototype’s scope unusually clear. |

## Strengths

- Clear master-detail workflow with product identity, severity, location, and stock ratio available directly in each list row.
- Location and severity filters are prominent, show the resulting exception count, and synchronize the selected detail record.
- The stock warning explains the numerical shortfall rather than relying on status color alone.
- The mock action is explicitly non-destructive, and the result states the staged quantity, case count, and that no order was sent.
- The constrained 700px desktop composition replaces the list with a focused detail view and a clear Back to exceptions affordance.
- Empty filtered states are represented consistently across all supplied desktop widths.

## Improvements

- **medium — desktop-window-0:** In the measured 1024×768 window, the primary replenishment action is positioned around y=916 in a 992px document, so it is not available in the initial viewport even though it is the main completion step. Keep the public Button in the detail panel’s action footer, but make that footer remain visible within the constrained panel while the stock and supplier sections scroll; alternatively reduce vertical section spacing so the action enters the initial short-window view.
- **medium — desktop-custom-700x900-1:** The mock-result callout reaches underneath the footer boundary and its final line is visibly clipped, weakening confirmation immediately after the action. Reserve footer space in the detail content and scroll the result section fully into view after the mock action, ensuring the complete confirmation callout ends above the Reset mock footer.
- **low — desktop-wide-0:** At 1920px the two filter controls each expand to roughly 858px, making simple choices span most of the screen and increasing pointer and reading travel without adding information. Place the filter controls and result count in a bounded filter group or use narrower proportional columns, while allowing the surrounding Arrusted card and list-detail composition to remain fluid.
- **medium — desktop-0:** Secondary identity text and the Critical pill are materially smaller than the product name and quantity. Automated evidence reports low contrast for the selected-row metadata and 10px status text, which can make severity and location harder to scan despite the otherwise strong row composition. Retain the Arrusted palette and StatusPill, but reinforce severity with regular-size text in the row’s evidence column and avoid placing essential location or SKU information only in the smallest caption style. If a larger shared status treatment is needed, add it to the shared design system rather than overriding component colors.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/225) |
| desktop-0                | typography | 0/0                         | 0% (0/499) |
| desktop-0                | spacing    | 0/0                         | 0% (0/276) |
| desktop-0                | radius     | 0/0                         | 0% (0/115) |
| desktop-0                | border     | 0/0                         | 0% (0/132) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/225) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/499) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/276) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/115) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/132) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/225) |
| desktop-window-0         | typography | 0/0                         | 0% (0/499) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/276) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/115) |
| desktop-window-0         | border     | 0/0                         | 0% (0/132) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/192) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/479) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/227) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/97)  |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/105) |
| desktop-custom-700x900-0 | shadow     | 0/0                         | 0% (0/97)  |

## Latest-run screenshots

### desktop-0 — initial

Interaction: not-run.

![desktop-0 initial](desktop-0.png)

### desktop-1 — Mock replenishment result

Interaction: passed.

![desktop-1 Mock replenishment result](desktop-1.png)

### desktop-2 — Reset mock result

Interaction: passed.

![desktop-2 Reset mock result](desktop-2.png)

### desktop-3 — Filter and synchronize selection

Interaction: passed.

![desktop-3 Filter and synchronize selection](desktop-3.png)

### desktop-4 — Empty filtered state

Interaction: passed.

![desktop-4 Empty filtered state](desktop-4.png)

### desktop-wide-0 — initial

Interaction: not-run.

![desktop-wide-0 initial](desktop-wide-0.png)

### desktop-wide-1 — Mock replenishment result

Interaction: passed.

![desktop-wide-1 Mock replenishment result](desktop-wide-1.png)

### desktop-wide-2 — Reset mock result

Interaction: passed.

![desktop-wide-2 Reset mock result](desktop-wide-2.png)

### desktop-wide-3 — Filter and synchronize selection

Interaction: passed.

![desktop-wide-3 Filter and synchronize selection](desktop-wide-3.png)

### desktop-wide-4 — Empty filtered state

Interaction: passed.

![desktop-wide-4 Empty filtered state](desktop-wide-4.png)

### desktop-window-0 — initial

Interaction: not-run.

![desktop-window-0 initial](desktop-window-0.png)

### desktop-window-1 — Mock replenishment result

Interaction: passed.

![desktop-window-1 Mock replenishment result](desktop-window-1.png)

### desktop-window-2 — Reset mock result

Interaction: passed.

![desktop-window-2 Reset mock result](desktop-window-2.png)

### desktop-window-3 — Filter and synchronize selection

Interaction: passed.

![desktop-window-3 Filter and synchronize selection](desktop-window-3.png)

### desktop-window-4 — Empty filtered state

Interaction: passed.

![desktop-window-4 Empty filtered state](desktop-window-4.png)

### desktop-custom-700x900-0 — initial

Interaction: not-run.

![desktop-custom-700x900-0 initial](desktop-custom-700x900-0.png)

### desktop-custom-700x900-1 — Mock replenishment result

Interaction: passed.

![desktop-custom-700x900-1 Mock replenishment result](desktop-custom-700x900-1.png)

### desktop-custom-700x900-2 — Reset mock result

Interaction: passed.

![desktop-custom-700x900-2 Reset mock result](desktop-custom-700x900-2.png)

### desktop-custom-700x900-3 — Filter and synchronize selection

Interaction: passed.

![desktop-custom-700x900-3 Filter and synchronize selection](desktop-custom-700x900-3.png)

### desktop-custom-700x900-4 — Empty filtered state

Interaction: passed.

![desktop-custom-700x900-4 Empty filtered state](desktop-custom-700x900-4.png)

## Limitations

- Only the supplied rendered states were evaluated; dropdown menus, keyboard focus, loading, error, and long-content states were not shown.
- The 1440×900 and 1024×768 captures have documents taller than their viewports. Scrolling may be intentional, but the evidence still shows that the primary action is initially below the viewport.
- Interaction evidence confirms selected mock, reset, filtering, and empty states, but initial interaction was not run for every width.
- No separate implementation-plan artifact was supplied, so the brief’s implementation-plan deliverable could not be evaluated.
- Static source and adherence evidence do not prove that every dynamic component branch rendered or that the full CSS cascade conforms.
