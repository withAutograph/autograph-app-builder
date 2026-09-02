---
name: design-app
description: Turn a product idea into a rapidly iterated, component-backed minimum viable UI for a supported Arrusted repository. Use for product discovery, app design, prototyping, or specification when requirements, integrations, or data objects are not yet fully known. Generic app-creation requests belong to $create-app.
---

# Design App

Use the prepared Arrusted public component catalog as the discovery surface.
The design source is bounded React UI source in the builder-owned overlay;
compiled Browser assets are transport, never model-authored HTML. Do not require
a complete data model before showing the user something useful. Do not let
provisional UI assumptions silently become production decisions.

## Minimum viable UI gate

Prepare the canonical Arrusted source and inspect its current catalog, tokens,
providers, examples, and stories before the first preview. Reuse public
`@autograph/components`, `@autograph/compositions`, and `@autograph/icons`
before adding a small `src/components/` workflow composition. A local component
needs a recorded catalog gap and may compose only public primitives and semantic
tokens. Never copy private components, define replacement tokens, or introduce
another styling system.

The preview is fixture-backed and in-memory: pages, navigation, filters,
dialogs, controls, keyboard actions, and visible empty/loading/error states
work, but it has no persistence, network, provider, schema, API, server action,
or backend files. Revise only the disposable overlay and show the UI early.
Defer backend questions unless the answer changes what the person sees.

Stay in UI review after a preview. Praise such as “looks good” prompts an offer
to finalize functionality but does not authorize it. Only an explicit request
to finalize functionality accepts the exact revision; then bind production
decisions to that revision and begin the existing planning flow. Any later UI
revision invalidates acceptance and returns to UI review. Legacy HTML previews
may be read, but must be re-rendered through this component path before
finalization.

Prototype files and previews require a discovered builder-owned artifact tool.
If it is unavailable, stop after product discovery and report that prototype
delivery is not implemented. Never substitute the generic file writer or claim
that an HTML artifact was created or shown.

## Communication rule

Use product language in every public message. Never name internal
specifications, acceptance mechanics, artifacts, receipts, digests, workspace
or source machinery, validation gates, protocol operations, or opaque
validator/blocker text. Translate only the visible product meaning or effect.

## Load references

References are bundled files, not skills. Never pass a reference path to
`load_skill`; that tool accepts only the top-level `design-app` name. After this
skill is loaded, use `read_skill_reference` with the exact pairs below:

- `design-app` and `references/questions.md` before asking discovery questions;
- `design-app` and `references/app-spec.md` when creating or updating the
  decision ledger, checking build readiness, or handing off to implementation;
  and
- `design-app` and `references/target-repository-routing.md` before grounding
  the prototype or planning the production app.

## Artifacts

Resolve one concise user-facing app name and one lowercase kebab-case app id,
then maintain these together under `prototype/<app-id>/`. Preserve explicitly
supplied valid values. When either is omitted, infer it from the product brief,
briefly tell the user what was inferred, and continue without confirmation.
Derive an inferred id deterministically from the chosen name by lowercasing it,
replacing each run of non-alphanumeric characters with one hyphen, and trimming
hyphens. The prototype slug and future app id must be identical. Inspect the
prepared source for a real directory, package, route, or prototype collision;
ask only for a collision, unsupported identifier, or material ambiguity. The
selected adapter's builder-owned identity operation remains authoritative for
later target planning. Never construct or guess a repository script path.

- `index.html` plus additional self-contained HTML pages when interfaces require
  them;
- `app-spec.md`, using the contract in `references/app-spec.md`; and
- `decisions.md`, recording user-stated facts, evidence, assumptions,
  confirmations, defaults, unresolved questions, and explicit deferrals.

The HTML is not production code, schema authority, or persisted-data authority.
The AppSpec becomes build-ready when stated product decisions and safe revisable
defaults satisfy the complete contract; formal recording is internal and silent.

## Phase 0: Minimum HTML gate

Require only a clear job to be done. Infer the initial interface pattern from
the product brief and explicit preferences. When no preference is stated,
choose a reasonable, revisable pattern, explain the choice briefly in user
language, and proceed quickly to HTML. Do not ask the user to choose among a
queue, form, dashboard, table, or detail view when the brief supports a good
default. Ask one concise blocking question only when the job itself is missing
or materially different interface choices would produce meaningfully different
products. Do not block HTML on personas, integrations, data objects, fields,
permissions, or delivery details; infer plausible provisional choices, label
them, and make them easy to revise.

## Phase 1: Focused exploration

Research enough to make the prototype credible:

1. learn domain terminology, current tools, best practice, and common failures;
2. identify day-to-day users and consumers of the output;
3. refine the decisions, cadence, first-use behavior, and failure states inside
   the stated JTBD;
4. propose likely data sources and reconciliation issues as assumptions; and
5. identify concrete proactive and on-demand agent value.

Do not turn this into a mandatory pre-prototype interview. Ask only questions
that would materially change the first HTML into a different product. For
valuable but nonblocking questions, state the assumption and continue.

## Phase 2: Target-repository grounding

Read only the repository sources routed by
`references/target-repository-routing.md` from the prepared target workspace.
Inspect current exports, Storybook stories, contracts, tokens, and examples
instead of relying on memorized capability lists.

