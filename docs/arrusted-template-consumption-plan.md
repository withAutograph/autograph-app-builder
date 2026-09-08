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
