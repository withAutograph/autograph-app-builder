# stock-exceptions-header-actions — 2026-09-09T09:54:32.378Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 80/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.83%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 22         | 0             | 3          | 100% (22/22) |
| api       | 58         | 0             | 9          | 100% (58/58) |
| styling   | 13         | 0             | 4989       | 100% (13/13) |

Scores from different evaluator versions or captured states are not directly comparable.

This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension | Score | Reason |
| --- | --- | --- |
| hierarchy | 3/4 | The page title, filters, exception list, selected-record identity, and detail sections form a strong review sequence. Severity pills and selected-row treatment aid scanning, while the modeled quantities are prominent. The projected result, however, has the same card weight as its inputs and becomes an isolated third card, so the most consequential number is not quite dominant. |
| layout | 3/4 | The two-pane composition is cleanly aligned with consistent card boundaries, row spacing, and label/value columns. It remains comfortably centered at 1920px and dense but usable at 1024px. The confirmation header becomes crowded at 1024px, forcing the product title onto an awkward second line, and the 2+1 metric grid leaves the result visually detached. |
| typography | 3/4 | Typography is highly consistent: clear page and section headings, readable metadata, bold exception names, and appropriately enlarged modeled quantities. The isolated “M” line in the 1024px confirmation header disrupts reading, but otherwise labels and supporting explanations remain legible across the supplied sizes. |
| responsive | 3/4 | The design adapts well from 1920px to 1024px and switches to a focused list-or-detail flow with a clear Back control at 700px. Controls remain usable and no horizontal overflow is reported. The 1024px action/header collision shows that panel-width responsiveness needs one earlier composition change, and no windows narrower than 700px were provided. |
| productClarity | 4/4 | The task is immediately understandable: filter by location and severity, choose an exception, inspect stock and supplier evidence, and try a clearly labeled mock replenishment. Confirmation and completed states explicitly state that no order is placed and inventory remains unchanged, while the quantity calculation and supplier minimum are explained. The only minor ambiguity is that the constrained initial list visually highlights a record while withholding its detail until activation. |

## Strengths

- The primary workflow is complete and easy to follow from filtering through record review, supplier disclosure, mock confirmation, completion, and reset.
- Severity, stock gap, days of cover, SKU, and location are exposed directly in each list row, supporting quick comparison without opening every record.
- Selected-record identity persists beside the action state, reducing the risk of modeling replenishment for the wrong product.
- The simulation language is unusually clear: both pre-confirmation and completed states explicitly distinguish the mock from a real order.
- The 700px composition appropriately replaces the split view with a focused detail view and an explicit Back to exceptions control.
- Expanded supplier facts include operationally relevant case pack, receipt, contact, and minimum-order information.

## Improvements

- **medium — desktop-window-1:** At the 1024px window, the record title competes with the Cancel and Confirm actions, leaving “M” alone on a second line. This weakens the record header and makes the otherwise polished panel look crowded. Switch the detail header to a stacked title-and-actions arrangement at this panel width, or place the action group on a second header row while retaining the existing supported Button variants.
- **low — desktop-wide-1:** Current on-hand and modeled addition fill the first row, while the more important projected on-hand result sits alone in a same-weight card below. The empty half-row and equal emphasis make the outcome feel secondary to its inputs. Make projected on-hand span the available second row or otherwise give it clearer positional emphasis within the same supported KPI/card composition; keep current and addition grouped as supporting inputs.
- **low — desktop-custom-700x900-0:** The Atlas row already carries the selected background and accent bar, but the constrained initial state shows only the list and requires another activation before revealing detail. The highlight can imply that the currently selected record is already open or reviewed. In the deferred constrained state, avoid presenting a row as established selection until the user activates it, or add concise copy that the highlighted default is ready to open.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport | Category | Token references / assessed | Coverage |
| --- | --- | --- | --- |
| desktop-0 | color | 0/0 | 0% (0/233) |
| desktop-0 | typography | 0/0 | 0% (0/522) |
| desktop-0 | spacing | 0/0 | 0% (0/274) |
| desktop-0 | radius | 0/0 | 0% (0/116) |
| desktop-0 | border | 0/0 | 0% (0/125) |
| desktop-0 | shadow | 0/0 | 0% (0/120) |
| desktop-wide-0 | color | 0/0 | 0% (0/233) |
| desktop-wide-0 | typography | 0/0 | 0% (0/522) |
| desktop-wide-0 | spacing | 0/0 | 0% (0/274) |
| desktop-wide-0 | radius | 0/0 | 0% (0/116) |
| desktop-wide-0 | border | 0/0 | 0% (0/125) |
| desktop-wide-0 | shadow | 0/0 | 0% (0/120) |
| desktop-window-0 | color | 0/0 | 0% (0/233) |
| desktop-window-0 | typography | 0/0 | 0% (0/522) |
| desktop-window-0 | spacing | 0/0 | 0% (0/274) |
| desktop-window-0 | radius | 0/0 | 0% (0/116) |
| desktop-window-0 | border | 0/0 | 0% (0/125) |
| desktop-window-0 | shadow | 0/0 | 0% (0/120) |
| desktop-custom-700x900-0 | color | 0/0 | 0% (0/141) |
| desktop-custom-700x900-0 | typography | 0/0 | 0% (0/292) |
| desktop-custom-700x900-0 | spacing | 0/0 | 0% (0/164) |
| desktop-custom-700x900-0 | radius | 0/0 | 0% (0/70) |
| desktop-custom-700x900-0 | border | 0/0 | 0% (0/78) |
| desktop-custom-700x900-0 | shadow | 0/0 | 0% (0/74) |

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

- Only the supplied desktop screenshots and reported interaction outcomes were assessed; open select menus, empty results, loading states, errors, keyboard focus, and other records were not shown.
- The mock interaction evidence does not establish backend behavior, persistence, authorization, or publication status.
- No visual evidence of the requested implementation plan was supplied, so that deliverable could not be evaluated.
- Most styling provenance was unassessed in the supplied evidence; palette and public-component implementation compliance cannot be concluded from screenshots alone.
- Responsive observations are limited to 1920px, 1440px, 1024px, and 700px desktop windows.
