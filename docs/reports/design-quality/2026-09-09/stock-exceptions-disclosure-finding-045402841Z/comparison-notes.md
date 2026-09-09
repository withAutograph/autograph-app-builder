# Expanded-state evaluation: concrete failures

This same-session revision scores **70/100**, below the preceding 80. The first four scenarios still pass at every size (16 passed). The added supplier-disclosure scenario fails at every size (4 failed): clicking its unique button does not reveal the expected payment terms. Source inspection shows those fields are supplied, so a bounded shared-component investigation is underway. It is not appropriate to dismiss the failed interaction as a score issue.

Adherence is **99% of assessed evidence**, partial at **1.05% coverage**. One generated `Typography` variant (`heading-sm` in the empty state) is not part of the selected public API. This must use a supported variant rather than relaxing the evaluator.

The quantity now explains case-pack rounding, but the judge finds reserved-stock treatment unclear. Clarify the existing fixture assumption without silently changing the business calculation. The model also asks for arbitrary narrower/intermediate screenshot coverage when rating responsiveness; that is a subjective judgment limitation, not a new minimum-width requirement.

Keep all previous reports unchanged. Repair the disclosure behavior and unsupported variant before another on-demand evaluation. No palette changes, scoring changes, automatic runtime gates, or generation loop are introduced.

## Subsequent diagnosis

The disclosure interaction failure was a **scenario selector error**, not broken content: Playwright Chromium returns zero matches for the `button` role, while macOS AX exposes the native summary as a button. The exact-text summary exists once and opens all four fields. A focused reproduction found `roleMatches: 0`, `textMatches: 1`; the scenario now targets the native `summary` and retains the expected terms assertion. The original 70-point report is preserved, but should not be treated as a settled assessment of disclosure functionality. The caret direction is independently reversed in the shared stylesheet and has a narrow repair. The unsupported Typography variant remains a real generated API defect.
