# stock-exceptions-full-outcome — 2026-09-09T10:04:09.431Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 90/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.82%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 22         | 0             | 3          | 100% (22/22) |
| api       | 58         | 0             | 9          | 100% (58/58) |
| styling   | 13         | 0             | 4992       | 100% (13/13) |

Scores from different evaluator versions or captured states are not directly comparable.

This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension      | Score | Reason                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hierarchy      | 3/4   | The page title, filters, exception list, selected product, evidence, and replenishment action form a clear review sequence. Severity pills, selected-row treatment, and large modeled quantities support fast scanning, though the initial selected styling conflicts slightly with copy saying the item is only “ready to open.”                                    |
| layout         | 3/4   | The wide list-detail composition is consistently aligned and comfortably dense at 1024–1920 px, with clear card boundaries and orderly label-value columns. The constrained detail view is also usable, but its record header reserves noticeably more vertical space than its content and action require.                                                           |
| typography     | 4/4   | Type is highly readable and consistent across all captures: strong page and product headings, distinct section titles, compact field labels, and prominent modeled quantities. Product names, SKUs, locations, severity, and supporting explanations remain legible at every supplied desktop size.                                                                  |
| responsive     | 4/4   | The composition adapts successfully across the supplied 700, 1024, 1440, and 1920 px desktop windows. At 700 px it changes from list-detail to a focused detail view with a clear “Back to exceptions” control, while filters, action groups, quantity cards, and supplier facts remain usable without horizontal overflow.                                          |
| productClarity | 4/4   | The task is explicit: filter exceptions, inspect stock and supplier evidence, and try a replenishment simulation. The confirmation and result states clearly distinguish current, added, and projected quantities and repeatedly state that no order is placed or inventory changed; the only minor ambiguity is the default-highlight wording in the initial state. |

## Strengths

- Location and severity filters are placed before the exception list and use concise, domain-appropriate labels.
- Each exception exposes the product, SKU, location, shortage, severity, and days of cover without requiring the detail panel.
- Selected-record identity is repeated in the detail header, reducing the chance of acting on the wrong product.
- The replenishment flow gives unusually clear evidence for its calculation, including case rounding, supplier minimum, reserved units, and projected on-hand stock.
- The mock action has distinct review, confirmation, completed, and reset states, with explicit language that underlying inventory remains unchanged.
- Secondary supplier facts are progressively disclosed, keeping the default evidence view compact.
- The constrained desktop treatment preserves task context and supplies a visible route back to the exception list.
- The supplied captures report no accessibility violations, and tested mock-action and disclosure interactions passed.

## Improvements

- **medium — desktop-custom-700x900-0:** Atlas nitrile gloves uses the full selected-row highlight even though the constrained view has not opened its details. Combined with the nearby statement that the highlighted default is merely “ready to open,” the styling makes the current navigation state ambiguous. Reserve the selected treatment for a user-established selection, or revise the helper text to state that Atlas is the default selection and activating it opens the detail view.
- **low — desktop-0:** The helper says the highlighted default is “ready to open” and asks the user to select it, while the product’s detail is already visible in the adjacent panel. This introduces unnecessary uncertainty about whether the record is currently open. Use state-specific copy such as “Showing the default exception; select another exception to review it,” or defer the visible detail until the user establishes a selection.
- **low — desktop-custom-700x900-4:** The constrained record header leaves a large blank band between product identity and the replenishment action, pushing evidence lower despite ample horizontal room for a tighter wrapping arrangement. Tighten the header’s vertical spacing and place the action in a compact wrapping row immediately after the identity block while retaining the existing supported button treatment.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport                 | Category   | Token references / assessed | Coverage   |
| ------------------------ | ---------- | --------------------------- | ---------- |
| desktop-0                | color      | 0/0                         | 0% (0/233) |
| desktop-0                | typography | 0/0                         | 0% (0/522) |
| desktop-0                | spacing    | 0/0                         | 0% (0/275) |
| desktop-0                | radius     | 0/0                         | 0% (0/116) |
| desktop-0                | border     | 0/0                         | 0% (0/125) |
| desktop-0                | shadow     | 0/0                         | 0% (0/120) |
| desktop-wide-0           | color      | 0/0                         | 0% (0/233) |
| desktop-wide-0           | typography | 0/0                         | 0% (0/522) |
| desktop-wide-0           | spacing    | 0/0                         | 0% (0/275) |
| desktop-wide-0           | radius     | 0/0                         | 0% (0/116) |
| desktop-wide-0           | border     | 0/0                         | 0% (0/125) |
| desktop-wide-0           | shadow     | 0/0                         | 0% (0/120) |
| desktop-window-0         | color      | 0/0                         | 0% (0/233) |
| desktop-window-0         | typography | 0/0                         | 0% (0/522) |
| desktop-window-0         | spacing    | 0/0                         | 0% (0/275) |
| desktop-window-0         | radius     | 0/0                         | 0% (0/116) |
| desktop-window-0         | border     | 0/0                         | 0% (0/125) |
| desktop-window-0         | shadow     | 0/0                         | 0% (0/120) |
| desktop-custom-700x900-0 | color      | 0/0                         | 0% (0/141) |
| desktop-custom-700x900-0 | typography | 0/0                         | 0% (0/292) |
| desktop-custom-700x900-0 | spacing    | 0/0                         | 0% (0/164) |
| desktop-custom-700x900-0 | radius     | 0/0                         | 0% (0/70)  |
| desktop-custom-700x900-0 | border     | 0/0                         | 0% (0/78)  |
| desktop-custom-700x900-0 | shadow     | 0/0                         | 0% (0/74)  |

