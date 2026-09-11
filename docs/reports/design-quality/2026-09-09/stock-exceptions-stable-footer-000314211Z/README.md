# stock-exceptions-stable-footer — 2026-09-09T00:03:14.211Z

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
| hierarchy | 4/4 | The page establishes a clear sequence from title and review count to filters, severity-grouped products, selected-item details, and replenishment action. Selected rows, severity pills, cover values, section headings, and the suggested-order heading make priorities easy to scan. |
| layout | 3/4 | The two-column review composition is consistently aligned and comfortably dense at 1440px and 1920px, with related labels and values grouped well. The completed-action footer becomes slightly compressed at 1024px, where the confirmation wraps beside the button rather than forming a clean footer row. |
| typography | 4/4 | Heading sizes, bold product names, compact metadata, labels, and emphasized stock values form a consistent and readable type hierarchy. Longer delivery assumptions wrap cleanly without clipping in the supplied desktop widths. |
| responsive | 4/4 | The composition scales from a centered wide layout to a tighter 1024px split view, then deliberately switches at 700px from master-detail to separate list and detail views with a visible Back to exceptions control. Filters and primary actions remain usable, and only modest document scrolling is reported at some 1024px states. |
| productClarity | 4/4 | The interface directly supports filtering by location and severity, selecting an exception, reviewing stock or supplier details, and simulating replenishment. Copy such as Preview only · No supplier contacted and Order simulated. Stock levels are unchanged clearly distinguishes the mock action from a real order. |

## Strengths

- Severity grouping and ascending days-of-cover values make the most urgent products immediately discoverable.
- The selected product is reinforced through the row outline, radio state, and synchronized detail heading.
- Stock position and supplier details are separated without hiding the proposed order and delivery-risk explanation.
- The replenishment quantity is concrete and explained in supplier-pack terms, such as 3 packs of 8.
- The 700px desktop-panel treatment avoids squeezing both panes together and provides a clear return path.
- Filtered counts and product lists update coherently in the demonstrated filter state.
- Simulation feedback is persistent, explicit, and positioned next to the changed action state.

## Improvements

- **low — desktop-window-2:** In the simulated state, the confirmation message wraps into two lines while sharing a narrow footer row with the 204px action button. This makes the final status area look more compressed than the rest of the detail card. At this desktop width, place the confirmation on its own row above the disabled simulated-action button, or use a supported stacked footer composition while retaining the existing Button styling.
- **low — desktop-custom-700x900-3:** After filtering to one product, the group summary reads 0.4–0.4 days of cover. A repeated range is technically understandable but adds avoidable notation in an otherwise concise result. When the minimum and maximum are equal, render a single value such as 0.4 days of cover; retain the range presentation for groups containing different values.

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

- No implementation-plan artifact was supplied, so its quality and completeness cannot be assessed from these screenshots.
- The screenshots demonstrate a visual prototype and several passed interactions, but they do not establish backend behavior or real order processing.
- No desktop width narrower than 700px or alternate panel-height stress case was provided.
- Some initial interaction states were not run, and static JSX findings do not prove all dynamic branches rendered.
- Visual styling provenance and full cascade behavior remain uncertain from the supplied evidence and were not used as a design-quality score.
