# stock-exceptions-settled-evidence — 2026-09-09T00:15:48.602Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 95/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.77%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 31         | 0             | 3          | 100% (31/31) |
| api       | 52         | 0             | 7          | 100% (52/52) |
| styling   | 19         | 0             | 5637       | 100% (19/19) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 3/4   | The page establishes a strong sequence from title and filters to severity-grouped exceptions, selected record, suggested order, and action. Selection outlines and bold cover values scan well, though delivery-risk assessments such as the 1.9-day gap rely mainly on bold neutral text and could stand out more clearly.                                 |
| layout         | 4/4   | Alignment is disciplined across the filter row, grouped record cards, and detail panel. The centered maximum-width composition remains balanced at 1920px, while the 1024px view uses available space efficiently without overlap; spacing within detail sections and footer actions is consistently structured.                                            |
| typography     | 4/4   | Heading levels, labels, values, and explanatory copy are visually consistent and readable across all supplied sizes. Product names and suggested quantities receive appropriate emphasis, while compact secondary text remains legible without competing with primary information.                                                                          |
| responsive     | 4/4   | The composition adapts effectively from a side-by-side master/detail workspace at 1024–1920px to dedicated list and detail views at 700px. Filters, tabs, detail fields, navigation, and mock-action controls remain visible and usable; the 1024px initial state requires only a small amount of document scrolling.                                       |
| productClarity | 4/4   | The workflow is immediately understandable: filter by location and severity, choose an exception, inspect stock or supplier information, and simulate a suggested replenishment. Quantity rationale, delivery assumptions, preview-only language, and the post-action “Stock unchanged” confirmation clearly distinguish the mock action from a real order. |

## Strengths

- Severity grouping, cover ranges, status pills, and lowest-cover ordering make exception priority easy to scan.
- Selected records are clearly connected to the corresponding detail content through a visible outline, filled selector, matching product name, location, severity, and cover.
- The detail view exposes both stock position and supplier details without overwhelming the initial view.
- Suggested quantities are explained in supplier-pack terms, making the recommendation more credible and operationally useful.
- Risk messaging changes appropriately between a delivery gap and delivery fitting current cover.
- The simulated state explicitly states that no order was sent and that stock remains unchanged.
- The 700px desktop-panel treatment provides an explicit “Back to exceptions” control rather than compressing both panes into an unusable split.
- The supplied interaction evidence confirms representative filtering, selection, tab switching, delivery-assumption review, and mock replenishment states.

## Improvements

- **medium — desktop-1:** The operationally important “Standard delivery leaves a 1.9-day gap” assessment is presented as another bold text line. It is readable, but its urgency is weaker than the surrounding product and suggested-order headings, so a reviewer scanning the panel may not notice the projected stockout before the action. Place a supported StatusPill or Tag such as “1.9-day arrival gap” beside the suggested-order heading or immediately before the assessment, retaining the existing Arrusted warning variant and palette.
- **low — desktop-0:** The selected exception’s severity and cover are repeated in the group heading, selected row, and detail header within a short visual span. The repetition supports context, especially in the narrow detail view, but adds some noise in the simultaneous desktop master/detail composition. In the two-pane composition, reduce one redundant status presentation—for example, keep the group heading and detail status while making the selected row’s pill secondary or omitting it when the group already fixes severity. Preserve the full context in the standalone 700px detail view.
- **low — desktop-window-0:** At the 1024×768 captured viewport, the final exception row extends into the small document overflow, producing about 24px of page scrolling. The interface remains usable and the replenishment action is still visible, but the bottom record is less immediately available in shorter desktop windows. For shorter desktop windows, slightly tighten vertical gaps between record cards or make the exception list an explicit bounded scroll region while keeping the detail action visible. Avoid changing control styling or palette.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/227) |
| desktop-0                | typography | 0/0                         | 0% (0/557) |
| desktop-0                | spacing    | 0/0                         | 0% (0/299) |
| desktop-0                | radius     | 0/0                         | 0% (0/114) |
| desktop-0                | border     | 0/0                         | 0% (0/137) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/227) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/557) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/299) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/114) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/137) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/227) |
| desktop-window-0         | typography | 0/0                         | 0% (0/557) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/299) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/114) |
| desktop-window-0         | border     | 0/0                         | 0% (0/137) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/198) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/489) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/265) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/99)  |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/119) |
| desktop-custom-700x900-0 | shadow     | 0/0                         | 0% (0/105) |

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

- No open select menus, keyboard focus states, hover states, no-result filter state, or error state are shown, so those visual states were not assessed.
- The narrowest supplied desktop panel is 700px; behavior in smaller desktop panels is unknown.
- Screenshots and static evidence cannot establish real inventory or supplier backend behavior, persistence of filter state after returning from detail, or whether a real order could be sent.
- The requested implementation plan is not visible in the supplied captures, so its completeness and presentation cannot be evaluated.
- Arrusted component and token provenance cannot be fully verified from the screenshots; the supplied static adherence evidence is conservative and leaves most rendered styling unassessed.
