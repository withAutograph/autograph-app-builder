# Shared-composition comparison

This is an advisory comparison, not a generation gate or a target score.

## Changes exercised

- Arrusted `eb5efee4`: existing DataTable selection, keyboard interaction and optional narrow stacked records; stronger primary-action and detail-label contrast; current catalog and workflow examples.
- App Builder `04213e5` plus the subsequent type-import repair: capability-led composition guidance, chart initialization when used, and live-source snapshot support.
- Both fresh runs used the local Builder and real Vercel Sandbox. They stopped at a Browser prototype and implementation plan; neither built or published an app.

| Preview                                                            | Subjective score | Observations                                                                              |
| ------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| [Earlier Stock Exceptions](stock-exceptions-113904457Z/README.md)  | 60               | Fixed-width mobile layout, weak selection and contrast.                                   |
| [New Stock Exceptions](stock-exceptions-155003870Z/README.md)      | 75               | Visible selection, stacked mobile records, no horizontal overflow, clearer mock action.   |
| [Equipment Request, final](equipment-request-160006674Z/README.md) | 75               | Distinct form/review workflow, readable fields and clear actions; no horizontal overflow. |

The [intermediate Equipment Request report](equipment-request-155646883Z/README.md) was captured before the agent finished its final revision. It is retained as history, not the final comparison.

## Behavioral observations

- Stock Exceptions: selecting another product updated its detail panel and `aria-pressed`; filtering to Riverside returned two records; explicit selection followed by replenishment produced “Mock order created,” with no real order sent. Mobile document overflow was false.
- Equipment Request: submitting empty fields showed five actionable field errors; entering fixture values reached a review summary preserving the entered values. Mobile document overflow was false. The final submit action was not exercised in this comparison.
- Shared focused tests covered keyboard selection, controlled selection updates, readable primary action/detail labels, and nested table configuration roundtrips.
- Both real runs returned product-facing prototype summaries and implementation plans without setup approval requests. No build approval was given.

## Remaining observations, not blockers

- Stock mobile review still requires scrolling past a long list. The selected record should be closer to its details; small selection targets deserve a future touch-size improvement.
- Equipment Request's mobile progress panel takes too much first-screen space. Compact progress is a better future option for this workflow.
- Table headers, status badges, progress status and some secondary text still have contrast findings. The confirmed Button/detail-label repairs do not claim to fix every shared color treatment.
- Reports assess initial desktop/tablet/mobile states. Interaction checks above were separate, so their outcomes are not part of the screenshot judge's score.
- Source provenance was not supplied to these report invocations. Browser style evidence is partial and must not be represented as complete token-usage or component-adherence proof.
- Scores are single-model judgments, not controlled experiments: generated content differs from the baseline. No automatic rescoring or repair loop was used.

## Concrete renderer repair found during comparison

The form run retried because a TypeScript-only `SchemaFormValue` import was incorrectly counted as a visual component. The parser now ignores type-only imports and recognizes aliased value imports. Its focused preview-policy suite passed 12/12 tests. This repair was checked directly rather than regenerating both apps again.

These changes remain local and coordinated across two repositories. Broad CI, shared-API landing, deployment and package release have not been performed as part of this comparison.
