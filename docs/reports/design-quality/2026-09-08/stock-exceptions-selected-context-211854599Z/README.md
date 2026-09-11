# stock-exceptions-selected-context — 2026-09-08T21:18:54.599Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 85/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.59%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 28         | 0             | 4          | 100% (28/28) |
| api       | 48         | 0             | 8          | 100% (48/48) |
| styling   | 18         | 0             | 5808       | 100% (18/18) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension | Score | Reason |
| --- | --- | --- |
| hierarchy | 4/4 | The page establishes a strong sequence from title and review count to filters, severity-grouped products, selected-item details, and the replenishment action. Selection highlighting and right-aligned cover values make urgent records easy to scan. |
| layout | 3/4 | The two-column master-detail composition is consistently aligned and balanced at 900, 1024, 1440, and 1920px widths. However, the relatively tall product cards make a six-item list extend beyond a 768px-high desktop viewport, adding scrolling for a small result set. |
| typography | 4/4 | Heading levels, labels, product names, secondary metadata, and bold numeric values are readable and visually consistent. Supplier guidance and simulation feedback are clearly separated from ordinary field values. |
| responsive | 3/4 | The side-by-side workflow remains usable without visible clipping at the supplied 900px and 1024px windows, and the filters and detail actions resize appropriately. At 1024×768 the document grows to 850px, and no captures below 900px or independently resized panels were supplied. |
| productClarity | 3/4 | Location and severity filters, urgency grouping, item selection, stock and supplier tabs, suggested quantities, and the explicitly mock action are understandable. The successful state clearly says no order was sent, but the replenishment CTA does not state its delivery assumption when supplier lead time exceeds available cover. |

## Strengths

- Clear master-detail workflow keeps exception selection and review context visible together.
- Products are grouped by severity and ordered by cover, with location and cover visible directly in every row.
- Selected records are strongly differentiated without disrupting the established Arrusted palette.
- Stock and supplier views expose concise, task-relevant information rather than overwhelming the user.
- Mock-action language is responsible and explicit: “Preview only · No supplier contacted” and “Simulated — no order sent.”
- Captured interactions demonstrate filtering, record selection, supplier inspection, delivery guidance, and simulation feedback across several desktop sizes.

## Improvements

- **medium — desktop-window-0:** Six records consume nearly the full 850px document height, and the measured 1024×768 viewport requires page scrolling even though the result set is small. This reduces operational scan density. Use a supported compact composition or reduce redundant vertical spacing within each record while retaining product, location, severity, and cover. Consider making the result region independently scrollable if longer lists are expected.
- **medium — desktop-1:** The supplier view warns of a 1.9-day delivery gap, but the primary action still reads only “Simulate 24-unit order.” It is unclear whether the simulation assumes standard or expedited delivery, which matters to the replenishment decision. Add a concise delivery assumption beside the action or in the simulated result, such as “Standard delivery: stockout projected” or an expedited-delivery option using supported controls.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport | Category | Token references / assessed | Coverage |
| --- | --- | --- | --- |
| desktop-0 | color | 0/0 | 0% (0/221) |
| desktop-0 | typography | 0/0 | 0% (0/557) |
| desktop-0 | spacing | 0/0 | 0% (0/298) |
| desktop-0 | radius | 0/0 | 0% (0/114) |
| desktop-0 | border | 0/0 | 0% (0/142) |
| desktop-0 | shadow | 0/0 | 0% (0/120) |
| desktop-wide-0 | color | 0/0 | 0% (0/221) |
| desktop-wide-0 | typography | 0/0 | 0% (0/557) |
| desktop-wide-0 | spacing | 0/0 | 0% (0/298) |
| desktop-wide-0 | radius | 0/0 | 0% (0/114) |
| desktop-wide-0 | border | 0/0 | 0% (0/142) |
| desktop-wide-0 | shadow | 0/0 | 0% (0/120) |
| desktop-window-0 | color | 0/0 | 0% (0/221) |
| desktop-window-0 | typography | 0/0 | 0% (0/557) |
| desktop-window-0 | spacing | 0/0 | 0% (0/298) |
| desktop-window-0 | radius | 0/0 | 0% (0/114) |
| desktop-window-0 | border | 0/0 | 0% (0/142) |
| desktop-window-0 | shadow | 0/0 | 0% (0/120) |
| desktop-custom-900x900-0 | color | 0/0 | 0% (0/221) |
| desktop-custom-900x900-0 | typography | 0/0 | 0% (0/557) |
| desktop-custom-900x900-0 | spacing | 0/0 | 0% (0/298) |
| desktop-custom-900x900-0 | radius | 0/0 | 0% (0/114) |
| desktop-custom-900x900-0 | border | 0/0 | 0% (0/142) |
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

- No implementation-plan artifact was provided, so the brief’s planning deliverable cannot be assessed from these screenshots.
- Captures cover desktop widths of 900px and above; narrower windows and independently resized split panels were not shown.
- Dropdown menus, keyboard behavior, loading and empty states, long product or supplier names, and larger result sets were not visually tested.
- The supplied interaction evidence confirms selected text changes only; screenshots do not establish backend behavior or publication status.
- Static source and adherence evidence cannot prove that every referenced public component or dynamic branch rendered in each capture.
