# Arrusted composition capabilities

This is a Builder-facing reference for the current Arrusted checkout at
`/private/tmp/arrusted-constrained-detail.vwBoJB/repo`. It records reusable
public source APIs, not a second component catalog and not a promise that any
particular domain workflow is already implemented.

Use the configured Arrusted package aliases:

```ts
import { KpiCard, RecordList, Sheet, StatusPill } from "@autograph/components";
import {
  ChartComposition,
  DataTableComposition,
  RecordDetailPanel,
  RecordListDetailLayout,
} from "@autograph/compositions";
```

Those aliases currently resolve in Arrusted's root `tsconfig.json` to
`packages/design-systems/core/components/index.ts` and
`packages/design-systems/core/compositions/index.ts`. The core package is
domain-agnostic by design; keep product nouns, data access, and workflow state
in the consuming application.

## Decision review: retain one source of truth

For a selected record with a detailed decision, use controlled selection:

1. Render `DataTableComposition` for dense, columnar evidence, supplying
   `getRowId`, `selectedRowId`, and `onRowSelect`.
2. Keep the selected id and authoritative record state in the application.
3. Render the same record through `RecordDetailPanel`; wire each visible action
   through `actions` and one `onAction(actionId)` handler.

`DataTableComposition` accepts serializable primitive cells, column alignment
and widths, compact density, an outlined/flat frame, and horizontal overflow
(`packages/design-systems/core/compositions/DataTable.tsx`). Its row-selection
buttons expose pressed state and keyboard navigation. It is therefore suitable
for a review table where the panel is a different view of the same selected
record, rather than a duplicate editable copy.

Use `RecordDetailPanel` for the selected record's title, subtitle, status,
metadata, read/edit fields, notes, nested compact tables, tabs, and actions
(`packages/design-systems/core/compositions/RecordDetailPanel.tsx`). In edit
mode, pass controlled `values`, `originalValues`, `onValueChange`, and
`onRevertField`; the panel can show a prior value and Revert affordance. Use
`disabled`/`loading` on `RecordDetailAction` from application state so an
action's presentation agrees with its actual availability. Prefer the default
footer actions for a review-and-confirm flow; use `actionsPlacement="header"`
only when fast, repeated decisions genuinely need it.

For a list rather than a table, compose `RecordList` with the same controlled
selection and `RecordListDetailLayout` (`components/RecordList.tsx` and
`compositions/RecordListDetailLayout.tsx`). The layout preserves two columns
when its container is wide, and replaces the list with detail plus a Back
control when constrained. It restores selection focus after Back. This is the
reusable desktop-panel answer for a queue, exception list, or inspector; do not
reimplement a breakpoint-specific panel switch in a generated app.

## Numeric context and comparisons

Use `KpiCard` when one metric needs a clear value, label, optional description,
pills, and an optional action (`packages/design-systems/core/components/KpiCard.tsx`).
Its value uses tabular numerals. For a compact group of comparable metrics, use
`KpiStripComposition` with `layout: "container"`, `maxColumns`, a meaningful
`delta`, and an explicit semantic `tone`
(`packages/design-systems/core/compositions/Charts.tsx`). This supplies a
container-aware two/three-column strip; it is not a generic dashboard mandate.

For evidence that needs a visual comparison, use `ChartComposition` with a
validated `ChartConfig` (`compositions/charting/ChartComposition.tsx` and
`types.ts`). Current families cover breakdown, stacked timeline, waterfall,
scatter, range marker, donut, combined bar/line, and heatmap. Every chart can
declare `valueFormat` as number, currency, or percent and supports controls,
segment selection, and a labeled segment action. Wire `onControlChange`,
`onSegmentClick`, or `onSegmentAction` back to the same application state that
owns the shown data. `createChartValueFormatter` currently uses compact
`Intl.NumberFormat` output (`compositions/charting/format.ts`), so show an
exact amount in supporting text or a detail view when compact notation would
hide a decision-critical distinction.

## Status, metadata, and desktop panels

Use `StatusPill` for a short state label plus optional detail and semantic tone
(`packages/design-systems/core/components/StatusPill.tsx`). Use
`RecordDetailPanel.status` and `.metadata` for the selected record's current
state and readable provenance/context; metadata is a list of `{ id, label?,
value }`, so format dates, owners, and source labels in the consuming app.

Use `Sheet` for a bounded secondary desktop task, with an explicit controlled
`open`, `title`, `onClose`, optional `footer`, and a task-appropriate `width`
(`packages/design-systems/core/components/sheet/sheet.tsx`). Its body scrolls
independently and the sheet preserves a visible header/footer. The supplied
`backdrop` is visual-only and the component intentionally does not claim a
modal focus trap; use it for a pullout/inspector or a scoped form, not as a
stand-in for an inaccessible blocking confirmation dialog.

## Actual limits to respect

- `DataTableComposition` cells are only `string | number | boolean | null`.
  There is no public custom-cell renderer, sorting, filtering, pagination, or
  multi-select API. Put rich per-row controls in a record-detail action or use
  an application-owned specialized surface when the task truly requires them.
- `RecordDetailPanel` actions report only an `actionId`; state transitions,
  persistence, optimistic updates, and error recovery remain application
  responsibilities. Its built-in field values are primitive; use
  `renderValue`, `renderEditor`, or `renderItem` for a justified specialized
  representation rather than changing shared components.
- `KpiCard` and `KpiStripComposition` accept already-formatted display values
  and deltas. They do not calculate comparisons, units, periods, or trend
  semantics. Derive those from the authoritative data model before rendering.
- Chart interactions expose an action id and selected segment metadata, but do
  not navigate or filter by themselves. The application must apply the action
  against the same filter/selection state used for the chart.
- There is no single public composition that combines a selectable table,
  persistent inspector, and bulk actions. The supported reusable composition is
  controlled `DataTableComposition` + `RecordDetailPanel`, optionally inside
  `RecordListDetailLayout` for a list-first review. A future shared gap should
  be proposed only if a concrete workflow cannot be composed from those APIs;
  do not add a Builder-local replacement.
