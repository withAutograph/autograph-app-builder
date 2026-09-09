# Outlined simulation-action comparison

The score remains **95/100**, but the tradeoff changed: typography improved to
4/4 and hierarchy fell to 3/4. Layout, responsiveness, and product clarity remain
4/4. All 20 fixture interaction checks passed.

The generated source differs from the preceding state-aware version only in
two action intents: `primary` became the existing `secondary` variant for Try
mock replenishment and Confirm mock. No palette values, labels, placements,
data, calculations, or other composition changed.

The earlier primary action had a measured 2.78:1 text contrast; this existing
outlined option resolves that concern but makes the principal action less
prominent. The reviewer recommends a primary action treatment, while the prior
report identified its readability limitation. Repeatedly swapping the same two
variants is not a solution, and neither report establishes 100/100.

The next shared-component experiment is an opt-in emphasized action using an
existing darker Arrusted token and existing inverse text. It must preserve the
palette verbatim, leave current defaults unchanged, and improve the reusable
component rather than introducing generated-app styling overrides.

The rubric, weights, and denominators are unchanged. Source hints remain
reviewer-only, unknown styling is unassessed, and no runtime gates were added.
