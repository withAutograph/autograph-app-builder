# stock-exceptions-explained-addition — 2026-09-09T12:39:10.739Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 95/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.88%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 23         | 0             | 5          | 100% (23/23) |
| api       | 60         | 0             | 12         | 100% (60/60) |
| styling   | 13         | 0             | 4995       | 100% (13/13) |

Scores from different evaluator versions or captured states are not directly comparable.

This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 4/4   | The page establishes a clear sequence from title and filters to exception selection and record evidence. Selected rows are strongly differentiated, severity and days-of-cover remain easy to scan, and the replenishment review elevates the modeled quantities and projected result appropriately.                                                                       |
| layout         | 3/4   | Alignment, card boundaries, label-value columns, and list density are consistently strong from 1024px through 1920px. The 700px detail mode also avoids crowding, though its header action wraps into a relatively tall open row and the expanded calculation stack uses more vertical space than necessary.                                                               |
| typography     | 4/4   | Heading sizes, bold labels, body copy, numeric emphasis, and status text form a consistent and readable system. Large quantities such as “114 units” receive appropriate emphasis without competing with record identity or action labels.                                                                                                                                 |
| responsive     | 4/4   | The composition adapts effectively across the supplied desktop sizes: wide and 1024px windows retain an efficient list-detail view, while the 700px panel defers detail until selection and provides a clear “Back to exceptions” control. No clipping or horizontal overflow is visible, and expanded sections remain usable through normal document scrolling.           |
| productClarity | 4/4   | Location and severity filters are explicit, every exception exposes product, location, deficit, severity, and cover, and detail views provide stock and supplier facts. The mock flow clearly previews gross stock, modeled addition, projected stock, supplier minimum reasoning, cancellation, confirmation, reset, and repeated assurances that inventory is unchanged. |

## Strengths

- Selected-record styling connects the exception list to the detail panel without overwhelming the severity information.
- The interface explains the calculation basis, including gross on-hand, reserved stock, case rounding, and supplier minimums.
- The mock action has a clear review state, explicit quantity in the confirmation label, completed state, and reset path.
- Supplier facts are progressively disclosed, keeping routine evidence concise while retaining access to purchasing details.
- The constrained desktop composition appropriately changes from simultaneous list-detail to a focused detail view with back navigation.
- The existing palette is used coherently for primary actions, selection, severity, and neutral completion status.

## Improvements

- **low — desktop-custom-700x900-4:** In the constrained detail header, the replenishment action occupies a separate right-aligned row with substantial unused space to its left. This makes the header taller and pushes the stock evidence lower than necessary. Use the supported wrapping header-action composition with tighter spacing between identity and the action row, allowing the action to remain beside the identity when it fits and wrap compactly only when needed.
- **low — desktop-custom-700x900-6:** The expanded calculation presents each short fact as a full-width vertical block with generous gaps, producing a long section and extending the document beyond the original 900px viewport. Keep the disclosure but use compact inline read-only label/value fields or a two-column detail grid where panel width permits, reverting to a tighter single-column stack only when required.
- **low — desktop-2:** “Mock completed” and “Modeled replenishment complete” can momentarily sound like an operational replenishment was executed, although the nearby simulation copy correctly clarifies that stock was unchanged. Use result-oriented wording such as “Mock result ready” and “Modeled replenishment result,” while retaining the existing unchanged-inventory explanation and reset action.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/233) |
| desktop-0                | typography | 0/0                         | 0% (0/522) |
| desktop-0                | spacing    | 0/0                         | 0% (0/267) |
| desktop-0                | radius     | 0/0                         | 0% (0/116) |
| desktop-0                | border     | 0/0                         | 0% (0/126) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/233) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/522) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/267) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/116) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/126) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/233) |
| desktop-window-0         | typography | 0/0                         | 0% (0/522) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/267) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/116) |
| desktop-window-0         | border     | 0/0                         | 0% (0/126) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/144) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/302) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/169) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/72)  |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/80)  |
| desktop-custom-700x900-0 | shadow     | 0/0                         | 0% (0/76)  |

## Latest-run screenshots

### desktop-0 — initial

Interaction: not-run.

![desktop-0 initial](desktop-0.png)

### desktop-1 — Review modeled quantity

Interaction: passed.

![desktop-1 Review modeled quantity](desktop-1.png)

### desktop-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-2 Confirm modeled replenishment](desktop-2.png)

### desktop-3 — Read projected quantity

Interaction: passed.

![desktop-3 Read projected quantity](desktop-3.png)

