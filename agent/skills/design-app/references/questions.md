# User Input and Interview Questions

## Question policy

Classify every question before asking it:

| Class                 | Meaning                                                                   | Behavior                                                                |
| --------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| HTML blocker          | Missing JTBD or desired interfaces                                        | Ask one concise question and wait.                                      |
| Prototype-shaping     | Answer materially changes the first visible workflow                      | Ask early; use a labeled assumption and continue if reasonably safe.    |
| Discovery-value       | Helps refine realism but does not change the next prototype               | Record it and ask during feedback, no more than three at once.          |
| Build blocker         | Production meaning, authority, or data contract cannot be inferred safely | Ask before the build-ready gate and wait.                               |
| Implementation detail | Autograph can decide from target-repository contracts and evidence        | Do not burden the user; decide during planning and explain if material. |

Prefer one question. Ask two or three together only when they concern the same
visible decision. Explain the assumed default when the question is nonblocking.

## Minimum HTML gate

Ask only when missing:

- “What is the person trying to accomplish with this app?”
- “Which interfaces would help them do that—a dashboard, table, form, detail
  view, import flow, timeline, planning surface, or something else?”

If “interface” is ambiguous, give examples rather than asking for technical UI
architecture.

## Prototype-shaping questions

### User and first use

- “Who opens this most often, and what should they do first?”
- “Who consumes the result even if they never use the app directly?”
- “What would make the first screen immediately useful with no connected data?”

### Workflow and decisions

- “What decision should this dashboard help someone make?”
- “Is this a separate workflow or the same records viewed with a different
  filter?”
- “When someone selects this item, should they inspect details, filter another
  interface, navigate, or begin an action?”
- “Which mistake would be most costly or embarrassing?”

### Interface shape

- “Should this be optimized for scanning many records or understanding one
  record deeply?”
- “Which controls must be immediately visible: search, filter, group by, as-of,
  comparison, scenario, or date range?”
- “Does the user need to compare states side by side or move through them over
  time?”

### Agent behavior

- “What should the agent proactively surface without being asked?”
- “Which actions may the agent propose, and which require confirmation or human
  review?”
- “What evidence should accompany an agent recommendation?”

## Questions during HTML iteration

Anchor questions to visible prototype elements:

- “The prototype groups spend by category. Should Vendor or Department also be
  available?”
- “The As-of control currently changes every chart. Should any interface retain
  the current state instead?”
- “This action opens a detail panel. Would filtering the transaction table be
  closer to the real workflow?”
- “This empty state offers CSV import. Is manual entry or a system connection the
  more realistic first step?”
- “The agent flags an anomaly here. Should it only explain it, prepare a change,
  or open a review flow?”

## Integration and data questions

These are valuable during iteration and blocking before production when their
answers change schema, authority, or scope.

### Sources and integrations

- “Where does this information come from today—file upload, manual entry, API,
  warehouse, or another system?”
- “Which system is authoritative when two sources disagree?”
- “How frequently must the data refresh?”
- “Do you need historical snapshots from the source, or only current values?”
- “Should imports create drafts for review or apply directly?”

### Data objects

- “What real-world things are represented here—for example vendors, employees,
  positions, invoices, contracts, or requisitions?”
- “What uniquely identifies each object across imports and connected systems?”
- “Which relationships are essential to the first workflow?”
- “Which values change over time, and what does ‘as of’ mean for them?”
- “Which fields are required to act, versus merely useful to display?”

## Build-blocking questions

Ask before build readiness when unresolved:

### Writes and review

- “Does this action change canonical records, prepare a draft, or only change the
  current view?”
- “Who reviews or approves a proposed change?”
- “Can changes take effect in the future or revise a past effective date?”

### Access and sensitivity

- “Who may view, propose, approve, and publish this information?”
- “Does the interface expose compensation, personal, financial, or contractual
  information requiring narrower access?”
- “Is access scoped only by customer, or are additional app-level restrictions
  needed?”

### Agent authority

- “May the agent read only, prepare proposals, or initiate reviewed changes?”
- “Which actions must never happen without explicit confirmation?”
- “What source evidence must remain attached to an agent proposal?”

### Acceptance and scope

- “Which prototype behaviors are required for the first production version?”
- “Which visible features are illustrative and intentionally deferred?”
- “Can you accept this walkthrough as the test for the first production build?”

## Questions not to ask users

Translate these internally:

- database table or physical column design;
- RLS policy syntax;
- `ApplyChangeSet` envelope details;
- package placement or import boundaries;
- generated-client implementation;
- composition registry or runtime bootstrap details; and
- test runner or deployment-command selection.
