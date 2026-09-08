# stock-exceptions-delivery-context — 2026-09-08T20:19:19.952Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 90/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.02%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 15         | 0             | 4          | 100% (15/15) |
| api       | 34         | 0             | 12         | 100% (34/34) |
| styling   | 12         | 0             | 5880       | 100% (12/12) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 4/4   | The page establishes a clear sequence from title and review count to filters, severity-grouped products, selected-record detail, and the replenishment action. Selected rows, detail headings, tabs, delivery guidance, and simulation confirmation are all visually distinct and easy to scan.                                                               |
| layout         | 3/4   | The two-column master-detail composition is consistently aligned and comfortably spaced from 900px through 1920px. At 1024×768, however, the list can scroll its group heading out of view and supplier content gains a small nested scroll region, slightly weakening context and flow.                                                                      |
| typography     | 4/4   | Type sizes, weights, and labels are consistent across headings, row metadata, stock values, tabs, and actions. Product names and cover values scan particularly well; only the longer delivery advisory becomes somewhat dense at narrower desktop widths.                                                                                                    |
| responsive     | 3/4   | Across the supplied desktop windows from 900×900 to 1920×1080, both columns remain usable, controls fit without horizontal overflow, and action buttons remain visible. The 1024×768 supplier state introduces nested scrolling and lost group-heading context, so the composition is strong but not seamless at shorter windows.                             |
| productClarity | 4/4   | The interface directly supports location and severity filtering, clearly identifies the selected product, separates stock position from supplier details, and presents supplier, lead-time, pack-size, and cover evidence. The mock nature of replenishment is explicit through “Preview only,” “Order simulated,” and “Simulated — no order sent” messaging. |

## Strengths

- The severity-grouped list and ascending cover values make the review order immediately understandable.
- Selected-record treatment is prominent without obscuring product, location, severity, or cover information.
- Stock and supplier tabs keep detail focused while retaining a stable action location.
- Delivery timing guidance translates supplier lead time and current cover into a useful operational recommendation.
- The simulated action has unusually clear safeguards: no supplier contact is implied, stock remains unchanged, and the completed button confirms that no order was sent.
- Wide-screen max-width behavior keeps the workspace centered and avoids excessively stretched rows or detail fields.

## Improvements

- **low — desktop-window-1:** Bringing the selected warning item into view scrolls the list enough that the “Critical · 3” heading disappears, leaving its first three products without visible group context while “Warning · 3” remains visible. Keep severity group headings sticky within the list, or adjust selection scrolling so the relevant heading remains visible with the selected row.
- **medium — desktop-window-1:** The supplier-detail body becomes a separate vertical scroll region with only a small amount of overflow and no obvious visual cue. This fragments an otherwise simple card and can make the end of the advisory content easy to miss in a short desktop window. Let the detail body use more of the available card height or modestly reduce vertical section spacing so this state fits. If internal scrolling remains necessary, provide a persistent visual scroll cue and clear panel-level scrolling behavior.
- **low — desktop-custom-900x900-1:** The delivery warning compresses the lead-time comparison, estimated gap, and recommended next step into a dense small-text paragraph at the narrower desktop width. Split the advisory into a short metric statement and a separate recommended-next-step line while retaining the existing supported warning treatment.

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

- No phone captures were supplied; per the evaluation constraints, responsiveness was assessed only across the provided desktop windows and panels.
- Open filter menus, empty results, no-selection, loading, and error states were not shown.
- Screenshots and static evidence cannot establish real backend behavior, persistence, or action authorization.
- The requested implementation plan and the requirement to stop before building or publication are not visible interface states and cannot be assessed from these captures.
- Interaction evidence covers the named selection, filtering, supplier review, delivery guidance, and simulation paths only.
