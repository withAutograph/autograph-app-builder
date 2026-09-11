# stock-exceptions-action-context — 2026-09-08T21:41:52.809Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 90/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.73%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 31         | 0             | 3          | 100% (31/31) |
| api       | 53         | 0             | 8          | 100% (53/53) |
| styling   | 18         | 0             | 5775       | 100% (18/18) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension | Score | Reason |
| --- | --- | --- |
| hierarchy | 4/4 | The page establishes a clear sequence from title and review count to filters, severity-grouped exceptions, selected-item detail, and replenishment action. Selected rows, section headings, cover values, suggested quantities, and the primary action are consistently prominent across the supplied states. |
| layout | 3/4 | The two-column master-detail composition is aligned and comfortably dense at 1024–1920px, with consistent card spacing and stable detail structure. At 700px it stacks cleanly, but the complete six-item list precedes the detail panel, placing review content and the action far below the selected record. |
| typography | 4/4 | Type sizing, weight, and alignment consistently distinguish titles, group headings, product names, metadata, values, assumptions, and actions. Short labels and right-aligned inventory values remain readable even in the 1024px and 700px captures. |
| responsive | 3/4 | The interface remains usable without horizontal overflow from 1920px down to the supplied 700px desktop window, and controls resize or stack appropriately. The narrow stacked state is functional but inefficient: in the unfiltered captures the detail begins around y=807 and the action appears around y=1248, well beyond the 900px viewport. |
| productClarity | 4/4 | The task is immediately understandable: filter exceptions, select a product, switch between stock and supplier details, and simulate a suggested order. Copy such as “Preview only · No supplier contacted,” delivery-gap explanations, and “Simulated — no order sent” clearly communicates the mock action and its consequences. |

## Strengths

- Severity grouping and ascending days-of-cover values make the exception list quick to scan.
- Selection is reinforced through the radio indicator, border, tinted row, and matching detail title.
- Stock and supplier tabs expose the requested information without overloading a single view.
- Suggested quantities are explained in supplier-pack terms, and delivery timing is related directly to current cover.
- Filtered counts, headings, and cover ranges update coherently in the supplied filter state.
- The simulation result is explicit and does not imply that inventory changed or that an order was transmitted.
- The wide layout is centered rather than stretching records excessively, while 1024px windows still retain a useful side-by-side review flow.

## Improvements

- **medium — desktop-custom-700x900-1:** In the narrow unfiltered composition, the selected Sparkling Water row is followed by another record before its detail panel begins at approximately y=807. Most supplier information and the replenishment action at the bottom of this region therefore require substantial scrolling and feel spatially detached from the selection. For narrow desktop panels, keep the selected context and action closer together—for example, place the detail directly after the selected row, collapse the remaining list behind a “Back to exceptions” control, or provide a compact persistent selected-item summary that leads to the detail. Preserve the existing primary Button styling.
- **low — desktop-0:** Critical and Warning rows use nearly identical neutral pill and dot treatments. The bold group headings and explicit text prevent ambiguity, but severity is slower to distinguish when scanning individual rows out of section context. Reinforce the existing textual grouping without changing the Arrusted palette—for example, add a severity icon or short urgency descriptor to the supported status treatment, or make the group header remain associated with its rows while the list scrolls.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport | Category | Token references / assessed | Coverage |
| --- | --- | --- | --- |
| desktop-0 | color | 0/0 | 0% (0/221) |
| desktop-0 | typography | 0/0 | 0% (0/557) |
| desktop-0 | spacing | 0/0 | 0% (0/293) |
| desktop-0 | radius | 0/0 | 0% (0/114) |
| desktop-0 | border | 0/0 | 0% (0/140) |
| desktop-0 | shadow | 0/0 | 0% (0/120) |
| desktop-wide-0 | color | 0/0 | 0% (0/221) |
| desktop-wide-0 | typography | 0/0 | 0% (0/557) |
| desktop-wide-0 | spacing | 0/0 | 0% (0/293) |
| desktop-wide-0 | radius | 0/0 | 0% (0/114) |
| desktop-wide-0 | border | 0/0 | 0% (0/140) |
| desktop-wide-0 | shadow | 0/0 | 0% (0/120) |
| desktop-window-0 | color | 0/0 | 0% (0/221) |
| desktop-window-0 | typography | 0/0 | 0% (0/557) |
| desktop-window-0 | spacing | 0/0 | 0% (0/293) |
| desktop-window-0 | radius | 0/0 | 0% (0/114) |
| desktop-window-0 | border | 0/0 | 0% (0/140) |
| desktop-window-0 | shadow | 0/0 | 0% (0/120) |
| desktop-custom-700x900-0 | color | 0/0 | 0% (0/223) |
| desktop-custom-700x900-0 | typography | 0/0 | 0% (0/557) |
| desktop-custom-700x900-0 | spacing | 0/0 | 0% (0/289) |
| desktop-custom-700x900-0 | radius | 0/0 | 0% (0/114) |
| desktop-custom-700x900-0 | border | 0/0 | 0% (0/137) |
| desktop-custom-700x900-0 | shadow | 0/0 | 0% (0/120) |

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

### desktop-custom-700x900-0 — initial

Interaction: not-run.

![desktop-custom-700x900-0 initial](desktop-custom-700x900-0.png)

### desktop-custom-700x900-1 — Select and inspect supplier

Interaction: passed.

![desktop-custom-700x900-1 Select and inspect supplier](desktop-custom-700x900-1.png)

### desktop-custom-700x900-2 — Simulate replenishment

Interaction: passed.

![desktop-custom-700x900-2 Simulate replenishment](desktop-custom-700x900-2.png)

### desktop-custom-700x900-3 — Filter records

Interaction: passed.

![desktop-custom-700x900-3 Filter records](desktop-custom-700x900-3.png)

### desktop-custom-700x900-4 — Review delivery within cover

Interaction: passed.

![desktop-custom-700x900-4 Review delivery within cover](desktop-custom-700x900-4.png)

### desktop-custom-700x900-5 — Read the stock-view delivery assumption

Interaction: passed.

![desktop-custom-700x900-5 Read the stock-view delivery assumption](desktop-custom-700x900-5.png)

## Limitations

- No screenshot or other visual evidence of the requested implementation plan was supplied, so that deliverable cannot be assessed.
- The 700px images show full document captures while the measured viewport was 900px high; the scrolling cost is inferred from the supplied coordinates and document height, not from an observed scrolling session.
- Interaction evidence covers selection, filtering, tab changes, delivery messaging, and simulation, but dropdown-open, keyboard-focus, empty-result, and error states were not shown.
- Screenshots cannot establish backend behavior or whether any real order could be sent.
- The component and API evidence is largely static, and styling provenance has very low assessed coverage; it was kept separate from the interface-design scores.
