# Runnable fixture example

`scripts/design-quality/examples/input.ts` exports `loadDesignQualityExample("spend-import-review")`. The returned `UiPreviewInput` is ready for `renderUiPreview` and is assembled from this directory's `fixtures.json`, `example.json`, and the checked-in public-component route source.

This example is new runnable fixture material. It does not revise or replace historical screenshots or reports.

Review keeps original transaction fields in the public Arrusted `RecordDetailPanel`, separate from candidate vendor choices. Completed mapping collapses into a shared `Disclosure` so the decision can use the available width. At narrow desktop sizes, setup stacks instead of squeezing the evidence into a fixed side panel. Mapping remains available to reopen and change.
