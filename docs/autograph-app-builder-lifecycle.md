# Autograph App Builder lifecycle

Autograph App Builder takes a product idea from a short brief to a reviewed,
validated implementation proposal. It keeps the conversation focused on the
product and asks for input only when a decision would materially change the
result.

## The user-facing flow

### 1. Understand the brief

The builder identifies the job to be done, the people involved, the desired
outcome, and any explicit constraints.

### 2. Choose safe defaults

It infers a concise app name, app ID, initial interface pattern, navigation,
roles, and provisional behavior. Explicit choices are preserved. The builder
asks a question only for a material ambiguity, unsupported identity, or real
collision.

### 3. Create an interactive prototype

It creates a self-contained, clickable prototype with realistic and consistent
sample data. The prototype makes navigation, controls, actions, first-use,
empty, loading, and error states visible.

### 4. Iterate with the user

The user reacts to what feels wrong, missing, unnecessary, or unlike their
work. The builder revises the prototype first, then resolves the next
highest-value uncertainty with a small number of focused questions.

### 5. Define production behavior

The builder settles the production meaning behind the approved experience:
data and integrations, routes, controls, writes, review and approval behavior,
provenance, permissions, agent responsibilities, failure behavior, non-goals,
and the acceptance walkthrough.

### 6. Reach build-ready status

The builder checks that the experience and its production behavior are complete
enough to implement. Internal preparation and completeness repair are silent.
The user is interrupted only if an unresolved product decision genuinely blocks
the build.

### 7. Prepare the implementation proposal

The approved experience is mapped to the target repository. The builder
produces a concrete, read-only proposal describing the app changes before any
target checkout or external system is changed.

### 8. Review and validate locally

After the appropriate authorization, the builder prepares its changes, runs the
fixed local checks and tests, and presents the ordered result for review.

### 9. Authorize consequential effects separately

Applying changes to an existing checkout, opening a pull request, publishing,
deploying, changing providers, or creating external resources each requires
authorization for that specific outcome. Approval for one outcome does not
authorize another.

## Durable session behavior

Every build is a tenant-scoped durable session that remains resumable until it
is explicitly deleted:

- `autograph_start` begins a build, redeems an opaque web handoff, or resumes a
  selected durable session.
- `autograph_get` lists recent sessions when no ID is supplied and reads new
  progress and evidence when a session ID is supplied.
- `autograph_respond` answers the complete current batch of input requests.
- `autograph_send` sends an unrelated follow-up while the session is waiting.
- `autograph_cancel` requests cooperative cancellation.

`waiting` means the current turn has settled and the session can continue.
`input_required` means the exact outstanding request must be answered first.
Cancellation is complete only after a public event proves the resulting state.
User-facing sessions remain discoverable until explicitly deleted; compute and
active-turn leases remain short-lived implementation boundaries.

## What counts as completion

An accepted prototype or specification is not, by itself, a completed build.
Completion requires evidence of the relevant later state: a reviewed proposal,
successful local validation, or a separately authorized and proven external
effect.

## Source documents

This overview summarizes the detailed [design workflow](../agent/skills/design-app/SKILL.md),
[create-app workflow](../agent/skills/create-app/SKILL.md), [orchestration
workflow](../skills/autograph-app-builder/SKILL.md), and [session
semantics](../skills/autograph-app-builder/references/session-semantics.md).
