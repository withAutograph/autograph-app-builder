# Task-first information composition

Apply this guidance to every new app and material revision, not only review
queues. It shapes design choices; it is not a runtime validator, required page
template, scoring threshold, or extra approval step.

## Compose meaning before containers

Identify the user's immediate task, the information needed to do it, and the
next useful action. Give each piece of information a role: identity, status,
evidence, input, recommendation, action, or supporting metadata. Arrange those
roles for this task rather than filling available cards or copying an example's
layout. Keep this reasoning internal; do not add a design questionnaire.

- Separate page purpose from workload counts, sorting, instructions, and record
  metadata. Keep counts, filters, and sorting with their collection, including
  when desktop panels narrow; keep help beside the relevant action or field. A
  subtitle must not become a catch-all sentence. Omit redundant instructions.
  Keep collection summaries concise. When useful instructions need more room,
  use a supported full-width description below the heading and metadata rather
  than stacking prose inside a right-aligned summary. Preserve the wider
  composition when only the constrained view needs this help.
- Establish hierarchy with Arrusted's supported typography, spacing, and
  surfaces. Use consistent roles for headings, primary values, explanations,
  labels, and metadata. Do not solve hierarchy by enlarging everything, making
  needed text unreadably small, or overriding the palette.
- Group related information by proximity and descriptive section headings.
  Separate groups more clearly than items inside a group. Counts and summaries
  belong with their section, not at a disconnected edge. Status needs readable
  wording, not color alone. Never invent thresholds or business definitions to
  make a grouping sound authoritative.
- Make rows easy to compare: emphasize identity and the task's deciding fields;
  subordinate identifiers and supporting metadata. Do not turn every fact into
  a badge or repeat a group's status mechanically on every row when it adds no
  value. Preserve row status when mixed, detached, or filtered views need it.
- Keep evidence needed for one decision visible together. Tabs are for distinct
  tasks or substantial alternate views, not a way to separate three related
  fields. Use progressive disclosure for genuinely secondary information. Decide
  what is secondary by its role in the decision, not by its domain or section
  name: a delivery estimate, permission scope, or cost can be essential evidence.
  When users expand content, reveal it within its existing scroll region so the
  requested information is discoverable without losing context.
- Structure detail views around the question being answered. For a decision,
  explain the issue and relevant evidence before the recommendation and action.
  When a recommendation is derived, explain beside it how key inputs and
  constraints, such as rounding, produce it. Combine redundant intermediate
  rows rather than repeating facts or leaving the reader to infer the formula.
  For a result state, lead with the outcome; calculation inputs support its
  explanation rather than displacing it. Keep the baseline available beside the
  result when understanding the change is part of the decision.
  For reference content, identity and navigable facts may come first. Avoid
  repeated warnings, metric duplication, arbitrary empty panels, and filler.
- Keep the primary action near the information that justifies it. Explain its
  visible effect; distinguish a simulated outcome from changed record facts.
  Preserve selection, logical reading order, keyboard focus, and task context
  when desktop panels narrow. Do not force a new navigation pattern if the
  existing composition remains useful.
- In a constrained detail view, avoid repeating the full page introduction
  above navigation and record identity. Preserve orientation and a clear way
  back; keep the wider overview unchanged when it still supports comparison.
- When a calculation explains an action, expose its meaningful steps as short
  labeled facts using existing detail components. Preserve assumptions and
  quantities; do not replace them with decorative metrics or invented context.
  Name the same measure consistently across evidence, confirmation, and result
  states. Explain any calculation basis that could change interpretation before
  the user acts; detailed derivations may use existing progressive disclosure.

## Make the next step legible

- Distinguish selecting a value from opening a record or starting an action.
  When a row opens details, use a supported link or contextual row action when
  selection alone is unclear. Preserve visible selection and keyboard behavior;
  do not add a redundant button to every row or a global instruction paragraph
  when the existing interaction is already obvious.
- If an initial record is suggested before the user opens it, label that
  suggestion rather than implying the user already chose it. Keep guidance
  consistent with the visible state: invite opening when details are absent,
  and reviewing or changing the selection when details are already present.
- When ordering affects interpretation, label its basis beside the results
  (for example, “Sorted by: newest”). Keep it readable and subordinate to the
  records. A passive ordering label must not look like an interactive control;
  a changeable sort must use a real supported control. Do not invent sorting
  requirements for forms or reading views.
