# stock-exceptions-task-first — 2026-09-09T02:10:07.174Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 90/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 2.46%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 45         | 0             | 4          | 100% (45/45) |
| api       | 75         | 0             | 6          | 100% (75/75) |
| styling   | 28         | 0             | 5857       | 100% (28/28) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 4/4   | The page title, filters, exception count, severity groups, selected row, and detail card form a clear review sequence. Urgency is reinforced through Critical/Warning pills and days-of-cover values, while the replenishment action remains visually primary without overpowering stock and supplier information.                                                                 |
| layout         | 3/4   | The two-column master-detail composition is consistently aligned at 1024, 1440, and 1920 widths, with balanced card spacing and clear section dividers. The narrow 700px composition sensibly separates list and detail views. Minor issues include an understated sorting note and desktop row-selection affordances that are less explicit than the narrow-width Review buttons. |
| typography     | 3/4   | Headings, product names, quantities, labels, and supporting text use a consistent and readable type hierarchy. Bold values make stock data easy to scan, though several small metadata labels and the passive sorting text have limited prominence relative to their operational importance.                                                                                       |
| responsive     | 4/4   | The composition adapts effectively across the supplied desktop widths: content is centered at 1920px, remains usable in two columns at 1024px, and switches to a focused list/detail flow at 700px with a clear Back to exceptions control. No clipping is visible; modest document scrolling at shorter windows is reasonable.                                                    |
| productClarity | 4/4   | The interface clearly supports filtering by location and severity, reviewing stock and supplier details, and trying replenishment. Preview only · No supplier contacted, Stock unchanged, and Simulated — no order sent make the mock nature and outcome of the action unusually clear.                                                                                            |

## Strengths

- Critical and Warning grouping, group cover ranges, and lowest-cover ordering support rapid inventory triage.
- Selected records are visibly connected to matching product, location, SKU, severity, and cover details.
- On-hand stock, reorder point, supplier, lead time, delivery impact, and suggested replenishment are organized into understandable review sections.
- The mock action communicates both its quantity and safety boundaries before and after activation.
- The 700px desktop-panel treatment replaces the dense master-detail view with explicit Review and Back controls rather than compressing both panels.
- Captured filter, selection, supplier inspection, delivery-impact, and simulation states remain visually consistent across the supplied desktop sizes.

## Improvements

- **low — desktop-0:** The circular markers on desktop rows resemble radio inputs, but there is no nearby instruction explaining that selecting one opens its review details. The explicit Review buttons in the 700px composition communicate this action more directly. Clarify the desktop affordance with a short instruction such as “Select a product to review,” or add a supported secondary Review button/row action while retaining the selected-row treatment.
- **low — desktop-0:** “Lowest cover first” is small, right-aligned, and styled like passive metadata, so the active ordering rule is easy to miss when scanning the result count and severity headings. Change the copy to “Sorted by: Lowest cover” or place it in a supported Tag or other compact status treatment beside the result count.
- **low — desktop-0:** The operationally important delivery outcome is presented as an ordinary sentence. Users must read the full line to distinguish an order that arrives before depletion from one arriving after stockout. Add a supported StatusPill or Tag summarizing the outcome, such as “0.6 days late” or “Within cover,” beside the Delivery impact heading while preserving the explanatory sentence.
- **low — desktop-window-0:** At the 1024px window, the footer places the safety note and a long quantity-specific action at opposite ends of a compact panel. It fits, but has little room for longer product quantities or localized text. Allow the footer content to wrap into two aligned rows when panel space becomes constrained, or switch to the existing focused single-panel composition at a slightly wider constraint.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/228) |
| desktop-0                | typography | 0/0                         | 0% (0/564) |
| desktop-0                | spacing    | 0/0                         | 0% (0/299) |
| desktop-0                | radius     | 0/0                         | 0% (0/114) |
| desktop-0                | border     | 0/0                         | 0% (0/136) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/228) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/564) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/299) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/114) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/136) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/228) |
| desktop-window-0         | typography | 0/0                         | 0% (0/564) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/299) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/114) |
| desktop-window-0         | border     | 0/0                         | 0% (0/136) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/234) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/594) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/272) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/134) |
| desktop-custom-700x900-0 | shadow     | 0/0                         | 0% (0/120) |

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

### desktop-5 — Read delivery impact

Interaction: passed.

![desktop-5 Read delivery impact](desktop-5.png)

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

### desktop-wide-5 — Read delivery impact

Interaction: passed.

![desktop-wide-5 Read delivery impact](desktop-wide-5.png)

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

### desktop-window-5 — Read delivery impact

Interaction: passed.

![desktop-window-5 Read delivery impact](desktop-window-5.png)

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

### desktop-custom-700x900-5 — Read delivery impact

Interaction: passed.

![desktop-custom-700x900-5 Read delivery impact](desktop-custom-700x900-5.png)

## Limitations

- The screenshots demonstrate only the supplied widths and states; intermediate panel widths, zoom levels, open select menus, keyboard focus, and long or localized content were not shown.
- Static screenshots and reported interaction checks do not establish backend behavior or whether an actual supplier/order workflow exists.
- The requested implementation plan is not visible in the supplied interface evidence, so its completeness cannot be assessed.
- Some source branches and callbacks were statically unassessed, and rendered component provenance cannot be established from the screenshots alone.
- The 700px list capture reports one manual accessibility-review item, but no specific violation is provided, so no visual defect can be attributed to it.
