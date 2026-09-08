# stock-exceptions-narrow-navigation — 2026-09-08T23:36:24.339Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 80/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.74%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 32         | 0             | 3          | 100% (32/32) |
| api       | 54         | 0             | 9          | 100% (54/54) |
| styling   | 17         | 0             | 5790       | 100% (17/17) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 3/4   | The page title, filter row, severity-grouped exception list, selected-row treatment, and detail card create a clear review sequence. Key quantities such as days of cover and suggested order are emphasized well, though Critical and Warning statuses use nearly identical neutral treatments, reducing at-a-glance prioritization.                                                       |
| layout         | 3/4   | The two-column master-detail layout is aligned and comfortably dense at 1024–1920px, while the 700px view appropriately switches to list-only or detail-only composition. The narrow detail state retains the full filter row above the Back action, adding avoidable vertical and conceptual overhead when the list is no longer visible.                                                  |
| typography     | 4/4   | Type sizing, weight, and spacing are consistently readable across all captures. Product names, section headings, values, explanatory copy, and metadata form a coherent hierarchy without truncation or visibly awkward wrapping.                                                                                                                                                           |
| responsive     | 3/4   | The composition adapts successfully from centered wide layouts to a tighter two-panel window and then a single-panel 700px workflow with a visible Back action. Controls remain usable and content does not overflow horizontally; however, the 700px initial state visually preselects a record without showing its detail, and some 1024px states require modest document scrolling.      |
| productClarity | 3/4   | The interface clearly supports location and severity filtering, selecting an exception, reviewing stock or supplier information, and simulating replenishment. Suggested quantities, pack assumptions, delivery gaps, and preview-only language make the mock action understandable, but the initial narrow selection treatment and post-simulation button state introduce minor ambiguity. |

## Strengths

- Severity grouping and ascending cover values make the exception list easy to scan.
- Selected records are consistently connected to corresponding product, location, cover, stock, supplier, and order details.
- Stock position and Supplier details provide a compact, understandable information split.
- The replenishment section clearly states suggested units, pack assumptions, delivery timing, and that no supplier is contacted.
- The 700px desktop-panel composition uses a focused detail view with a clear Back to exceptions action instead of compressing two columns.
- Filtered counts and visible records update coherently in the supplied filtered states.
- Scripted captures show the supplier inspection, filtering, delivery assessment, and mock replenishment states presenting their expected text.

## Improvements

- **medium — desktop-custom-700x900-0:** The first record is rendered with the selected border, tinted background, and filled radio even though the narrow composition shows no associated detail panel. This can make the initial state appear already opened while still requiring another selection action to reach details. At the list-only breakpoint, begin with no visual selection until a record is opened, or add an explicit supported review affordance that makes the transition to the detail-only view clear.
- **low — desktop-custom-700x900-1:** Location and severity filters remain prominent above the Back to exceptions action while the exception list itself is absent. This weakens the local hierarchy of the focused review state and consumes vertical space. In the detail-only composition, prioritize Back to exceptions directly after the page header and move filters back to the list view, or place them behind a supported secondary filter control if they must remain available.
- **low — desktop-0:** Critical and Warning rows use nearly identical neutral outlined pills and dots. Group headings and text labels preserve meaning, but severity is slower to distinguish when scanning individual cards. Use distinct supported StatusPill variants, icons, or short severity markers within the existing Arrusted palette; do not rely only on the status word and group position.
- **low — desktop-2:** After simulation, confirmation appears both as body copy and as a muted button whose label changes to “Simulated — no order sent.” A control-shaped confirmation can be mistaken for another available action or an unexplained disabled state. Keep the action label stable and present completion through the public Toast or StatusPill component, with the button disabled separately only if repeated simulation is intentionally unavailable.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/222) |
| desktop-0                | typography | 0/0                         | 0% (0/557) |
| desktop-0                | spacing    | 0/0                         | 0% (0/293) |
| desktop-0                | radius     | 0/0                         | 0% (0/114) |
| desktop-0                | border     | 0/0                         | 0% (0/139) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/222) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/557) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/293) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/114) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/139) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/222) |
| desktop-window-0         | typography | 0/0                         | 0% (0/557) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/293) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/114) |
| desktop-window-0         | border     | 0/0                         | 0% (0/139) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/222) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/564) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/295) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/114) |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/140) |
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

- No implementation-plan artifact was supplied, so its quality or completeness cannot be evaluated from the screenshots.
- Only the listed scripted interaction outcomes were observed; dropdown menus, keyboard flow, focus states, empty results, long product names, and error states were not shown.
- The 1024px captures indicate document heights up to 810px for a 768px viewport, but the exact scrolling experience was not demonstrated.
- Screenshots and static source evidence cannot establish backend behavior, persistence, or whether a real supplier order could be sent.
- Arrusted styling provenance is largely unassessed in the supplied evidence; palette and component observations are therefore visual rather than implementation-compliance claims.
