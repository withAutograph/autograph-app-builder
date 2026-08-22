---
name: design-app
description: Turn a product idea into a rapidly iterated self-contained HTML prototype and a user-approved, build-ready AppSpec for a supported Autograph repository. Use for product discovery, app design, prototyping, or specification when requirements, integrations, or data objects are not yet fully known. Generic app-creation requests belong to $create-app.
---

# Design App

Use HTML as the discovery surface and a structured AppSpec as the production
handoff. Do not require a complete data model before showing the user something
useful. Do not let provisional prototype assumptions silently become production
decisions.

Prototype files and previews require a discovered builder-owned artifact tool.
If it is unavailable, stop after product discovery and report that prototype
delivery is not implemented. Never substitute the generic file writer or claim
that an HTML artifact was created or shown.

## Communication rule

Explain every technical term the first time it appears with one short sentence
that says what it means for the user or what happens next. In diagrams and
status reports, never rely on labels such as AppSpec, routing, temporal,
provenance, generated client, or build gate by themselves; pair each with plain
language such as “the agreed blueprint for the real app” or “the point where the
user confirms that development can begin.”

## Load references

- Read [questions.md](references/questions.md) before asking discovery questions.
- Read [app-spec.md](references/app-spec.md) when creating or updating the
  decision ledger, checking build readiness, or handing off to implementation.
- Read [target-repository-routing.md](references/target-repository-routing.md) before grounding the
  prototype or planning the production app.

## Artifacts

Choose one lowercase kebab-case app id and maintain these together under
`prototype/<app-id>/`. The prototype slug and future app id must be identical.
Before creating the directory, use the builder-owned identity operation
declared by the selected adapter. Never construct or guess a repository script
path.

- `index.html` plus additional self-contained HTML pages when interfaces require
  them;
- `app-spec.md`, using the contract in `references/app-spec.md`; and
- `decisions.md`, recording user-stated facts, evidence, assumptions,
  confirmations, defaults, unresolved questions, and explicit deferrals.

The HTML is not production code, schema authority, or persisted-data authority.
The AppSpec is not build-ready until the user accepts it explicitly.

## Phase 0: Minimum HTML gate

Require only:

1. a job to be done; and
2. one or more desired interfaces.

Interfaces are user-facing surfaces such as a dashboard, table, form, record
detail, timeline, kanban, import/reconciliation flow, planning canvas, or agent
chat—not APIs or TypeScript interfaces.

If either minimum input is absent, ask one concise blocking question. Do not
start domain research or generate HTML until both exist. Do not block HTML on
personas, integrations, data objects, fields, permissions, or delivery details;
infer plausible provisional choices, label them, and make them easy to revise.

## Phase 1: Focused exploration

Research enough to make the prototype credible:

1. learn domain terminology, current tools, best practice, and common failures;
2. identify day-to-day users and consumers of the output;
3. refine the decisions, cadence, first-use behavior, and failure states inside
   the stated JTBD;
4. propose likely data sources and reconciliation issues as assumptions; and
5. identify concrete proactive and on-demand agent value.

Do not turn this into a mandatory pre-prototype interview. Ask only questions
that would materially change the first HTML. For valuable but nonblocking
questions, state the assumption and continue unless the user answers in time.

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

Never infer build readiness from praise of the HTML. Present the AppSpec's
confirmed decisions, accepted defaults, explicit deferrals, and remaining
blockers separately.

After explicit acceptance, add exactly one `## Build handoff` JSON block using
the strict shape in `references/app-spec.md`. It contains only the
non-derivable decisions needed by app preparation. Omit it while the AppSpec is
still exploring.

## Phase 6: Build-ready gate

Stop and request explicit user acceptance before final application development.
The gate passes only when:

- the user accepts the HTML experience and interface inventory;
- every visible value has a confirmed or explicitly provisional production
  source;
- integrations and data objects are confirmed or deliberately deferred;
- every control and action has defined host behavior;
- temporal, write, review, provenance, permission, and agent boundaries are
  settled for the first version;
- blocking `agent_inferred` and `unresolved` items are confirmed, replaced by an
  accepted default, deferred, or made a non-goal; and
- the user accepts the AppSpec and acceptance walkthrough.

Before passing the gate, confirm the accountable owner, whether the app owns a
kernel schema, any exceptional public routes beyond the conventional app-id
routes, and provider-neutral integration or hosted-resource capabilities. Then
set the strict Build handoff status to `build-ready`; do not add provider
configuration or mechanical repository identities to it.

If the gate fails, return the specific uncertainty to the prototype loop. Do not
paper over it with implementation assumptions.

## Phase 7: Production handoff

After acceptance, return control to `$create-app` with the app id so the same
user task can bind the exact AppSpec bytes, produce the read-only proposal, and
request separate source/topology approval. If invoked directly for an app the
user intends to build, continue into `$create-app` without asking the user to
start another task. Do not create production source or topology in this skill.
