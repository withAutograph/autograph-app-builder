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

### 3. Create a component-backed UI preview

It prepares the exact Arrusted source, inspects public components and
compositions plus their real production consumers, and creates a fixture-backed
React UI in a disposable overlay. Navigation, controls, actions, first-use,
empty, loading, and error states work without APIs, persistence, or backend
implementation.

### 4. Iterate with the user

The user reacts to what feels wrong, missing, unnecessary, or unlike their
work. The builder revises only the UI and its synchronized internal design
manifest, then resolves the next highest-value visible uncertainty with a small
number of focused questions. The Browser remains a pure product preview.

### 5. Finalize the reviewed UI explicitly

Praise such as "looks good" does not start implementation planning. The user
must explicitly ask to finalize functionality for the exact current UI
revision. A later design revision invalidates that acceptance and returns the
session to UI review.

### 6. Define production behavior

The builder settles the production meaning behind the approved experience:
data and integrations, routes, controls, writes, review and approval behavior,
provenance, permissions, agent responsibilities, failure behavior, non-goals,
and the acceptance walkthrough.

### 7. Reach build-ready status

The builder checks that the experience and its production behavior are complete
enough to implement. Internal preparation and completeness repair are silent.
The user is interrupted only if an unresolved product decision genuinely blocks
the build.

### 8. Prepare the implementation proposal

The approved experience is mapped to the target repository. The builder
produces a concrete, read-only proposal describing the app changes before any
target checkout or external system is changed.

### 9. Review and validate locally

After the appropriate authorization, the builder prepares its changes, runs the
fixed local checks and tests, and presents the ordered result for review.
For a failed private apply, Builder names the failed repository command and
exit status, includes sanitized compiler or command diagnostics, and gives a
repair or retry instruction. If the response cannot carry all diagnostics,
preserve the complete sanitized output in retrievable storage and provide an
excerpt with a continuation reference; never discard the only copy. Follow the
[Builder workload capacity policy](builder-workload-capacity-policy.md).
For hosted app checks, each stdout and stderr channel is sanitized while it is
streamed to tenant and session scoped immutable chunks. A validation receipt
contains each channel's log ID, SHA-256 digest, byte length, and chunk count.
`get_validation_log` reads one authenticated page at a time using the exact
attempt digest, command, channel, log ID, digest, and returned cursor. The
caller verifies the assembled UTF-8 bytes against the digest. A filtered
repair excerpt marks `truncated` whenever it omits nonempty output or matching
lines that exceed its per-response budget. Sandbox cleanup leaves the durable
log readable until the durable session itself is removed by retention or
tenant deletion.
Dependency recovery uses the same streaming writer and authenticated reader.
The existing dependency probe precedes `bun install --frozen-lockfile`; a live
checkout with dependencies is reused. Each execution gets a digest bound to
its checkout identity, command, session and unique execution attempt. Before
surfacing failure, Builder saves both channel references, exit status, a bounded
sanitized excerpt and its truncation indicator in workflow state. Recover these
with `get_validation_log` using `operation: dependency-attempts` and page each
`dependency-probe` or `dependency-install` channel after compute cleanup.
Normal exit, including nonzero exit, publishes complete sanitized logs. The
optional `completion` metadata distinguishes complete capture, interruption,
and an unavailable durable suffix; legacy manifests retain their old shape
and read as complete. Page `complete` means only that paging ended. Storage
failure leaves the install running, continues bounded sanitized draining, and
reports unavailable durability while retaining any publishable acknowledged
prefix. Builder never repeats a successful install to repair logging. Persisted
byte lengths use SQL bigint; source content and dependency command contracts
remain unchanged.
Checkout-backed execution readiness uses the prepared checkout and its hosted
sandbox binding; absence of
an obsolete offline dependency cache is not an image-configuration failure.
Schema release compilation may follow an initial validation pass. It clears
that pass before changing the private checkout so normal app checks run again
against the compiled result before review.

### 10. Authorize consequential effects separately

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
[UI preview review options](ui-preview-review-experiences.md),
[create-app workflow](../agent/skills/create-app/SKILL.md), [orchestration
workflow](../skills/autograph-app-builder/SKILL.md), and [session
semantics](../skills/autograph-app-builder/references/session-semantics.md).