## Latest-run screenshots

### desktop-0 — initial

Interaction: not-run.

![desktop-0 initial](desktop-0.png)

### desktop-1 — Select record and review modeled quantity

Interaction: passed.

![desktop-1 Select record and review modeled quantity](desktop-1.png)

### desktop-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-2 Confirm modeled replenishment](desktop-2.png)

### desktop-3 — Read projected quantity

Interaction: passed.

![desktop-3 Read projected quantity](desktop-3.png)

### desktop-4 — Reset fixture result

Interaction: passed.

![desktop-4 Reset fixture result](desktop-4.png)

### desktop-5 — Read expanded supplier facts

Interaction: passed.

![desktop-5 Read expanded supplier facts](desktop-5.png)

### desktop-wide-0 — initial

Interaction: not-run.

![desktop-wide-0 initial](desktop-wide-0.png)

### desktop-wide-1 — Select record and review modeled quantity

Interaction: passed.

![desktop-wide-1 Select record and review modeled quantity](desktop-wide-1.png)

### desktop-wide-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-wide-2 Confirm modeled replenishment](desktop-wide-2.png)

### desktop-wide-3 — Read projected quantity

Interaction: passed.

![desktop-wide-3 Read projected quantity](desktop-wide-3.png)

### desktop-wide-4 — Reset fixture result

Interaction: passed.

![desktop-wide-4 Reset fixture result](desktop-wide-4.png)

### desktop-wide-5 — Read expanded supplier facts

Interaction: passed.

![desktop-wide-5 Read expanded supplier facts](desktop-wide-5.png)

### desktop-window-0 — initial

Interaction: not-run.

![desktop-window-0 initial](desktop-window-0.png)

### desktop-window-1 — Select record and review modeled quantity

Interaction: passed.

![desktop-window-1 Select record and review modeled quantity](desktop-window-1.png)

### desktop-window-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-window-2 Confirm modeled replenishment](desktop-window-2.png)

### desktop-window-3 — Read projected quantity

Interaction: passed.

![desktop-window-3 Read projected quantity](desktop-window-3.png)

### desktop-window-4 — Reset fixture result

Interaction: passed.

![desktop-window-4 Reset fixture result](desktop-window-4.png)

### desktop-window-5 — Read expanded supplier facts

Interaction: passed.

![desktop-window-5 Read expanded supplier facts](desktop-window-5.png)

### desktop-custom-700x900-0 — initial

Interaction: not-run.

![desktop-custom-700x900-0 initial](desktop-custom-700x900-0.png)

### desktop-custom-700x900-1 — Select record and review modeled quantity

Interaction: passed.

![desktop-custom-700x900-1 Select record and review modeled quantity](desktop-custom-700x900-1.png)

### desktop-custom-700x900-2 — Confirm modeled replenishment

Interaction: passed.

![desktop-custom-700x900-2 Confirm modeled replenishment](desktop-custom-700x900-2.png)

### desktop-custom-700x900-3 — Read projected quantity

Interaction: passed.

![desktop-custom-700x900-3 Read projected quantity](desktop-custom-700x900-3.png)

### desktop-custom-700x900-4 — Reset fixture result

Interaction: passed.

![desktop-custom-700x900-4 Reset fixture result](desktop-custom-700x900-4.png)

### desktop-custom-700x900-5 — Read expanded supplier facts

Interaction: passed.

![desktop-custom-700x900-5 Read expanded supplier facts](desktop-custom-700x900-5.png)

## Limitations

- Only the supplied states and window sizes were assessed; no desktop width below 700 px or intermediate panel width was shown.
- Filter changes, zero-result behavior, selection of other products, keyboard focus appearance, and error or loading states were not demonstrated.
- Interaction evidence supports the shown mock flow and disclosure only; it does not establish backend behavior, persistence, or authorization.
- No implementation-plan artifact was visible in the supplied images, so its quality and completeness could not be assessed.
- Static and source evidence cannot prove that every dynamically reachable component rendered in all states.
- The styling-adherence evidence had very low assessed coverage, so no broader palette or token conclusion was inferred from it.
