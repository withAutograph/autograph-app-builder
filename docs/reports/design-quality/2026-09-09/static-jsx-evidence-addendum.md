# Static JSX evidence addendum

This is a source-only reassessment of the saved [delivery-signal report](stock-exceptions-delivery-signal-001913264Z/index.html), not a new visual evaluation. Its screenshots, historical JSON, and subjective design score of **95/100** are unchanged.

## Observed change

The same saved `sourceFiles` were analyzed against the same Arrusted checkout (`eb696f95b2297bfdf893ea07fc181014904e418c`) before and after the static-JSX assignability repair.

| API evidence | Before | After |
| --- | ---: | ---: |
| Conforming | 54 | 55 |
| Nonconforming | 0 | 0 |
| Unassessed | 7 | 6 |
| Total | 61 | 61 |
| Assessed coverage | 88.52% | 90.16% |

Exactly one observation changed: `api:prop:src/StockExceptions.tsx:6403:tag`. TypeScript proves that the inline JSX value is assignable to the selected public component's slot prop. This is static API evidence only: it does not prove rendered component identity, execution of dynamic descendants, or styling provenance.

The implementation handles JSX elements, self-closing elements, and fragments. It requires a compiler-resolved type and assignability; unknown/any types and callbacks do not gain credit. Focused reference tests passed (9/9), including incompatible JSX and unknown/callback cases.

## Limits

- Component and styling observations are not changed by this repair.
- Most browser styling still has unknown provenance; the overall adherence result remains **partial**.
- No screenshots were recaptured, no model judge was called, and no historical report was rewritten.
- No rubric, score weights, palette, runtime instrumentation, or generation gates changed.

To reproduce the comparison, run `analyzeSource` with the report's saved `sourceFiles`, `readReference` for the named checkout, and its `packages/design-systems/core/tokens/theme.css`; compare API observations by `id`. The report provides the exact source bytes, so regenerating the app is unnecessary.
