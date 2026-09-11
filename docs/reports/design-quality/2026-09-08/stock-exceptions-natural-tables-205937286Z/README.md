# stock-exceptions-natural-tables — 2026-09-08T20:59:37.286Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 85/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.01%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 14         | 0             | 3          | 100% (14/14) |
| api       | 34         | 0             | 9          | 100% (34/34) |
| styling   | 12         | 0             | 5880       | 100% (12/12) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension | Score | Reason |
| --- | --- | --- |
| hierarchy | 3/4 | The page establishes a clear sequence from title and review count to filters, severity-grouped exceptions, selected record, details, and the replenishment action. Selected rows have a strong outline and background treatment. Severity is less immediately scannable within each row because Critical and Warning appear mainly as secondary text rather than a compact status marker. |
| layout | 4/4 | The two-column master-detail composition is consistently aligned and comfortably dense across 900, 1024, 1440, and 1920px captures. Filters align with the exception list, detail sections use predictable spacing, and wide layouts are constrained rather than stretched. The filtered one-record state also remains balanced despite intentional open space. |
| typography | 3/4 | Product names, cover values, section headings, and tab labels are consistently styled and readable. Secondary metadata remains legible without competing with primary content. The 12px uppercase table headers are visually faint, and automated evidence reports 4.25:1 contrast against their background, narrowly below the cited threshold. |
| responsive | 3/4 | The master-detail structure remains usable from 900px through 1920px, with controls shrinking proportionally and no horizontal overflow shown. At a 1024×768 viewport, several unfiltered states have an 844px document and actions near y=736–776, so completion may require a short page scroll. No narrower desktop-panel evidence was supplied. |
| productClarity | 4/4 | The task is explicit: filter exceptions, select a product, inspect stock or supplier information, and simulate a suggested order. Cover, on-hand quantity, reorder point, supplier lead time, pack size, delivery-gap guidance, and mock-only language provide strong decision context. Passed captured interactions confirm visible state changes for filtering, supplier inspection, delivery guidance, and simulation feedback, without implying a real backend order. |

## Strengths

- Clear master-detail workflow keeps the exception list and decision context visible together.
- Location and severity filters are prominent and the result count updates in the filtered state.
- Exceptions are ordered and grouped by severity, with cover values aligned for quick comparison.
- Supplier views communicate both risky delivery gaps and cases where standard delivery fits current cover.
- The replenishment action states the proposed quantity, while preview and simulated states clearly say that no supplier was contacted and no order was sent.
- Composition remains stable and well constrained across all supplied desktop widths.

## Improvements

- **medium — desktop-0:** Critical and Warning are easy to distinguish at the group-heading level, but individual rows communicate severity only through small secondary text. This weakens row-level scanning when comparing product, location, cover, and urgency. Add the supported StatusPill or Tag beside each product or cover value, using the existing Arrusted severity variants. Keep the current group headings and palette.
- **medium — desktop-window-1:** In the 1024×768 capture, the document extends to 844px and the action spans approximately y=736–776, placing part of the primary completion control below the initial viewport. The page remains usable by scrolling, but the review-to-action path is less immediate in a shorter desktop window. Reduce nonessential vertical padding in the detail card at shorter desktop heights, or use a supported sticky detail footer so the mock replenishment action remains visible while detail content scrolls.
- **low — desktop-0:** The small uppercase table headers are noticeably lighter than the surrounding body text. Automated evidence identifies a 4.25:1 contrast ratio for these headers, making them the least readable typography in the composition. Use a more prominent supported table-header typography variant or increase header size/weight within the existing composition; retain the authoritative Arrusted palette.
- **low — desktop-2:** Simulation confirmation is accurate but appears as a single inline sentence beneath the metadata. It can be overlooked because it has limited separation from the record header, while the disabled action at the bottom may be outside immediate focus. Present the same confirmation through the supported ToastProvider or a compact status summary near the action, retaining the explicit “no order sent” and “stock levels unchanged” language.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport | Category | Token references / assessed | Coverage |
| --- | --- | --- | --- |
| desktop-0 | color | 0/0 | 0% (0/226) |
| desktop-0 | typography | 0/0 | 0% (0/560) |
| desktop-0 | spacing | 0/0 | 0% (0/313) |
| desktop-0 | radius | 0/0 | 0% (0/114) |
| desktop-0 | border | 0/0 | 0% (0/137) |
| desktop-0 | shadow | 0/0 | 0% (0/120) |
| desktop-wide-0 | color | 0/0 | 0% (0/226) |
| desktop-wide-0 | typography | 0/0 | 0% (0/560) |
| desktop-wide-0 | spacing | 0/0 | 0% (0/313) |
| desktop-wide-0 | radius | 0/0 | 0% (0/114) |
| desktop-wide-0 | border | 0/0 | 0% (0/137) |
| desktop-wide-0 | shadow | 0/0 | 0% (0/120) |
| desktop-window-0 | color | 0/0 | 0% (0/226) |
| desktop-window-0 | typography | 0/0 | 0% (0/560) |
| desktop-window-0 | spacing | 0/0 | 0% (0/313) |
| desktop-window-0 | radius | 0/0 | 0% (0/114) |
| desktop-window-0 | border | 0/0 | 0% (0/137) |
| desktop-window-0 | shadow | 0/0 | 0% (0/120) |
| desktop-custom-900x900-0 | color | 0/0 | 0% (0/226) |
| desktop-custom-900x900-0 | typography | 0/0 | 0% (0/560) |
| desktop-custom-900x900-0 | spacing | 0/0 | 0% (0/313) |
| desktop-custom-900x900-0 | radius | 0/0 | 0% (0/114) |
| desktop-custom-900x900-0 | border | 0/0 | 0% (0/137) |
| desktop-custom-900x900-0 | shadow | 0/0 | 0% (0/120) |

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

- Evaluation is based on supplied static captures and reported interaction outcomes; unshown hover, focus, loading, empty, error, and long-content states were not assessed.
- No backend behavior is inferred from the screenshots or passed text checks.
- No phone captures were provided. Per the desktop-only evaluation scope, responsiveness was judged only across supplied desktop windows and panels.
- The requested implementation plan and pre-publication stopping point are not visible in the interface captures and could not be evaluated.
- Static source and adherence evidence does not prove that every dynamic JSX branch or component rendered in these captures.
