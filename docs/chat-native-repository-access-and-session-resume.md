# Chat-native repository access and session resume

This document is the implementation contract for repository authorization,
web-to-chat handoff, and durable App Builder continuation. It applies to the
web App Builder, the MCP App control surface, the five public MCP tools, and the
hosted Eve adapter.

## Product boundary

- Repository access MUST be granted by the signed-in user through the GitHub
  App installation or update flow. App Builder MUST NOT edit its own GitHub App
  installation, treat a chat answer as access, or adopt caller-supplied
  installation authority.
- Before every repository read or publication, the server MUST re-read the
  current tenant, membership, installation, repository, permission, default
  branch, SHA, and tree from GitHub.
- The MCP App MAY render connection, selection, and approval controls. It MUST
  NOT render app prototypes. Prototype URLs open in the integrated Browser.
- Repository creation, applying changes, and opening a draft pull request remain
  distinct, product-facing approvals after access has been verified.

## Repository-access state machine

The server-owned access operation accepts a repository name or opaque handoff
reference. It never accepts an installation ID, repository ID, permission set,
SHA, or tree as caller authority.

1. Resolve the current Better Auth user, active organization, workspace, and
   GitHub installation bindings.
2. Re-read every candidate installation from GitHub.
3. If one installation can read the requested repository, bind the current
   repository ID, default branch, SHA, and tree and continue silently.
4. If no installation exists, park the session on **Connect GitHub**.
5. If installations exist but none includes the repository, park the session
   on **Update GitHub access**.
6. If several scopes can satisfy the request, ask the user to select a scope.
   If no repository was named, ask the user to select a repository.
7. After any callback or **Check access** action, repeat the provider readback.
   A click, redirect, callback, or text response is never proof by itself.

The authorization continuation MUST be short-lived, one-time, and bound to the
exact user, organization, workspace, public session, input request, repository,
and canonical App Builder origin. A denial, expiry, replay, wrong account, wrong
workspace, suspended installation, or still-missing repository leaves the same
session parked with a useful recovery action.

## Shared Store In surface

The web form and MCP App MUST consume one headless Store In model. The model
contains product-facing connection state, desired repository, connected scopes,
and the server-owned authorization URL. The same components use different copy
for a first connection and an access update.

Returning from GitHub SHOULD wake the parked session automatically. On focus,
the MCP App refreshes the session with `autograph_get`; **Check access** is the
lost-notification fallback. The control surface MUST remain keyboard accessible
and MUST never ask the user to type “Repository selected.”

## Opaque web handoff

The web App Builder passes only an opaque `handoffId` into chat. The durable
record owns the brief, Store In selection, provisioning outcome, and exact
tenant authority. It is valid for seven days until first redemption.

`autograph_start` resolves the handoff server-side and revalidates live provider
access. Redemption is idempotent: a retry after a lost response returns the
same public session. Stale or insufficient access preserves the brief and parks
that session on the same Store In flow.

## Durable user sessions

Public App Builder sessions MUST remain tenant-scoped and resumable until the
user explicitly deletes them. User-session retention is independent of short
compute leases, admission controls, and abandoned-turn detection.

Each durable session stores a product-facing title, inferred app identity,
current product stage, resumability state, adapter generation, checkpoint
digest, parent session when applicable, and bounded session-owned artifacts.
Checkpoints are persisted after settled turns, input boundaries, prototype and
plan revisions, and consequential authorization state. Provider credentials,
tokens, and raw authorization responses MUST NOT be stored in checkpoints.

Resume follows these rules:

1. Reuse a healthy Eve session.
2. Otherwise fence the prior adapter generation, create a new generation, and
   rehydrate from the last durable checkpoint.
3. Recreate repository state only after live access and immutable source
   identity have been revalidated.
4. Recover an abandoned `working` turn from the last settled checkpoint.
5. Permit concurrent reads but only one mutating continuation. A competing
   continuation receives a retryable product-facing result.

Legacy version-one sessions are upgraded lazily. A healthy Eve handle continues
directly; otherwise the service backfills from durable public events. Deleted
and cross-tenant handles remain indistinguishable. When exact continuation is
impossible, the user may restart from the latest recoverable product result.

## Public tool contract

The public endpoint remains `/mcp` and exposes exactly:

- `autograph_start`
- `autograph_get`
- `autograph_send`
- `autograph_respond`
- `autograph_cancel`

`autograph_get` without a session ID returns a paginated tenant-scoped index of
recent sessions. `autograph_start` accepts exactly one of a new prompt, a
`handoffId`, or a `resumeSessionId`. Existing cursor, full-batch response,
idempotency, lost-response recovery, and cooperative cancellation semantics
remain unchanged.

The plugin instructions MUST query recent sessions before starting a duplicate
when the user asks to continue, resume, or pick up an app.

## Regression expectations

The implementation and tests MUST prove:

- “Repository selected” cannot advance a session without live provider access;
- Connect and Update access use the shared control surface and resume the same
  public session only after an exact provider readback;
- a valid web handoff redeems once and retries to the same session;
- session listing, pagination, checkpoints, adapter fencing, concurrent resume,
  interrupted-turn recovery, and legacy upgrade remain tenant isolated;
- repository rename, transfer, deletion, archival, permission loss, and
  installation suspension return to Store In without discarding product work;
- publication rechecks write access and never writes the default branch without
  its separate approval; and
- tool discovery remains exactly five, with no prototype rendered in the MCP
  App.
