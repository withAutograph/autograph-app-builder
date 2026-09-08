---
name: design-app
description: Turn a product idea into a rapidly iterated, component-backed minimum viable UI for a supported Arrusted repository. Use for product discovery, app design, prototyping, or specification when requirements, integrations, or data objects are not yet fully known. Generic app-creation requests belong to $create-app.
---

# Design App

Turn an early product idea into a fixture-backed React UI that helps the user
decide what should be built. The prepared Arrusted source is the design
authority. Bounded overlay source is the authored design; renderer-produced
Browser assets are transport only. Keep the Browser preview as pure product UI.

## Minimum viable UI

Require a clear job to be done, then infer a reversible interface pattern and
show the smallest useful workflow early. Do not block the first UI on a full
data model, integrations, permissions, delivery choices, or backend design.
Ask one question only when the missing answer would create a meaningfully
different visible product. Record all other unconfirmed choices as narrow
assumptions or visible-product questions, never accepted decisions.

Use the prepared Arrusted source when creating a preview. Start with its
`docs/app-builder-ui-catalog.json` and linked examples to find relevant patterns,
then inspect the useful subset of:

1. public `@autograph/components` exports;
2. public `@autograph/compositions` exports, including tables and charts;
3. relevant stories and documented examples; and
4. representative production consumers that establish page chrome, layout,
   density, responsive ordering, and real product context.

A story proves a supported state, not where the element belongs in a product.
Prefer the cheapest public composition that makes the user's decision visible.
Compose the interface only from existing public Arrusted components and
compositions. Do not create local workflow components, custom controls, copied
private components, replacement tokens, or a second styling system. A catalog
gap is a reason to adapt the design using available components, not permission
to invent one. Offer a product-level alternative if the gap changes what the
user can accomplish. Import the current target-owned token entrypoint directly;
do not approximate the theme with hand-authored colors.

Choose by capability, not component name. A display-only table is not an
interactive review queue. Prefer a supported record-review composition for
selection and details, a form composition for data entry, and an overview/detail
pattern when summarizing before drilling in. These are examples, not required
layouts. Read the selected API and example rather than browsing the whole catalog.
Missing or stale documentation is not a blocker: inspect current public exports
and try the renderer. See `references/target-repository-routing.md` for sources.

Plan narrow-screen behavior with the first composition. Keep the selected record
and its primary action understandable; use supported compact/list presentations
where comparison columns would hide essential information. Intentional scrolling
is appropriate for wide comparisons, not a universal failure. Use component
variants instead of turning Buttons into rows through extensive style overrides.

## Source and manifest contract

In local and hosted execution, call `record_ui_preview` with React route wiring,
routes, catalog gaps, and one synchronized manifest. The manifest inventories:

- every screen and its source entry;
- every imported public component, composition, and icon;
- deterministic fixture facts;
- accepted visible-product decisions;
- provisional assumptions, kept separate from decisions;
- unresolved questions that could alter the visible experience; and
- the future production meaning of visible elements.

Do not add local component implementations under `src/components/` or elsewhere.
Route entries may wire fixtures, event handlers, and state through the existing
components' public APIs. Preserve stated decisions across revisions and update
source, fixtures, manifest, and production meaning together. Never substitute a
standalone HTML generator for this rendered React preview.

Every enabled visible control must have meaningful fixture-backed behavior.
When the prototype cannot support an action, disable the control and show a
product-facing reason instead of leaving a no-op handler or broken destination.

## Rendering policy

Use realistic, internally consistent fixture data. Pages, navigation, filters,
dialogs, controls, keyboard actions, and visible state changes should work in
memory. Include useful first-use, empty, loading, and error states where they
clarify the experience. Do not add persistence, network requests, providers,
schemas, API routes, server actions, auth, deployment, or backend files.

Follow observed production patterns for fonts, semantic colors, spacing,
borders, radii, chrome, density, and responsive ordering. Avoid decorative
dashboard regions, gradients, excessive card nesting, oversized empty space,
invented iconography, and unsupported design-system APIs. Prefer a restrained
composition that keeps the primary task, selection, evidence, and next action
obvious.

Use these design considerations while composing; they are not additional
preflight steps or approval gates:

- every public import and catalog gap is inventoried and justified;
- a suitable public composition was not replaced by local UI;
- fixture values agree across screens and the manifest;
- assumptions remain distinct from accepted decisions;
- desktop and narrow layouts preserve hierarchy, selection, ordering, and
  overflow behavior;
- labels, focus, keyboard operation, contrast, and semantic structure work;
- no fake live integration or backend behavior is implied; and
- Context, Draft spec, internal receipts, and implementation plans do not leak
  into the product preview.

## Review and finalization

Show the UI early and continue internal design recording and planning from the
brief and safe revisable defaults. Use `references/app-spec.md` to describe the
intended behavior. Do not ask for formal UI finalization, artifact acceptance,
or planning approval. Ask a product question only when no safe revisable default
can resolve a material ambiguity.

Once the Browser prototype and implementation plan are ready, the first normal
prompt is **Build this app?**. Approval authorizes editing and validating the
private App Builder checkout only. Denial preserves the preview for refinement;
revisions update the plan silently. Publication and other outward effects need
their own later effect-based approval. Reuse the prepared checkout while
refining the design, and keep the applied interface on the same public Arrusted
components and token entrypoint as the preview.
Carry the reviewed route composition, responsive choices, and supported props
into implementation; change fixture data to real data bindings rather than
redesigning the UI from the prose brief. Load the same required providers and
font/theme foundation in both surfaces.

Design scoring is on demand only. Do not run a judge, impose a score threshold,
or start an automatic polish loop before showing the prototype. Report shared
component defects for repair in Arrusted instead of covering them with a new
generated styling system.

## References

References are bundled files, not skills. Never pass a reference path to
`load_skill`; load only the top-level `design-app` skill, then use
`read_skill_reference` with:

- `design-app` and `references/questions.md` before asking discovery questions;
- `design-app` and `references/target-repository-routing.md` before inspecting
  prepared Arrusted source;
- `design-app` and `references/interactions.md` when wiring routes and actions,
  and before presenting a material revision; and
- `design-app` and `references/app-spec.md` when deriving the implementation
  plan from the current preview and product brief, without a finalization prompt.

## Product-facing conversation

Describe the inferred product name, visible workflow, revisable assumptions,
and next meaningful design choice. Keep preparation, manifests, receipts,
digests, validators, source machinery, and protocol operations internal. If the
required preview operation is unavailable, stop after product discovery and
state that the visual preview cannot be produced; never substitute a generic
file writer or model-authored HTML.
