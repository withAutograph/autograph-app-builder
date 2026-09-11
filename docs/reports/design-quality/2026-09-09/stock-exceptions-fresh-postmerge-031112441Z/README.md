# stock-exceptions-fresh-postmerge — 2026-09-09T03:11:12.441Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 65/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 98/100 (partial); evidence coverage 1.14%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 15         | 0             | 3          | 100% (15/15) |
| api       | 34         | 2             | 15         | 94% (34/36)  |
| styling   | 18         | 0             | 5970       | 100% (18/18) |

Scores from different evaluator versions or captured states are not directly comparable.

This report evaluates a fresh generated component-backed preview; evaluation itself did not regenerate it or prove a built backend. Scores are advisory and not human-calibrated. See [comparison notes](comparison-notes.md) for the generation context and limitations.

## Ratings

| Dimension | Score | Reason |
| --- | --- | --- |
| hierarchy | 3/4 | The page establishes a clear sequence from title and filters to the selectable exception list, selected-product detail, and replenishment action. Selection tint, severity pills, section headings, and the modal give strong state cues, though tiny sales/coverage metadata and low-emphasis field labels are easy to overlook. |
| layout | 3/4 | The list-detail composition is consistently aligned and comfortably spaced at 1024–1920px, while the replenishment modal is compact and well organized. At 1920px the filter container has substantial unused vertical space, and at 700px the stacked list and detail create a long journey to the primary action. |
| typography | 2/4 | Product names, section headings, values, and action labels are consistent and readable, but important supporting text is frequently only 10–12px. Automated evidence repeatedly flags weak contrast for muted labels, row metadata, status text, and detail labels; the palette should remain unchanged, but supported typography roles could provide stronger emphasis. |
| responsive | 2/4 | The two-column workspace scales cleanly between 1024px and 1920px, the modal remains usable at 700px, and no horizontal overflow is shown. However, the 700px state becomes a 1505px document with the selected detail and action far below the list, while the 1024×768 modal state shifts the underlying page header and filters above the viewport; these behaviors weaken continuity across resized desktop windows. |
| productClarity | 3/4 | The purpose, location/severity filters, result count, selectable products, stock-versus-reorder values, supplier details, and explicitly non-destructive simulation are readily understandable. Passed interaction checks support the represented selection, filtering, empty-state, modal, and prepared-simulation states. The main ambiguity is that a zero-result filter retains the previously selected product detail and an enabled replenishment action, making the relationship between filters and the active record unclear. |

## Strengths

- The master-detail workflow supports quick comparison without obscuring the selected product’s stock and supplier context.
- Severity, on-hand quantity, reorder point, suggested replenishment, open purchase order, supplier minimum, and lead time provide useful decision evidence.
- The replenishment dialog clearly states that no purchase order will be created or sent and summarizes supplier constraints before simulation.
- Selection, filtered, empty, modal, and prepared-simulation states are represented across multiple desktop widths.
- The prepared state gives explicit confirmation and changes the action label to “Revise mock replenishment,” making the mock workflow reversible.
- The existing Arrusted palette is used consistently, and the supplied static assessment found no assessed component nonconformance; broader styling provenance remains largely unassessed.

## Improvements

- **high — desktop-5:** The filters report zero exceptions, but the detail panel still presents Whole Bean Coffee as actionable and keeps “Try mock replenishment” enabled. Users may interpret this stale record as part of the filtered result set. When the result set becomes empty, replace the detail panel with a selection-required explanation or clearly label the retained record as outside the current filters and disable the replenishment entry point until a matching item is selected.
- **medium — desktop-custom-700x900-0:** At the resized 700px desktop width, the detail panel follows the entire four-item list and places the primary action near y=1437. Reviewing a selected item therefore requires a long scroll away from the selection context. At this desktop panel width, prioritize the selected detail immediately after the selected row, use a detail sheet, or provide a supported sticky section/action arrangement so selection and review remain spatially connected.
- **medium — desktop-window-2:** Opening the modal in the 1024×768 capture leaves the underlying page scrolled so the title and most filters are above the viewport. The modal itself remains usable, but closing it could return users to a visually displaced context. Preserve and restore the workspace scroll position when opening and closing the modal, and center the dialog within the current viewport without moving the underlying document.
- **low — desktop-wide-0:** The wide filter panel reserves a large blank band above the controls, making the controls appear detached from the page heading and using wide-screen space inefficiently. Use the compact filter-row composition at wide widths, vertically center the controls and result count, or place a concise filter heading/summary in the currently empty area.
- **medium — desktop-window-0:** Each exception row has generous height, while severity and stock ratio sit centered beneath the left-aligned product metadata. This slows vertical scanning and makes comparisons across products less direct. Use a consistent internal row grid: keep product and location together on the left and align severity plus on-hand/reorder evidence in a stable right-hand column.
- **medium — desktop-0:** Active detail labels such as “On hand,” “Reorder point,” and supplier fields visually resemble disabled text, and the sales/coverage metadata is very small. Automated checks repeatedly identify these text roles as difficult to distinguish. Retain the Arrusted palette but use supported body/caption and field-label variants with stronger size or weight, reserving disabled typography for genuinely unavailable content.
- **high — desktop-custom-700x900-5:** The narrow empty-filter state repeats the same stale-detail ambiguity over a large portion of the document: zero exceptions is followed by a complete previous record and an available replenishment action. Coordinate empty results and selection state across both panels; clear the selected detail or explicitly expose a separate “previous selection” state that cannot be acted on under the active filters.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport | Category | Token references / assessed | Coverage |
| --- | --- | --- | --- |
| desktop-0 | color | 0/0 | 0% (0/231) |
| desktop-0 | typography | 0/0 | 0% (0/594) |
| desktop-0 | spacing | 0/0 | 0% (0/293) |
| desktop-0 | radius | 0/0 | 0% (0/120) |
| desktop-0 | border | 0/0 | 0% (0/135) |
| desktop-0 | shadow | 0/0 | 0% (0/120) |
| desktop-wide-0 | color | 0/0 | 0% (0/231) |
| desktop-wide-0 | typography | 0/0 | 0% (0/594) |
| desktop-wide-0 | spacing | 0/0 | 0% (0/293) |
| desktop-wide-0 | radius | 0/0 | 0% (0/120) |
| desktop-wide-0 | border | 0/0 | 0% (0/135) |
| desktop-wide-0 | shadow | 0/0 | 0% (0/120) |
| desktop-window-0 | color | 0/0 | 0% (0/231) |
| desktop-window-0 | typography | 0/0 | 0% (0/594) |
| desktop-window-0 | spacing | 0/0 | 0% (0/293) |
| desktop-window-0 | radius | 0/0 | 0% (0/120) |
| desktop-window-0 | border | 0/0 | 0% (0/135) |
| desktop-window-0 | shadow | 0/0 | 0% (0/120) |
| desktop-custom-700x900-0 | color | 0/0 | 0% (0/232) |
| desktop-custom-700x900-0 | typography | 0/0 | 0% (0/594) |
| desktop-custom-700x900-0 | spacing | 0/0 | 0% (0/283) |
| desktop-custom-700x900-0 | radius | 0/0 | 0% (0/120) |
| desktop-custom-700x900-0 | border | 0/0 | 0% (0/135) |
| desktop-custom-700x900-0 | shadow | 0/0 | 0% (0/120) |

