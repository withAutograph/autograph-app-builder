# Scenario error disclosure

This original evaluation is retained unchanged. Its subjective score is 75/100, but it is **not the final assessment of this preview**.

Two scenario definitions incorrectly passed lowercase option values (`critical`, `watch`) to a runner that selects by visible label (`Critical`, `Watch`). Consequently, eight filter/empty-state checks failed before reaching their intended states. Mock and reset checks passed at all four sizes.

The correction changes only the scenario labels and evaluates the same preview and generated source again. No UI regeneration, rubric change, or score substitution is involved. Refer to the subsequent corrected-scenario report for the completed state coverage. This report's screenshots, findings, and score remain historical evidence, including the judge's limitations about the missing empty state.
