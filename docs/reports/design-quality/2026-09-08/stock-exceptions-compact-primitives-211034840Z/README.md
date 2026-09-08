# stock-exceptions-compact-primitives — 2026-09-08T21:10:34.840Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 85/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.4%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 24         | 0             | 4          | 100% (24/24) |
| api       | 42         | 0             | 6          | 100% (42/42) |
| styling   | 17         | 0             | 5816       | 100% (17/17) |

Scores from different evaluator versions or captured states are not directly comparable.

This is the saved component-backed preview, not a new generation or a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 3/4   | The page establishes a clear title, filter area, severity-grouped exception list, selected-row treatment, and adjacent detail panel. Lowest-cover ordering and bold stock values support fast triage, though nearly identical Critical and Warning pills reduce visual differentiation and the detail header does not repeat urgency context.                                                                                                           |
| layout         | 4/4   | Alignment and spacing are consistently handled across 900, 1024, 1440, and 1920 px captures. The master-detail composition remains balanced, filters align with the list they affect, all six records fit comfortably at most tested heights, and the centered maximum-width treatment prevents excessive stretching on wide windows.                                                                                                                   |
| typography     | 3/4   | Product names, group headings, labels, values, and supporting text use a consistent and readable typographic hierarchy. Bold values and delivery guidance are easy to scan, although the small, visually similar severity pills rely heavily on their text labels.                                                                                                                                                                                      |
| responsive     | 3/4   | Across the supplied desktop widths, controls remain usable without horizontal overflow, the two-column composition contracts cleanly from 1920 to 900 px, and the 1024×768 state uses ordinary document scrolling when needed. No narrower or phone capture was supplied, so the brief's phone layout cannot be assessed.                                                                                                                               |
| productClarity | 4/4   | The workflow is immediately understandable: filter by location and severity, select an exception, switch between stock and supplier information, and simulate the suggested order. Quantity-specific action labels, delivery-gap guidance, and explicit confirmation that no order was sent make the mock nature of the action clear; only the introductory phrase 'review and replenish' is slightly less precise than the actual simulation behavior. |

## Strengths

- Exception records are ordered and grouped by severity while also exposing days of cover, giving the inventory team useful triage information at a glance.
- The selected state is unmistakable through the bordered, tinted row and filled selection indicator.
- Stock and supplier tabs separate related information without overwhelming the detail panel.
- Supplier views add decision support such as lead time, order pack, delivery gap, and whether standard delivery fits current cover.
- The mock action is safely communicated before and after activation with 'Preview only,' 'No supplier contacted,' and 'Stock levels are unchanged.'
- Filtered results update both the result count and severity-group count, preserving context after filtering.
- The composition remains stable and legible across all supplied desktop window sizes.

## Improvements

- **low — desktop-0:** Critical and Warning pills use almost the same neutral visual treatment. Group headings and text labels preserve meaning, but the repeated pill column is slower to scan than it could be for urgency. Use supported StatusPill variants or an additional icon/text treatment to strengthen semantic differentiation while retaining the authoritative Arrusted palette.
- **low — desktop-1:** The detail header identifies the selected product and location but omits its Warning status and 2.1-day cover. That urgency context remains visible only in the adjacent list while the reviewer is concentrating on supplier information. Repeat the selected item's severity pill and current cover in the detail header, using existing StatusPill or Tag variants, so the decision context travels with both tabs.
- **low — desktop-0:** The introductory instruction says users can 'review and replenish,' while the available action is explicitly a simulation that sends no order. Later copy resolves this safely, but the opening promise is slightly inconsistent. Change the instruction to 'Select a product to review and simulate replenishment' so the page purpose is precise from the outset.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/221) |
| desktop-0                | typography | 0/0                         | 0% (0/557) |
| desktop-0                | spacing    | 0/0                         | 0% (0/299) |
| desktop-0                | radius     | 0/0                         | 0% (0/114) |
| desktop-0                | border     | 0/0                         | 0% (0/143) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/221) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/557) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/299) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/114) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/143) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/221) |
| desktop-window-0         | typography | 0/0                         | 0% (0/557) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/299) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/114) |
| desktop-window-0         | border     | 0/0                         | 0% (0/143) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-900x900-0 | color      | 0/0                         | 0% (0/221) |
| desktop-custom-900x900-0 | typography | 0/0                         | 0% (0/557) |
| desktop-custom-900x900-0 | spacing    | 0/0                         | 0% (0/299) |
| desktop-custom-900x900-0 | radius     | 0/0                         | 0% (0/114) |
| desktop-custom-900x900-0 | border     | 0/0                         | 0% (0/143) |
| desktop-custom-900x900-0 | shadow     | 0/0                         | 0% (0/120) |

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

- No phone or narrower-window screenshots were provided, so phone usability requested in the brief cannot be verified visually.
- The supplied captures demonstrate several selected, filtered, supplier, and simulated states, but do not show open select menus, empty results, long product names, error states, or keyboard focus behavior.
- Initial-state interaction was not run, while the other documented scenarios passed their expected-text checks; screenshots do not prove complete backend or interaction behavior.
- No implementation-plan artifact was supplied, so its completeness cannot be assessed from the visual captures.
- Static source and adherence evidence cannot prove that every dynamic JSX branch rendered, and the styling assessment has very limited coverage.
