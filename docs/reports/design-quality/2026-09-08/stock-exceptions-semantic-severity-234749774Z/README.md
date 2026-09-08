# stock-exceptions-semantic-severity — 2026-09-08T23:47:49.774Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 90/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.67%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 30         | 0             | 3          | 100% (30/30) |
| api       | 52         | 0             | 7          | 100% (52/52) |
| styling   | 16         | 0             | 5754       | 100% (16/16) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 4/4   | The page establishes a clear progression from title and review count to filters, severity-grouped exceptions, selected record, and replenishment action. Selected rows use a distinct outline/background, while the detail panel gives stock, supplier, and suggested-order information appropriate visual priority.                                                                                                                          |
| layout         | 4/4   | Alignment and spacing are consistently handled across the filter row, exception cards, detail fields, tabs, and right-aligned action. The centered maximum-width composition prevents excessive stretching at 1920px, and the 1024px split view remains compact without obvious collisions.                                                                                                                                                   |
| typography     | 3/4   | Headings, product names, metadata, values, and explanatory copy form a consistent and readable type hierarchy. However, the 12px orange and red status-pill text repeatedly triggers measured contrast ratios around 2.5–3.2:1, making severity labels harder to read even though grouping and surrounding text provide redundant context.                                                                                                    |
| responsive     | 4/4   | The composition adapts effectively across the supplied desktop widths: 1920px and 1024px retain master-detail views, while the 700px panel changes to a focused detail view with a clear Back to exceptions control. Filters and actions remain visible and usable; the small 30px document-height overflow at 1024px is minor and does not obscure controls.                                                                                 |
| productClarity | 3/4   | The task is highly understandable: records are ordered by cover, filters update the review count, tabs separate stock and supplier information, suggested quantities are explained in packs, and the action repeatedly states that it is a simulation with no order sent. Clarity is reduced in the 700px detail state by an instruction that still says to select a product and by an omitted location line on the first narrow-list record. |

## Strengths

- Severity grouping and days-of-cover values make urgency easy to scan without relying only on color.
- Location and severity filters are prominent, labeled, and visibly update both the result count and list.
- The detail panel combines stock position, supplier data, lead-time implications, pack sizing, and suggested quantity in a concise review flow.
- Mock-action language is unusually clear: the interface says no supplier was contacted, labels the order as simulated, and confirms stock levels are unchanged.
- The 700px desktop-panel treatment uses a sensible drill-in/back pattern instead of compressing both panes into an unusably narrow split.
- The selected-record state, active tab, and post-simulation state are visually distinct across the captured widths.

## Improvements

- **medium — desktop-0:** The red and orange 12px severity-pill labels are small and repeatedly measured below standard text contrast, with ratios around 2.5–3.2:1. Their repetition makes this a persistent readability weakness, especially when scanning multiple exceptions. Preserve the Arrusted palette and use a supported status treatment with stronger non-color redundancy—for example, keep the pill as an accent but place the severity word in standard body text, or use a supported variant with an icon and accessible label rather than overriding component colors.
- **medium — desktop-custom-700x900-0:** The first exception omits its location subtitle, while every other record in the same narrow list includes one. Since the filters are set to all locations, this removes useful identifying context and makes the row structure inconsistent. Retain the location line for every exception at this width. If information must be reduced, apply the same disclosed rule to all rows and keep location available through another explicit text field.
- **low — desktop-custom-700x900-1:** The detail view still says “Select a product to review,” even though a product has already been selected and the list has been replaced by its detail view. The stale instruction slightly weakens orientation in the drill-in layout. Change the subtitle in focused detail mode to contextual guidance such as “Review stock, supplier, and simulated replenishment,” or omit the selection instruction until the user returns to the exception list.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/221) |
| desktop-0                | typography | 0/0                         | 0% (0/557) |
| desktop-0                | spacing    | 0/0                         | 0% (0/293) |
| desktop-0                | radius     | 0/0                         | 0% (0/114) |
| desktop-0                | border     | 0/0                         | 0% (0/140) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/221) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/557) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/293) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/114) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/140) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/221) |
| desktop-window-0         | typography | 0/0                         | 0% (0/557) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/293) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/114) |
| desktop-window-0         | border     | 0/0                         | 0% (0/140) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/216) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/549) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/289) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/111) |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/137) |
| desktop-custom-700x900-0 | shadow     | 0/0                         | 0% (0/117) |

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

- No standalone implementation plan is visible in the supplied screenshots, so the brief's planning deliverable cannot be assessed.
- Backend behavior, persistence, supplier contact, and real ordering behavior cannot be inferred from this visual prototype.
- Initial-state interactions were not run in several captures; only the specifically reported supplier, filter, delivery, and simulation text checks are evidenced.
- The smallest supplied desktop width is 700px, so behavior in narrower desktop panels is unknown.
- Static source adherence evidence has high unassessed styling coverage and does not prove that every referenced public component rendered.
