# stock-exceptions-calculation-disclosure — 2026-09-09T11:25:25.416Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 90/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.92%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 24         | 0             | 5          | 100% (24/24) |
| api       | 61         | 0             | 11         | 100% (61/61) |
| styling   | 13         | 0             | 4982       | 100% (13/13) |

Scores from different evaluator versions or captured states are not directly comparable.

This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 4/4   | The page title, filters, exception list, selected record identity, evidence, and replenishment action form a clear task sequence. Selection highlighting and prominent modeled quantities make the active item and outcome immediately scannable.                                                                                                                                |
| layout         | 3/4   | Alignment and spacing are consistently strong across the filter grid, list rows, detail fields, and quantity cards. The centered maximum-width composition remains readable at 1920px, though the isolated helper sentence between filters and list slightly weakens grouping.                                                                                                   |
| typography     | 4/4   | Product names, section headings, labels, values, and supporting copy use a consistent and readable scale. Large quantity values are appropriately emphasized, while status pills and secondary metadata remain subordinate without becoming difficult to read.                                                                                                                   |
| responsive     | 4/4   | The composition remains usable at 1920, 1440, and 1024px, then intentionally changes from list-detail to a focused detail view with a clear Back action at 700px. Controls remain visible, and expanded supplier or calculation content uses ordinary vertical document scrolling without horizontal overflow.                                                                   |
| productClarity | 3/4   | Location and severity filters, selectable exceptions, supplier details, mock confirmation, completed status, reset, and repeated simulation-only messaging clearly explain the workflow. One terminology inconsistency—showing 18 units as “Gross on-hand” in evidence but “Current on-hand” in the model while 12 units are reserved—can make the modeled basis less immediate. |

## Strengths

- The selected exception is unmistakable through row highlighting, repeated product identity, location, and severity.
- The replenishment flow clearly distinguishes review, confirmation, completion, and reset states while repeatedly stating that inventory is unchanged.
- Quantity cards make current stock, modeled addition, and projected stock easy to compare.
- Supplier facts and calculation derivation are progressively disclosed, keeping the default detail view concise while preserving supporting evidence.
- The constrained 700px desktop-panel treatment avoids squeezing both panes together and provides a clear return path to the exception list.
- The supplied states show consistent use of the existing Arrusted palette and familiar component variants without introducing competing visual conventions.

## Improvements

- **medium — desktop-1:** The modeled view labels 18 units as “Current on-hand,” while the evidence view calls the same value “Gross on-hand” and separately reports 12 reserved units. Because the calculation explanation is collapsed by default, a reviewer may initially interpret this as available stock rather than gross stock. Rename the metric to “Gross on-hand” throughout the modeled states. If reservation context is decision-critical, add a concise “12 reserved” supporting line using the existing quantity-card or detail-field composition rather than introducing new styling.
- **low — desktop-0:** The sentence “Review the selected exception or choose another” sits alone between the filter container and list card. It repeats the already-visible selected/list relationship and slightly interrupts the visual grouping of the left-pane controls. Move this guidance into the Exceptions card header as supporting text, or reserve the message for the constrained no-selection state where it provides more useful instruction.

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
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/142) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/297) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/166) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/71)  |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/79)  |
| desktop-custom-700x900-0 | shadow     | 0/0                         | 0% (0/75)  |

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

- The screenshots demonstrate only the supplied fixture states; location and severity filtering interactions were not run, so filtered, empty, and zero-result behavior cannot be assessed.
- A visual implementation-plan artifact is not shown, so the brief’s separate implementation-plan deliverable cannot be evaluated from these images.
- Static screenshots and recorded expected-text checks do not establish backend behavior, persistence, authorization, keyboard behavior, or complete component provenance.
- Expanded content was reviewed only at the supplied dimensions; additional intermediate desktop panel widths were not provided.
