# Arrusted composition capabilities

This is a Builder-facing reference inspected against current Arrusted main,
`7e44acbd14b4871fe285664a06e85d028eb5f301` on GitHub. It records reusable public
source APIs, not a second component catalog and not a promise that any
particular domain workflow is already implemented.

Paths below are relative to the selected Arrusted checkout. Consult its current
exports and existing catalog when an API changes; this revision is diagnostic,
not a version requirement. The canonical source is
[Arrusted](https://github.com/withAutograph/arrusted-development).

Use the configured Arrusted package aliases:

```ts
import {
  DecisionOptionCard,
  KpiCard,
  RecordList,
  SegmentedControl,
  Select,
  Sheet,
  StatusPill,
} from "@autograph/components";
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

## Decision review: keep visible choices state-consistent

`DataTableComposition` accepts primitive cells,
column alignment and widths, compact density, outlined/flat framing, and
horizontal overflow (`packages/design-systems/core/compositions/DataTable.tsx`).
Enable controlled row selection with `getRowId`, `selectedRowId`, and
`onRowSelect`. Selection buttons expose `aria-pressed`; ArrowUp/Down, Home,
and End move focus without silently changing the selected record. Omit the
selection props when the table is supporting evidence rather than navigation.

For the decision itself, keep the selected option in the application and render
one of the current controls:

- Use `Select` for a compact mutually exclusive choice.
- Use `SegmentedControl` for a short set of view or comparison choices; it
  renders the current public radio-group interaction.
- Use `DecisionOptionCard` for richer mutually exclusive alternatives. Place
  sibling cards in a semantic `role="radiogroup"` host and give them the same
  radio `name`; each card owns a checked radio input and invokes `onSelect`
  (`packages/design-systems/core/components/DecisionOptionCard.tsx`). There is
  no separately exported `RadioGroup` component on current main.

Use `RecordDetailPanel` for the decision's title, subtitle, status, metadata,
read/edit fields, notes, nested display tables, tabs, and footer actions
(`packages/design-systems/core/compositions/RecordDetailPanel.tsx`). In edit
mode, pass controlled `values`, `originalValues`, `onValueChange`, and
`onRevertField`; it can show a prior value and Revert affordance. Route visible
actions through `actions` and `onAction(actionId)`, and derive
`disabled`/`loading` from the same application state that supplies the selected
choice. Actions default to the footer; `actionsPlacement: "header"` supports
header actions. `labelEmphasis: "primary"` and per-field `layout: "stacked"`
support readable decision-critical labels and values without local restyling.

### Record selection and list/detail navigation

Use `RecordList` for compact records with `primary`, `secondary`, `trailing`,
and disabled states. Keep `selectedId` and `onSelect` in application state.
Rows are accessible buttons with selected-state semantics; empty results have
an explicit empty-state surface. Do not assume arrow-key roving behavior for
this list: its rows use normal button focus and activation.

Use `RecordListDetailLayout` to compose this list (or a selectable table) with
`RecordDetailPanel`. Wide containers show both panes. In a constrained
container, selecting a record reveals detail with a Back action; the component
handles focus transfer and restoration. Supply `hasSelection`, `selectedId`,
and `onBack`; the optional list render callback exposes `isDetailVisible`.
`showDetailOnConstrained` can defer the detail transition when appropriate.
Selection and routing remain application-owned, not a second internal store.

### Adequate composition: decision with supporting evidence

For a confirmation such as choosing a planning assumption, render a
`DecisionOptionCard` radio group above or beside a compact
`DataTableComposition` of the assumptions/evidence. Render the currently
selected option through `RecordDetailPanel`, with its explanatory metadata and
Confirm/Save footer action. The option state is controlled once by the
application; the display table does not need to impersonate a selector.

### Adequate composition: filter then inspect a known result

For a narrow review where a filter changes the shown evidence, use `Select` or
`SegmentedControl` to control the comparison/filter state, then show the
resulting rows with `DataTableComposition`. A `RecordDetailPanel` may show a
known current record or summary beside it, but the table itself remains
non-interactive. This is appropriate when the workflow already has a single
current result and the user is comparing/filtering context. For opening
arbitrary rows, use the controlled selection API and list/detail composition
above instead of inventing a replacement control.

## Numeric context and comparisons

Use `KpiCard` when one metric needs a clear value, label, optional description,
pills, and optional action (`packages/design-systems/core/components/KpiCard.tsx`).
Its value uses tabular numerals. For a compact group of comparable metrics, use
`KpiStripComposition` with already-formatted `value`, optional `delta`, and
semantic `tone` (`packages/design-systems/core/compositions/Charts.tsx`). On
current main it supports viewport-responsive or `layout: "container"`
composition, `maxColumns: 2 | 3`, primary label emphasis, item descriptions,
and full-span outcome items in a two-column container strip.

For evidence that needs visual comparison, use `ChartComposition` with a
validated `ChartConfig` (`compositions/charting/ChartComposition.tsx` and
`types.ts`). Current families cover breakdown, stacked timeline, waterfall,
scatter, range marker, donut, combined bar/line, and heatmap. Charts support
number, currency, and percent formats, controls, segment selection, and a
labeled segment action. Wire `onControlChange`, `onSegmentClick`, or
`onSegmentAction` back to the same application state that owns the shown data.
`createChartValueFormatter` uses compact `Intl.NumberFormat` output
(`compositions/charting/format.ts`), so include an exact value in nearby text
or the detail panel when compact notation would hide a decision-critical
distinction.

## Status, metadata, and desktop panels

Use `StatusPill` for a short state label plus optional detail and semantic tone
(`packages/design-systems/core/components/StatusPill.tsx`). Use
`RecordDetailPanel.status` and `.metadata` for the current decision's state and
readable provenance/context; metadata is `{ id, label?, value }`, so format
dates, owners, and source labels in the consuming app.

Use `Sheet` for a bounded secondary desktop task, with an explicit controlled
`open`, `title`, `onClose`, optional `footer`, and a task-appropriate `width`
(`packages/design-systems/core/components/sheet/sheet.tsx`). Its body scrolls
independently and preserves a visible header/footer. The supplied `backdrop` is
visual-only and the component does not claim a modal focus trap; use it for a
pullout/inspector or scoped form, not as a blocking confirmation dialog.

## Current limits and application responsibilities

- `DataTableComposition` cells are only `string | number | boolean | null`.
  It has no public custom-cell renderer, sorting, filtering, pagination,
  or multi-select API. Single-record selection is supported as described above.
- `RecordDetailPanel` actions report only an `actionId`; persistence,
  optimistic updates, error recovery, and navigation remain application
  responsibilities. Its built-in field values are primitive; use `renderValue`,
  `renderEditor`, or `renderItem` only for a justified specialized value.
- KPI components accept already-formatted values/deltas; they do not calculate
  comparisons, units, periods, or trend semantics. Chart interactions expose
  an action id and segment metadata but do not navigate or filter by themselves.
- `RecordList`, `RecordListDetailLayout`, and selectable `DataTableComposition`
  are already exported and story-covered. Their focused component tests passed
  (12 tests across three files) at the diagnostic revision above. No duplicate
  shared composition or Builder-local replacement is needed.
