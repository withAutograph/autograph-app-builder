# Fresh generation comparison

The same Stock Exceptions brief produced this new preview through the Development
App Builder, using the shared RecordList and RecordListDetailLayout APIs. It was
not a hand-edited revision of the previous preview. The run reached its prototype
and implementation plan without building or publication.

## Results

- Subjective design: **80/100**, versus **65/100** in the
  [previous fresh generation](../stock-exceptions-fresh-postmerge-031112441Z/README.md).
- Ratings: hierarchy 3, layout 3, typography 3, responsive composition 3,
  product clarity 4. The rubric, model, and equal weighting are unchanged.
- All **16 fixture interaction checks** passed across four desktop widths.
- Shared narrow list/detail navigation replaces the previous long stacked list.
  Filtering synchronizes selection; empty results no longer retain an unrelated
  action. The primary action is still below the initial short-window viewport,
  and the narrow confirmation needs more clearance from its footer.

## Adherence confidence

The **100/100 adherence score remains partial**. Component evidence coverage is
90.91%; API coverage is 73.17%. No source implementation diagnostics were reported.
Overall coverage is only **0.93%**, with styling coverage **0.19%**. This generation
uses shared components and utility classes rather than an attributable standalone
generated stylesheet, so the evaluator cannot confidently assign much of the
rendered styling to generated versus shared source. This is not evidence of
complete styling compliance, and the low coverage must remain visible.

## Next generic improvements

1. Keep task actions reachable in short desktop panels; reserve clear scrolling
   space for content and complete action feedback.
2. Size simple filter controls for their content rather than stretching them
   across an entire wide display.
3. Use supported readable typography and status sizes for decision-relevant
   supporting information, preserving the Arrusted palette.

These are shared composition and generation-guidance improvements, not a scoring
threshold or automatic repair loop. Historical reports remain unchanged. Model
ratings are advisory; the two generations also use different fixture content and
interaction states, so the numerical difference is not a controlled benchmark.
