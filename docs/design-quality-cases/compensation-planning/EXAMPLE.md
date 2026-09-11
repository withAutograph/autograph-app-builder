# Runnable fixture example

`scripts/design-quality/examples/input.ts` exports `loadDesignQualityExample("compensation-planning")`. The returned `UiPreviewInput` is ready for `renderUiPreview` and is assembled from this directory's `fixtures.json`, `example.json`, and the checked-in public-component route source.

This example is new runnable fixture material. It does not revise or replace historical screenshots or reports.

The planned-increase field has the concise accessible name “Planned base increase”; percentage guidance sits outside the label. The persisted scenario edits it to 10% and expects $220,791, checking both targetability and calculated output. Keep helpers descriptive without unintentionally changing control names.
