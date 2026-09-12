# Server-first builder delivery status

## Delivered in this slice

- Handoff continuation accepts an acknowledged draft ID/revision, reads the
  tenant-owned snapshot server-side, persists the handoff, and conditionally
  archives that revision. A newer concurrent draft is retained.
- Draft saves and archival serialize under a tenant-scoped database transaction
  lock. Delayed saves cannot resurrect archived drafts or overwrite a different
  active draft.
- The mounted React Hook Form remains available after a failed continuation.
  A lost response can retry the saved checkpoint with the same idempotency keys
  without attempting to save an archived draft again.
- An anonymous brief is claimed through authenticated autosave and removed from
  browser storage only after acknowledgement of that same brief.
- Handoff progress validates snapshots, rejects regressive revisions, preserves
  reconnect cursors, offers retry, and refreshes once on settlement.
- Handoff renewal uses a typed Server Action result; status polling stays a read.
- Loading shells expose meaningful text without duplicate interactive controls.
  Instant-navigation assertions accept either a useful shell or already-prefetched
  content while navigation-time server responses are paused.
- The authenticated builder is server-composed: `AuthenticatedBuilder` passes
  `BuilderFormContent` through the client continuation/form boundaries as React
  nodes. The server owns section fieldsets, headings, descriptions and feature-
  gated composition; focused client leaves own editable controls and save status.
  The client form never imports the server content. RHF, revision reconciliation,
  outbox recovery and provider flush sequencing remain in the client controller.
- The anonymous page has a server-rendered header, title and explanatory content
  around a narrow browser-local brief island. The old monolithic `app-builder.tsx`
  and its compatibility imports are removed; controls use `SearchCombobox` directly.
- Shared theme/query providers no longer wait for auth configuration. Request-fresh
  Better Auth configuration is resolved under route-local Suspense boundaries,
  exposing the destination's builder, auth, provider or handoff shell on direct
  loads as well as client navigations. Auth flags are never guessed or cached.
- `mise run maintenance:builder-drafts` provides the operator entry point for
  abandoned active-draft cleanup. See [maintenance instructions](builder-draft-maintenance.md).

## Still required to finish the original plan

- Connect draft maintenance to an authorized deployment scheduler. The operator
  task is not evidence that periodic cleanup is deployed; the repository has no
  existing scheduler credential boundary to reuse.

Server Actions remain the normal mutation transport. Page-hide keepalive is the
draft transport exception; browser storage is not provisioning lifecycle truth.
Local emulated tests do not prove live provider or native-client acceptance.