## Latest-run screenshots

### desktop-0 — initial

Interaction: not-run.

![desktop-0 initial](desktop-0.png)

### desktop-1 — Select and inspect supplier

Interaction: passed.

![desktop-1 Select and inspect supplier](desktop-1.png)

### desktop-2 — Open replenishment

Interaction: passed.

![desktop-2 Open replenishment](desktop-2.png)

### desktop-3 — Simulate replenishment

Interaction: passed.

![desktop-3 Simulate replenishment](desktop-3.png)

### desktop-4 — Filter records

Interaction: passed.

![desktop-4 Filter records](desktop-4.png)

### desktop-5 — Empty filtered state

Interaction: passed.

![desktop-5 Empty filtered state](desktop-5.png)

### desktop-wide-0 — initial

Interaction: not-run.

![desktop-wide-0 initial](desktop-wide-0.png)

### desktop-wide-1 — Select and inspect supplier

Interaction: passed.

![desktop-wide-1 Select and inspect supplier](desktop-wide-1.png)

### desktop-wide-2 — Open replenishment

Interaction: passed.

![desktop-wide-2 Open replenishment](desktop-wide-2.png)

### desktop-wide-3 — Simulate replenishment

Interaction: passed.

![desktop-wide-3 Simulate replenishment](desktop-wide-3.png)

### desktop-wide-4 — Filter records

Interaction: passed.

![desktop-wide-4 Filter records](desktop-wide-4.png)

### desktop-wide-5 — Empty filtered state

Interaction: passed.

![desktop-wide-5 Empty filtered state](desktop-wide-5.png)

### desktop-window-0 — initial

Interaction: not-run.

![desktop-window-0 initial](desktop-window-0.png)

### desktop-window-1 — Select and inspect supplier

Interaction: passed.

![desktop-window-1 Select and inspect supplier](desktop-window-1.png)

### desktop-window-2 — Open replenishment

Interaction: passed.

![desktop-window-2 Open replenishment](desktop-window-2.png)

### desktop-window-3 — Simulate replenishment

Interaction: passed.

![desktop-window-3 Simulate replenishment](desktop-window-3.png)

### desktop-window-4 — Filter records

Interaction: passed.

![desktop-window-4 Filter records](desktop-window-4.png)

### desktop-window-5 — Empty filtered state

Interaction: passed.

![desktop-window-5 Empty filtered state](desktop-window-5.png)

### desktop-custom-700x900-0 — initial

Interaction: not-run.

![desktop-custom-700x900-0 initial](desktop-custom-700x900-0.png)

### desktop-custom-700x900-1 — Select and inspect supplier

Interaction: passed.

![desktop-custom-700x900-1 Select and inspect supplier](desktop-custom-700x900-1.png)

### desktop-custom-700x900-2 — Open replenishment

Interaction: passed.

![desktop-custom-700x900-2 Open replenishment](desktop-custom-700x900-2.png)

### desktop-custom-700x900-3 — Simulate replenishment

Interaction: passed.

![desktop-custom-700x900-3 Simulate replenishment](desktop-custom-700x900-3.png)

### desktop-custom-700x900-4 — Filter records

Interaction: passed.

![desktop-custom-700x900-4 Filter records](desktop-custom-700x900-4.png)

### desktop-custom-700x900-5 — Empty filtered state

Interaction: passed.

![desktop-custom-700x900-5 Empty filtered state](desktop-custom-700x900-5.png)

## Limitations

- The supplied visual evidence shows the prototype but does not expose the requested implementation plan, so the plan’s quality or completeness cannot be assessed.
- Most interaction states were exercised successfully, but initial-state interaction was not run at every width and reset behavior was not demonstrated.
- No screenshots show keyboard focus, validation/error handling, dropdown menus, loading states, or modal close/scroll restoration after interaction.
- The 700px images are full-document captures from a 900px-high window, so the amount of scrolling is observable but the exact user scroll sequence is not.
- Static adherence evidence cannot prove that every public component rendered, and styling assessment coverage is very low; token and component provenance therefore remain uncertain.
- Contrast observations are advisory design findings only; the existing Arrusted palette is treated as authoritative.
