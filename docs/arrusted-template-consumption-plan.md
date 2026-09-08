# App Builder consumption of Arrusted

Autograph App Builder uses the changing Arrusted repository as its starter and
reuses its public design system for both Browser previews and generated apps.
Selecting the repository alone does not make a generated interface inherit its
design: the route must actually render its components, compositions, tokens,
and required providers.

## Source and execution

New apps use `withAutograph/arrusted-development`; existing-app work uses the
selected repository. Local development uses the live checkout supplied to
`mise run dev`. Vercel Sandbox is the execution backend. Its checkout is
writable: dependencies, new files, prototypes, and application edits are normal.

Inspect repository documentation and run the actual commands. Source metadata
is diagnostic; this document does not require readiness attestations, frozen
commits, clean trees, receipt chains, or offline dependency inventories.
Cache misses fall back to normal execution. Preserve user isolation and
credential protection, and ask before outward effects.

## Choose a composition, not a lookalike

Start with Arrusted's existing `docs/app-builder-ui-catalog.json` and its linked
examples. Read only the relevant current APIs, stories, and app consumers.
The catalog is guidance, not permission: missing or stale examples mean inspect
current public exports and adapt to the renderer's actual errors.

- **Record review:** choose a supported selectable record/table composition and
  detail panel. Use its selection and compact presentation props rather than
  turning a collection of Buttons into a custom fixed-width grid.
- **Forms:** use existing form/field compositions, supported labels, errors,
  grouping, and action variants. Preserve a clear submit path in desktop panels.
- **Overview/detail:** show the information needed to select the next action,
  then reveal details. Do not add metrics or charts merely to fill the page.

These are examples, not mandatory layouts. Choose by the actual product task.
Wide comparative data can scroll intentionally; a record-review task may benefit
from a compact presentation that keeps essential fields and actions together.

### List and detail in resized desktop windows

Keep columns that help the user choose the next record. Supporting attributes
can live in the selected detail panel instead of competing for list width.
`DataTableComposition` supports column `width` and `align`, plus `density` and
`frame` in `spec.config`. Width is a sizing hint, not a promise that all content
will fit: its table retains intrinsic content width and an overflow container.
Use only fields supported by the inspected implementation. In particular,
`narrowLayout` is not a supported spec field; there is no inferred stack mode,
colored string-cell option, or arbitrary cell renderer. Keep row data serializable.

When the inspected table supplies `getRowId`, `selectedRowId`, and `onRowSelect`,
keep stable record identity and selection in route state. Preserve that state
when the desktop layout changes. If detail moves below the list, route wiring
can bring the selected detail into view and focus its labeled wrapper. Removing
selection to make a layout fit loses the review workflow.

`RecordDetailPanel` accepts ordinary layout sizing through `className`. Its
existing body scrolls and its actions footer sits outside that body. A bounded
panel height can keep the action reachable while the details scroll; choose the
height for the surrounding layout and inspect the result in a shorter desktop
window. This is layout composition, not a new `panel-scroll` variant. Sections
support `collapsible` and `defaultOpen` when secondary information benefits from
disclosure. Do not hide essential decision context simply to shorten the panel.
The existing `tabs`, `activeTabId`, and `onTabChange` props are another option
when users switch between distinct groups of details. Supply the selected
group's sections from route state; tabs do not filter sections automatically.
Keep the action in the shared footer and retain enough context to understand
it from either view. Prefer this over a tall stack of mostly secondary sections
when the actual workflow benefits; tabs are not a requirement for every record.

When a long record title competes with the header status, the supported
ReactNode `subtitle` can compose the shared `StatusPill` with metadata below
the title. Use the public component and its tone props, not a bespoke badge.
Decision-critical quantities should use normal detail fields rather than tiny
metadata text. Table `density` changes row spacing, not header typography;
inspect the implementation before acting on a judge's proposed API change.

### Stock Exceptions example

The selected checkout also exports `DecisionOptionCard` from
`@autograph/components`. For a short review list where identity, urgency, and a
few supporting values matter more than column comparisons, compose those cards
inside a labeled radio group. Use `name`, `value`, `selected`, and `onSelect` for
native selection, `description` for context, and `tag` with the public
`StatusPill` for severity. The shared card owns its visual treatment; no custom
card, badge, or density override is needed. Its standard spacing takes more
vertical room than a table, so inspect the actual result. Keep a table when
cross-record column comparison is the user's main task. These are alternatives,
not a mandatory layout.

Keep persistent record state separate from action outcomes: an order simulation
does not change an inventory exception's severity. Present the result in its
own message or action state instead of replacing the severity indicator.

For a stock-review list, Product, Severity, and Cover may be enough alongside
the supported selection control. Location remains available in the filter and
selected record subtitle; on-hand and reorder quantities remain in Stock
position. Right-align Cover using the column's `align` field. This is an example
of choosing task-relevant columns, not a required three-column template.

Keep replenishment in the shared detail `actions`/`onAction` API, with its visible
fixture outcome. The tabbed example keeps Stock position and Supplier details
in separate shared panel views; a shorter record can instead use the existing
Supplier disclosure. Retain the stock facts and preview-only disclosure needed
to understand the action. Show severity through the supported detail `status`
tone or shared subtitle `StatusPill`. Plain severity text in the table is preferable to an
invented tone-cell prop or a palette override. A reusable semantic table-cell
capability belongs in Arrusted if the workflow needs it.

Review initial and changed selection, filtered results, and the action outcome
in the narrower desktop layout. These examples guide composition choices;
they add no runtime eligibility check, minimum width, score threshold, or
phone/tablet requirement.

## Component-only UI

Generated apps compose current public Arrusted components and compositions.
They do not invent visual primitives, copy private components, replace tokens,
or create a separate styling system. Route entries may bind data, state, event
handlers, navigation, and supported component props. Ordinary layout glue is
allowed; extensive overrides that reconstruct another control are not reuse.

When the catalog lacks a needed visual capability, use a supported alternative
and record the reusable improvement for Arrusted. Do not introduce a runtime
catalog gate or require a new shared release merely to produce a useful preview.

Use the target-owned theme, fonts, and required providers. Preserve the existing
Arrusted palette verbatim through semantic tokens and supported component variants.
Do not adjust shared or generated colors to chase advisory contrast/design scores.
A matching color literal is not evidence of token use. Apps are desktop-only:
support resized desktop windows and panels without phone/tablet acceptance or an
arbitrary minimum width.

## Preview to implementation

`record_ui_preview` compiles actual route TSX against the prepared repository.
Browser HTML is compiled transport, not a separately authored mock interface.
Keep the preview product-facing and fixture-backed. Internal recording and
planning happen without setup or acceptance questions.

The first normal prompt is **Build this app?** Once approved, carry the reviewed
route composition, responsive decisions, theme, and providers into the app;
replace fixture bindings with the intended application behavior instead of
redesigning from the prose brief. The preview is not proof of a built backend.
Repository publication, deployment, and other outward effects still need their
own approval.

## Advisory comparison

Use [on-demand design evaluation](design-quality-evals.md) after an intentional
comparison run, not on save or before every preview. Compare screenshots,
interaction behavior, and evidence coverage as well as subjective findings.
No minimum score, automatic polish loop, or catalog eligibility check is part
of generation. Keep reports under `docs/reports/design-quality/` when sharing
them with teammates.

The initial comparison is a fresh Stock Exceptions preview and a contrasting
form-oriented preview. Check meaningful selection and actions across desktop
windows/panels. Preserve different layouts for different jobs and the existing palette.
