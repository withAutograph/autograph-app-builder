# stock-exceptions-shared-tags — 2026-09-08T23:53:50.250Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 95/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.71%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 30         | 0             | 3          | 100% (30/30) |
| api       | 52         | 0             | 7          | 100% (52/52) |
| styling   | 16         | 0             | 5637       | 100% (16/16) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension | Score | Reason |
| --- | --- | --- |
| hierarchy | 4/4 | The page establishes a clear sequence from title and review count, through location/severity filters, grouped exceptions, selected record, supporting details, and the replenishment action. Severity groups, bold cover values, selection treatment, and the prominent suggested-order heading make priorities easy to scan. |
| layout | 3/4 | Alignment and spacing are consistently handled across the filter row, exception cards, and detail panel, with an effective two-column review layout at 1024–1920 px. The detail panel becomes somewhat horizontally sparse at wide sizes, with labels and values separated by long distances, but remains orderly and usable. |
| typography | 4/4 | Type sizes, weights, and line lengths are highly consistent. Product names, group headings, stock values, recommendation headings, explanatory copy, and status labels are readily distinguishable, while wrapped text at 1024 px remains readable. |
| responsive | 4/4 | The composition adapts effectively across the supplied desktop widths: it retains master-detail review at 1024 px and above, then switches to a focused list/detail flow with a clear Back to exceptions control at 700 px. Filters and actions remain fully visible, and the only measured overflow at 1024 px is a small 24 px document-height extension rather than a blocked control. |
| productClarity | 4/4 | The interface directly supports the brief: users can filter by location and severity, select low-stock products, switch between stock and supplier information, understand delivery-cover implications, and run an explicitly labeled mock replenishment. Preview language and the post-action message clearly state that no real order was sent and stock levels are unchanged. |

## Strengths

- The exception list is ordered and grouped by severity, with cover ranges and per-item cover values supporting rapid triage.
- Selected records are visibly connected to the adjacent detail panel through a consistent outlined and tinted selection state.
- Stock position and supplier details are separated without hiding the suggested order or mock-action context.
- The mock action communicates quantity in the button label and explains pack assumptions, delivery timing, and potential stockout risk before action.
- Filtered results update the review count and group count, preserving orientation in reduced-result states.
- The 700 px desktop-panel treatment appropriately replaces the compressed split view with a drill-in flow rather than forcing both panes into insufficient space.
- No accessibility violations were reported in the supplied captures, and the tested selection, filtering, tab, delivery-message, and simulation states passed their expected-text checks.

## Improvements

- **low — desktop-wide-1:** On the widest capture, the detail panel uses a broad label/value layout that creates long horizontal eye travel between fields such as Supplier, Lead time, and Order pack. The panel remains clear, but the information density is lower than the exception list beside it. Constrain the detail field rows to a comfortable reading width within the existing panel, or arrange related facts in a compact supported record-detail composition while leaving the action aligned to the panel edge.
- **low — desktop-2:** After simulation, confirmation is split between a bold sentence in the content area and a muted, disabled-looking button at the far right. The meaning is understandable, but the two signals feel visually disconnected and the button treatment can initially read as merely unavailable rather than completed. Group the completion message and action state more tightly, for example by placing a supported StatusPill or toast-style confirmation near the button while retaining the explicit “no order sent” and unchanged-stock language.
- **low — desktop-window-0:** At the 1024 px window, the detail panel remains usable, but explanatory sentences wrap while the action is anchored to the lower-right, leaving an uneven text-and-action rhythm compared with the roomier captures. At this intermediate desktop width, place the action in a dedicated footer row beneath the explanatory copy, or allow it to align with the text column, so wrapping does not visually separate the action from its assumptions.

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

- Only static screenshots and reported expected-text interactions were supplied; dropdown menus, keyboard navigation, focus behavior, loading, empty, error, and longer-data states were not shown.
- The initial interaction was not run in several capture sets, so whole-row selection behavior beyond the reported scripted states is not independently established.
- The requested implementation plan is not visible in the supplied product captures and therefore cannot be evaluated.
- The reported component and API checks are static evidence with some dynamic props and branches unassessed; they do not prove every public component rendered.
- Styling adherence evidence has very low assessed coverage and cannot support a broad conclusion about token usage, although the visible palette appears internally consistent with the supplied Arrusted presentation.