- Summarize a consequential outcome near its section heading with concise text
  or a supported status treatment, then show the evidence that explains it.
  Distinguish predicted risk from actual failure or a breached promise. Avoid
  repeating the same warning in a badge, heading, and paragraph; ordinary facts
  do not all need badges. Preserve the Arrusted palette and supported variants.
- Let action areas accommodate realistic long labels, values, and resized
  desktop panels. Use supported wrapping or stacked arrangements when needed
  rather than clipping, tiny text, fixed heights, or arbitrary minimum widths.
  Keep contextual help adjacent and the primary action identifiable. Check a
  representative long-content state during the normal material-revision review,
  not through another automatic acceptance gate.
- Size simple choices for the content they contain. A wide page need not produce
  page-wide selects or long spans between labels and values. Let substantial
  comparison or reading content use the space; keep small control groups compact
  but flexible within their panel, avoiding fixed widths that force needless
  wrapping while usable space remains. Bound prose and sparse
  label-value regions to a comfortable measure; spare width can be outer space
  rather than oversized panels. Do not impose a fixed maximum on dense comparisons.
- In an action-oriented detail panel, account for the page heading, filters, and
  navigation above it when choosing the available height. A full-viewport panel
  placed below page chrome can push its action out of reach. Prefer sizing that
  follows content within the available space over fixed height that leaves an
  unused band between evidence and action. Use the shared
  composition's scrolling body and non-overlapping action region when appropriate;
  ordinary document scrolling remains valid for reading-oriented pages. Ensure
  action feedback can be read completely, not hidden underneath a footer.
- Choose supported type and status sizes by information importance. Small
  secondary styling suits incidental metadata, not the sole presentation of a
  deciding status or fact. Avoid duplicating that fact simply to make it legible;
  use a readable supported status variant that retains meaningful distinctions
  between states without changing palette tokens. A badge can name a state while
  its deciding quantity uses ordinary readable text nearby.
- Give related panes one coherent empty-state explanation. Distinguish no
  matching records from records available but none selected; do not invite an
  impossible selection. Offer the relevant recovery, such as adjusting filters,
  without repeating contradictory placeholders in each pane.

## Different tasks need different compositions

These are examples of reasoning, not mandatory sections or layouts:

| Task                        | Useful organization                                                         | Avoid                                                                      |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Review an exception         | Priority groups; deciding fields; evidence and proposed action together     | A generic dashboard or supplier tabs hiding decision-critical facts        |
| Submit an equipment request | Related field groups; help beside fields; request summary and submit action | Severity groups, needless metric cards, or a queue copied from another app |
| Compare performance         | Scope/time context; comparison and trend; drill-in evidence                 | Unrelated headline numbers with no comparison basis                        |
| Find and edit a record      | Search and identity; structured facts; clear edit/save/cancel state         | Treating ordinary reference data as a risk assessment                      |

## Arrusted is the reusable visual foundation

Prefer a suitable public composition, then compose public components with their
supported props and variants. Read the current implementation/example when an
API is uncertain. Use the target's Typography roles, semantic tokens, theme,
fonts, and providers; preserve its palette. Ordinary route layout, data mapping,
and state wiring are legitimate composition, not new visual components.

Do not restyle a primitive into a replacement control or copy private component
internals into a generated app. If a visual capability is genuinely missing:

1. Inspect current public alternatives; prefer adapting an existing component
   or composition over creating a competing one.
2. Record the concrete missing capability in the existing catalog-gap field.
   Continue with the best useful existing composition when possible.
3. In authorized Arrusted maintenance work, add the smallest domain-neutral
   shared capability with supported props, exports, a real usage example, and
   focused interaction/accessibility coverage. Keep app-specific copy and data
   in the consuming route. Update the existing catalog, not a second registry.
4. Use the shared API once available. A generated-app request does not itself
   authorize modifying or publishing the shared Arrusted repository.

Missing examples are not eligibility failures. Try current APIs and respond to
actual renderer errors. Do not create a new mandatory composition component for
every app or make shared-library work block an otherwise useful preview.

## Carry the design through implementation

Preserve the reviewed information roles, component composition, hierarchy, and
interaction behavior when replacing fixtures with real data. Use the existing
product walkthrough to check whether the user can identify the task, understand
the deciding information, and find the next action. Do not add automatic scoring,
repair loops, full-walkthrough repetition, or setup prompts. The first normal
product approval remains **Build this app?**.
