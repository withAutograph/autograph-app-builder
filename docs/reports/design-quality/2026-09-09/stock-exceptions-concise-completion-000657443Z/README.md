# stock-exceptions-concise-completion — 2026-09-09T00:06:57.443Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 95/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.72%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 30         | 0             | 3          | 100% (30/30) |
| api       | 52         | 0             | 7          | 100% (52/52) |
| styling   | 17         | 0             | 5637       | 100% (17/17) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension | Score | Reason |
| --- | --- | --- |
| hierarchy | 4/4 | The page establishes a clear progression from title and review count to filters, severity-grouped exceptions, selected-item details, and replenishment action. Selected rows use a filled indicator, tinted background, and outline, while the suggested order and primary action are prominent without competing with the exception list. |
| layout | 4/4 | The master-detail composition is consistently aligned at 1024, 1440, and 1920 widths, with balanced columns, regular row spacing, and a centered maximum-width canvas on wide screens. At 700px, changing to separate list and detail views avoids squeezing both panels and preserves comfortable spacing. |
| typography | 3/4 | Headings, product names, labels, values, and explanatory copy use a consistent and readable hierarchy. Compact secondary text and several similarly weighted lines in the replenishment section make the detail panel slightly denser to scan, but no text is visibly clipped or illegible. |
| responsive | 4/4 | The composition remains usable across the supplied 700, 1024, 1440, and 1920 desktop captures. Filters and cards resize cleanly, the 1024 master-detail view remains intact, and the 700px view deliberately switches to a focused detail screen with a clear Back to exceptions control. Only a small 24px document-height overflow appears in some 1024 states, with no obscured controls. |
| productClarity | 4/4 | The interface directly supports location and severity filtering, selecting a low-stock product, switching between stock and supplier details, and trying a clearly labeled mock replenishment. Phrases such as Preview only, No supplier contacted, Stock unchanged, and Simulated — no order sent make the non-destructive behavior especially clear. |

## Strengths

- Severity grouping, cover ranges, badges, and per-item cover values make prioritization fast.
- The selected exception remains visibly associated with the detail panel in master-detail layouts.
- Supplier lead time, pack size, suggested quantity, and delivery-gap guidance provide useful context before simulation.
- Filtering updates both the result count and visible group count, reinforcing the effect of the controls.
- The narrow desktop-panel treatment preserves task focus instead of compressing the list and details into unusable columns.
- The existing Arrusted palette is used consistently, including supported status treatments and the primary action styling.

## Improvements

- **low — desktop-custom-700x900-3:** The single filtered result has a faint blue outline while its circular selection indicator remains empty and no detail view is shown. This can make the row look selected even though the user still needs to activate it. Use the neutral card treatment until the row is activated, or show the filled selected indicator and proceed to the focused detail view when the filtered result is selected.
- **low — desktop-window-0:** In the narrower master-detail panel, the suggested-order heading, pack explanation, delivery-gap warning, longer assumption, preview note, and action are concentrated into a compact lower section. It remains readable, but the decision-critical delivery warning does not separate strongly from supporting copy. Group the delivery-fit statement and assumption as one compact advisory block, then place the preview note and action in a distinct footer row using existing composition and supported component variants.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport | Category | Token references / assessed | Coverage |
| --- | --- | --- | --- |
| desktop-0 | color | 0/0 | 0% (0/227) |
| desktop-0 | typography | 0/0 | 0% (0/557) |
| desktop-0 | spacing | 0/0 | 0% (0/299) |
| desktop-0 | radius | 0/0 | 0% (0/114) |
| desktop-0 | border | 0/0 | 0% (0/137) |
| desktop-0 | shadow | 0/0 | 0% (0/120) |
| desktop-wide-0 | color | 0/0 | 0% (0/227) |
| desktop-wide-0 | typography | 0/0 | 0% (0/557) |
| desktop-wide-0 | spacing | 0/0 | 0% (0/299) |
| desktop-wide-0 | radius | 0/0 | 0% (0/114) |
| desktop-wide-0 | border | 0/0 | 0% (0/137) |
| desktop-wide-0 | shadow | 0/0 | 0% (0/120) |
| desktop-window-0 | color | 0/0 | 0% (0/227) |
| desktop-window-0 | typography | 0/0 | 0% (0/557) |
| desktop-window-0 | spacing | 0/0 | 0% (0/299) |
| desktop-window-0 | radius | 0/0 | 0% (0/114) |
| desktop-window-0 | border | 0/0 | 0% (0/137) |
| desktop-window-0 | shadow | 0/0 | 0% (0/120) |
| desktop-custom-700x900-0 | color | 0/0 | 0% (0/198) |
| desktop-custom-700x900-0 | typography | 0/0 | 0% (0/489) |
| desktop-custom-700x900-0 | spacing | 0/0 | 0% (0/265) |
| desktop-custom-700x900-0 | radius | 0/0 | 0% (0/99) |
| desktop-custom-700x900-0 | border | 0/0 | 0% (0/119) |
| desktop-custom-700x900-0 | shadow | 0/0 | 0% (0/105) |

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

- No screenshot or other visual evidence of the requested implementation plan was supplied, so its quality and completeness cannot be assessed.
- Open select menus, empty-result behavior, loading/error states, keyboard focus appearance, and desktop widths below 700px were not shown.
- Initial interactions were not run in several capture groups; passed scripted states demonstrate those visible transitions only and do not establish complete application behavior.
- Static source and adherence evidence cannot prove that every referenced public component rendered or that the full CSS cascade follows Arrusted tokens.