### desktop-4 — Reset fixture result

Interaction: passed.

![desktop-4 Reset fixture result](desktop-4.png)

### desktop-5 — Inspect supplier facts

Interaction: passed.

![desktop-5 Inspect supplier facts](desktop-5.png)

### desktop-6 — Expand confirmation derivation

Interaction: passed.

![desktop-6 Expand confirmation derivation](desktop-6.png)

### desktop-7 — Expand completed derivation

Interaction: passed.

![desktop-7 Expand completed derivation](desktop-7.png)

### desktop-wide-0 — initial

Interaction: not-run.

![desktop-wide-0 initial](desktop-wide-0.png)

### desktop-wide-1 — Review modeled quantity

Interaction: passed.

![desktop-wide-1 Review modeled quantity](desktop-wide-1.png)

### desktop-wide-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-wide-2 Confirm modeled replenishment](desktop-wide-2.png)

### desktop-wide-3 — Read projected quantity

Interaction: passed.

![desktop-wide-3 Read projected quantity](desktop-wide-3.png)

### desktop-wide-4 — Reset fixture result

Interaction: passed.

![desktop-wide-4 Reset fixture result](desktop-wide-4.png)

### desktop-wide-5 — Inspect supplier facts

Interaction: passed.

![desktop-wide-5 Inspect supplier facts](desktop-wide-5.png)

### desktop-wide-6 — Expand confirmation derivation

Interaction: passed.

![desktop-wide-6 Expand confirmation derivation](desktop-wide-6.png)

### desktop-wide-7 — Expand completed derivation

Interaction: passed.

![desktop-wide-7 Expand completed derivation](desktop-wide-7.png)

### desktop-window-0 — initial

Interaction: not-run.

![desktop-window-0 initial](desktop-window-0.png)

### desktop-window-1 — Review modeled quantity

Interaction: passed.

![desktop-window-1 Review modeled quantity](desktop-window-1.png)

### desktop-window-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-window-2 Confirm modeled replenishment](desktop-window-2.png)

### desktop-window-3 — Read projected quantity

Interaction: passed.

![desktop-window-3 Read projected quantity](desktop-window-3.png)

### desktop-window-4 — Reset fixture result

Interaction: passed.

![desktop-window-4 Reset fixture result](desktop-window-4.png)

### desktop-window-5 — Inspect supplier facts

Interaction: passed.

![desktop-window-5 Inspect supplier facts](desktop-window-5.png)

### desktop-window-6 — Expand confirmation derivation

Interaction: passed.

![desktop-window-6 Expand confirmation derivation](desktop-window-6.png)

### desktop-window-7 — Expand completed derivation

Interaction: passed.

![desktop-window-7 Expand completed derivation](desktop-window-7.png)

### desktop-custom-700x900-0 — initial

Interaction: not-run.

![desktop-custom-700x900-0 initial](desktop-custom-700x900-0.png)

### desktop-custom-700x900-1 — Review modeled quantity

Interaction: passed.

![desktop-custom-700x900-1 Review modeled quantity](desktop-custom-700x900-1.png)

### desktop-custom-700x900-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-custom-700x900-2 Confirm modeled replenishment](desktop-custom-700x900-2.png)

### desktop-custom-700x900-3 — Read projected quantity

Interaction: passed.

![desktop-custom-700x900-3 Read projected quantity](desktop-custom-700x900-3.png)

### desktop-custom-700x900-4 — Reset fixture result

Interaction: passed.

![desktop-custom-700x900-4 Reset fixture result](desktop-custom-700x900-4.png)

### desktop-custom-700x900-5 — Inspect supplier facts

Interaction: passed.

![desktop-custom-700x900-5 Inspect supplier facts](desktop-custom-700x900-5.png)

### desktop-custom-700x900-6 — Expand confirmation derivation

Interaction: passed.

![desktop-custom-700x900-6 Expand confirmation derivation](desktop-custom-700x900-6.png)

### desktop-custom-700x900-7 — Expand completed derivation

Interaction: passed.

![desktop-custom-700x900-7 Expand completed derivation](desktop-custom-700x900-7.png)

## Limitations

- Closed filter controls are visible, but filtered result, empty-result, and filter-reset states were not shown or tested.
- The supplied interaction evidence covers the mock replenishment and disclosures, but does not establish backend behavior or persistence.
- No implementation-plan artifact was provided for review; this assessment covers the visual product interface only.
- Static screenshots do not expose focus, hover, keyboard traversal, loading, or error states.
