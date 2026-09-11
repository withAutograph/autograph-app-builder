# stock-exceptions-supplier-constraints — 2026-09-09T07:27:05.375Z

[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)

GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.

**Subjective design score:** 90/100. Model: openai/gpt-5.6-sol. Rubric: 2.

**Arrusted adherence:** 100/100 (partial); evidence coverage 1.54%. Evaluator 3.

| Dimension | Conforming | Nonconforming | Unassessed | Adherence    |
| --------- | ---------- | ------------- | ---------- | ------------ |
| component | 19         | 0             | 2          | 100% (19/19) |
| api       | 49         | 0             | 10         | 100% (49/49) |
| styling   | 13         | 0             | 5181       | 100% (13/13) |

Scores from different evaluator versions or captured states are not directly comparable.

This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.

## Ratings

| Dimension | Score | Reason |
| --- | --- | --- |
| hierarchy | 4/4 | The page establishes an excellent task sequence: page purpose, location/severity filters, prioritized exceptions, selected-item evidence, and a single replenishment action. Selected-row highlighting, severity pills, days-of-cover values, and explicit confirmation/result headings make urgency and state changes easy to scan. |
| layout | 3/4 | The list-detail composition is consistently aligned and comfortably spaced from 1024 to 1920 pixels, with stable action footers and well-grouped evidence. The constrained confirmation view becomes somewhat text-dense, and the fixed-width composition leaves substantial unused canvas on the widest capture, though readability remains strong. |
| typography | 3/4 | Heading levels, field labels, values, product identifiers, and status treatments are visually consistent and readable. Long model-assumption and replenishment values wrap densely at 1024 pixels, while automated evidence also flags marginal contrast for some 14-pixel muted text and lower contrast in the existing primary Button treatment. |
| responsive | 4/4 | The composition adapts effectively across the supplied desktop sizes: wide and standard windows retain simultaneous list-detail review, the 1024-pixel view narrows both panels without clipping controls, and the 700-pixel panel switches to a focused detail view with a clear Back action. Expanded evidence uses intentional panel scrolling where necessary, and tested actions remain visible. |
| productClarity | 4/4 | The interface clearly supports the brief: filters identify location and severity, the list exposes product/location/severity/coverage, detail shows stock and supplier facts, and the mock workflow explains quantity, case rounding, supplier minimum, projected stock, and that no real order or inventory change occurs. Confirmation, result, reset, and return affordances are explicit. |

## Strengths

- The exception list surfaces the most decision-relevant evidence—severity and days of cover—without requiring the detail panel.
- The selected product remains clearly identified through row highlighting and a repeated detail header containing SKU, location, and severity.
- The confirmation state explains how 96 units were derived from case size and supplier minimum instead of presenting an unexplained action.
- The result state prominently states that the operation was a simulation and that underlying stock was unchanged.
- Secondary supplier facts are progressively disclosed, keeping the initial review concise while retaining access to case pack, receipt, contact, and terms.
- The 700-pixel desktop-panel treatment uses a focused detail composition rather than compressing both columns into an unusable split view.

## Improvements

- **low — desktop-window-1:** The two-column confirmation facts remain usable, but long values for the model assumption and replenishment wrap into several narrow lines, making the most consequential review state denser than the surrounding interface. At constrained detail widths, use a supported stacked key/value arrangement for the longer assumption and replenishment rows while retaining the compact two-column treatment for short values.
- **low — desktop-0:** The sorting summary is useful but visually subdued relative to the exception count; automated evidence reports the muted 14-pixel text at approximately 4.47:1, just below the referenced threshold. Use an existing Typography emphasis or weight variant for the sorting summary while preserving the Arrusted semantic palette rather than overriding its color tokens.
- **low — desktop-0:** Automated evidence reports low text-to-background contrast in the existing primary Button treatment, although the button remains visually prominent through placement, size, and fill. This is advisory and should not prompt an app-level palette override. Verify whether the shared design system offers another supported Button variant appropriate for this action; if not, report the contrast pairing to the shared component owner instead of locally restyling the primary Button.

## Token evidence

Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.

| Viewport | Category | Token references / assessed | Coverage |
| --- | --- | --- | --- |
| desktop-0 | color | 0/0 | 0% (0/233) |
| desktop-0 | typography | 0/0 | 0% (0/526) |
| desktop-0 | spacing | 0/0 | 0% (0/275) |
| desktop-0 | radius | 0/0 | 0% (0/116) |
| desktop-0 | border | 0/0 | 0% (0/125) |
| desktop-0 | shadow | 0/0 | 0% (0/120) |
| desktop-wide-0 | color | 0/0 | 0% (0/233) |
| desktop-wide-0 | typography | 0/0 | 0% (0/526) |
| desktop-wide-0 | spacing | 0/0 | 0% (0/275) |
| desktop-wide-0 | radius | 0/0 | 0% (0/116) |
| desktop-wide-0 | border | 0/0 | 0% (0/125) |
| desktop-wide-0 | shadow | 0/0 | 0% (0/120) |
| desktop-window-0 | color | 0/0 | 0% (0/233) |
| desktop-window-0 | typography | 0/0 | 0% (0/526) |
| desktop-window-0 | spacing | 0/0 | 0% (0/275) |
| desktop-window-0 | radius | 0/0 | 0% (0/116) |
| desktop-window-0 | border | 0/0 | 0% (0/125) |
| desktop-window-0 | shadow | 0/0 | 0% (0/120) |
| desktop-custom-700x900-0 | color | 0/0 | 0% (0/161) |
| desktop-custom-700x900-0 | typography | 0/0 | 0% (0/405) |
| desktop-custom-700x900-0 | spacing | 0/0 | 0% (0/184) |
| desktop-custom-700x900-0 | radius | 0/0 | 0% (0/81) |
| desktop-custom-700x900-0 | border | 0/0 | 0% (0/84) |
| desktop-custom-700x900-0 | shadow | 0/0 | 0% (0/81) |