Map provisional needs to the target repository's schema, temporal reads, provenance,
draft/review, analytics, agent behavior, integrations, and app-owned workflow.
Classify material pieces as Config, Extension, Adapter, or Novel. Treat this as
a provisional feasibility assessment; it informs prototype choices but does not
block HTML unless the requested interface is impossible to represent honestly.

## Phase 3: Generate the first HTML

Generate a self-contained, clickable prototype using realistic and internally
consistent sample data. Include only the interfaces needed for the JTBD. Make
navigation, controls, actions, first-use state, empty/loading/error states, and
agent behavior visible where relevant.

Use live target-repository design tokens as the source; do not copy a stale literal token
table into the skill. The prototype may reproduce token values inside its
self-contained CSS, but record their repository source in `decisions.md`.

Before presenting it, verify:

- pages and controls work from `file://`;
- navigation and active states are correct;
- sample objects and numbers remain consistent across pages;
- desktop and narrow layouts remain usable;
- keyboard controls, labels, focus, contrast, and semantic structure are
  credible;
- no lorem ipsum, unexplained placeholders, or fake production integrations
  appear; and
- every provisional behavior is labeled in the decision ledger.

Record the HTML, decision ledger, and exploring AppSpec through the discovered
session-scoped artifact tool without requesting approval. This is non-published
builder-owned state and must not write the source or target repository.

## Phase 4: Prototype-led interview loop

Show the prototype early. Ask the user to react in product language: what feels
wrong, missing, unnecessary, or unlike their work. Revise the HTML first when
feedback is experiential.

After each meaningful revision:

1. update `decisions.md`;
2. update the corresponding AppSpec sections;
3. identify the next highest-value uncertainty;
4. ask no more than three short questions at once; and
5. distinguish a blocking build question from a helpful prototype question.

Use the question routes in `references/questions.md`. Prefer questions anchored
to something visible: “When someone selects this vendor, should they see a
detail panel or filter the transactions table?” Avoid asking users to design
kernel tables, RLS, package boundaries, generated clients, or change envelopes.

## Phase 5: Convert prototype to AppSpec

Infer and confirm the production meaning behind the approved experience:

- integrations, imports, source systems, refresh cadence, and source of truth;
- data objects, identities, fields, and relationships;
- routes and interfaces;
- controls, filters, grouping, as-of dates, comparisons, and actions;
- reads, writes, draft/review behavior, provenance, and authority;
- roles, permissions, sensitivity, and tenant expectations;
- agent responsibilities, tools, limits, and review points;
- first-use, empty, loading, and failure behavior; and
- delivery expectation, non-goals, and acceptance walkthrough.

Never infer build readiness from praise of the HTML. Present confirmed
decisions, accepted defaults, explicit deferrals, and material product questions
separately, without naming internal planning structures.

When product decisions and safe revisable defaults are complete, add exactly one
`## Build handoff` JSON block using the strict shape in
`references/app-spec.md`. It contains only the non-derivable decisions needed
by app preparation. Omit it while a materially product-changing choice remains
unresolved.

## Phase 6: Build-ready gate

Validate the complete AppSpec silently before target mutation. The gate passes
without a formal acceptance prompt when:

- the HTML experience and interface inventory follow stated preferences or
  clearly labeled safe revisable defaults;
- every visible value has a confirmed or explicitly provisional production
  source;
- integrations and data objects are confirmed or deliberately deferred;
- every control and action has defined host behavior;
- temporal, write, review, provenance, permission, and agent boundaries are
  settled for the first version;
- blocking `agent_inferred` and `unresolved` items are confirmed, replaced by an
  accepted default, deferred, or made a non-goal; and
- the acceptance walkthrough is complete enough to review the plan.

Before passing the gate, confirm the accountable owner, whether the app owns a
kernel schema, any exceptional public routes beyond the conventional app-id
routes, and provider-neutral integration or hosted-resource capabilities. Then
set the strict Build handoff status to `build-ready`; do not add provider
configuration or mechanical repository identities to it.

If validation fails, parse the technical or schema errors, repair missing
sections and completeness automatically, re-record the artifact, and retry. If
the gate still fails, return one plain-language product question only when the
answer materially changes the product; otherwise state one actionable product
limitation. Never surface AppSpec, receipt, validator, or schema mechanics in
normal conversation.

## Phase 7: Production handoff

After internal validation, return control to `$create-app` with the app id so
the same user task can bind the exact AppSpec bytes and automatically produce
the read-only proposal before requesting separate source/topology mutation
approval. If invoked directly for an app the
user intends to build, continue into `$create-app` without asking the user to
start another task. Do not create production source or topology in this skill.

## Product-facing conversation

Keep normal updates about the product: the inferred name and id, the chosen UX
pattern, what is visible now, and the next meaningful decision. Suppress routine
internal specification and acceptance terms, artifact recording, receipts,
digests, workspace/source machinery, validation gates, protocol operations, and
opaque validator or blocker copy. Reconcile them internally whenever safe.
Translate an unavoidable constraint into the smallest product-domain question
with a visible tradeoff and recommended default. If no product answer can
resolve it, explain the unavailable outcome and offer a product-level
alternative. Phrase every approval in plain language around the concrete
external effect.
