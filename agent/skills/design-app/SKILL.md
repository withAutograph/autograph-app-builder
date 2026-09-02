---
name: design-app
description: Turn a product idea into a rapidly iterated, component-backed minimum viable UI for a supported Arrusted repository. Use for product discovery, app design, prototyping, or specification when requirements, integrations, or data objects are not yet fully known. Generic app-creation requests belong to $create-app.
---

# Design App

Turn an early product idea into a fixture-backed React UI that helps the user
decide what should be built. The prepared Arrusted source is the design
authority. Bounded overlay source is the authored design; renderer-produced
Browser assets are transport only. Keep the Browser preview as pure product UI.

## Minimum viable UI gate

Require a clear job to be done, then infer a reversible interface pattern and
show the smallest useful workflow early. Do not block the first UI on a full
data model, integrations, permissions, delivery choices, or backend design.
Ask one question only when the missing answer would create a meaningfully
different visible product. Record all other unconfirmed choices as narrow
assumptions or visible-product questions, never accepted decisions.

Prepare the canonical Arrusted source before creating a preview. Inspect design
evidence in this order:

1. public `@autograph/components` exports;
2. public `@autograph/compositions` exports, including tables and charts;
3. relevant stories and documented examples; and
4. representative production consumers that establish page chrome, layout,
   density, responsive ordering, and real product context.

A story proves a supported state, not where the element belongs in a product.
Prefer the cheapest public composition that makes the user's decision visible.
Do not create a local workflow component until the catalog and relevant
consumers prove a capability gap. Never copy private components, recreate a
composition under a local name, define replacement tokens, or introduce a
second styling system.

## Source and manifest contract

Call `record_ui_preview` with bounded React UI source, routes, catalog gaps, and
one synchronized manifest. The manifest must inventory:

- every screen and its source entry;
- every imported public component, composition, and icon;
- deterministic fixture facts;
- accepted visible-product decisions;
- provisional assumptions, kept separate from decisions;
- unresolved questions that could alter the visible experience; and
- the future production meaning of visible elements.

Every local file under `src/components/` needs a capability-gap reason, the
inventoried public primitives it composes, and the semantic Arrusted tokens it
uses. Local workflow components may arrange product-specific behavior, but may
not introduce raw replacement controls or reusable design-system APIs. Preserve
accepted decisions across revisions; update source, fixtures, manifest, and
production meaning together. Their combined bytes define the immutable UI
revision.

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

Before presenting a material revision, verify:

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

Show the UI early and ask the user what feels wrong, missing, unnecessary, or
unlike their work. Anchor questions to visible choices. Revise only the
disposable overlay during review and reuse its prepared Arrusted source,
sandbox, and dependency closure.

Stay in `ui_previewed` after each revision. Praise such as "looks good" may
prompt an offer to finalize functionality, but does not authorize it. Only an
explicit request to finalize functionality accepts the exact current revision.
Then use `references/app-spec.md` to settle production behavior and enter the
existing planning flow. Any later UI revision invalidates acceptance and all
downstream plans. Legacy HTML sessions remain readable, but must be re-rendered
through this component-backed path before finalization.

## References

References are bundled files, not skills. Never pass a reference path to
`load_skill`; load only the top-level `design-app` skill, then use
`read_skill_reference` with:

- `design-app` and `references/questions.md` before asking discovery questions;
- `design-app` and `references/target-repository-routing.md` before inspecting
  prepared Arrusted source; and
- `design-app` and `references/app-spec.md` only after explicit UI finalization
  or when binding the accepted revision to production behavior.

## Product-facing conversation

Describe the inferred product name, visible workflow, revisable assumptions,
and next meaningful design choice. Keep preparation, manifests, receipts,
digests, validators, source machinery, and protocol operations internal. If the
required preview operation is unavailable, stop after product discovery and
state that the visual preview cannot be produced; never substitute a generic
file writer or model-authored HTML.