## Latest-run screenshots

### desktop-0 — initial

Interaction: not-run.

![desktop-0 initial](desktop-0.png)

### desktop-1 — Review modeled quantity before confirming

Interaction: passed.

![desktop-1 Review modeled quantity before confirming](desktop-1.png)

### desktop-2 — Mock replenishment result

Interaction: passed.

![desktop-2 Mock replenishment result](desktop-2.png)

### desktop-3 — Result evidence at scroll boundary

Interaction: passed.

![desktop-3 Result evidence at scroll boundary](desktop-3.png)

### desktop-4 — Reset from result footer

Interaction: passed.

![desktop-4 Reset from result footer](desktop-4.png)

### desktop-5 — Expanded supplier facts

Interaction: passed.

![desktop-5 Expanded supplier facts](desktop-5.png)

### desktop-wide-0 — initial

Interaction: not-run.

![desktop-wide-0 initial](desktop-wide-0.png)

### desktop-wide-1 — Review modeled quantity before confirming

Interaction: passed.

![desktop-wide-1 Review modeled quantity before confirming](desktop-wide-1.png)

### desktop-wide-2 — Mock replenishment result

Interaction: passed.

![desktop-wide-2 Mock replenishment result](desktop-wide-2.png)

### desktop-wide-3 — Result evidence at scroll boundary

Interaction: passed.

![desktop-wide-3 Result evidence at scroll boundary](desktop-wide-3.png)

### desktop-wide-4 — Reset from result footer

Interaction: passed.

![desktop-wide-4 Reset from result footer](desktop-wide-4.png)

### desktop-wide-5 — Expanded supplier facts

Interaction: passed.

![desktop-wide-5 Expanded supplier facts](desktop-wide-5.png)

### desktop-window-0 — initial

Interaction: not-run.

![desktop-window-0 initial](desktop-window-0.png)

### desktop-window-1 — Review modeled quantity before confirming

Interaction: passed.

![desktop-window-1 Review modeled quantity before confirming](desktop-window-1.png)

### desktop-window-2 — Mock replenishment result

Interaction: passed.

![desktop-window-2 Mock replenishment result](desktop-window-2.png)

### desktop-window-3 — Result evidence at scroll boundary

Interaction: passed.

![desktop-window-3 Result evidence at scroll boundary](desktop-window-3.png)

### desktop-window-4 — Reset from result footer

Interaction: passed.

![desktop-window-4 Reset from result footer](desktop-window-4.png)

### desktop-window-5 — Expanded supplier facts

Interaction: passed.

![desktop-window-5 Expanded supplier facts](desktop-window-5.png)

### desktop-custom-700x900-0 — initial

Interaction: not-run.

![desktop-custom-700x900-0 initial](desktop-custom-700x900-0.png)

### desktop-custom-700x900-1 — Review modeled quantity before confirming

Interaction: passed.

![desktop-custom-700x900-1 Review modeled quantity before confirming](desktop-custom-700x900-1.png)

### desktop-custom-700x900-2 — Mock replenishment result

Interaction: passed.

![desktop-custom-700x900-2 Mock replenishment result](desktop-custom-700x900-2.png)

### desktop-custom-700x900-3 — Result evidence at scroll boundary

Interaction: passed.

![desktop-custom-700x900-3 Result evidence at scroll boundary](desktop-custom-700x900-3.png)

### desktop-custom-700x900-4 — Reset from result footer

Interaction: passed.

![desktop-custom-700x900-4 Reset from result footer](desktop-custom-700x900-4.png)

### desktop-custom-700x900-5 — Expanded supplier facts

Interaction: passed.

![desktop-custom-700x900-5 Expanded supplier facts](desktop-custom-700x900-5.png)

## Limitations

- Filtering interactions and resulting empty or reduced-list states were not run, so their clarity and layout cannot be assessed.
- The screenshots do not establish backend behavior, persistence, authorization, or that the mock action can never affect real inventory.
- Only the supplied 700-, 1024-, 1440-, and 1920-pixel desktop compositions were observed; intermediate widths and independently resized nested panels remain uncertain.
- The requested implementation plan is not visible in the supplied interface captures, so its completeness cannot be evaluated.
- Static adherence evidence has very low styling coverage and cannot prove the complete CSS cascade or rendered provenance; palette observations are therefore kept separate from the design score.
