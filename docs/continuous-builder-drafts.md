# Continuous App Builder Drafts

## Goal

Persist an authenticated App Builder draft in `sessionStorage` so an
unfinished app survives refreshes and provider redirects within the current
browser tab. Because the latest draft is continuously saved, reloading or
navigating away must not show a native unsaved-changes warning.

## Persistence contract

- Store the latest draft at a stable, tab-scoped key in addition to the
  existing UUID-keyed provider-resume drafts.
- Restore a valid UUID-keyed draft when the URL supplies `?resume=`. Otherwise
  restore the latest tab draft.
- Keep the serialized draft backward-compatible with existing provider-resume
  records. The normal draft has no provider focus target; a provider-resume
  draft retains its focus target for the return flow.
- Save only after the post-hydration random app name is finalized, then save
  every draft-relevant change: builder form values, app/repository ownership
  flags, repository privacy, selected provider scopes, model and Zero Data
  Retention selection, connection selections, and connection-browser state.
- When starting a GitHub or Vercel connection, snapshot the same state under
  the new UUID key before redirecting. Keep the regular tab draft current as
  well.

## Lifecycle

- Remove the dirty-state marker, `beforeunload` handler, and related provider
  redirect suppression.
- On app handoff, clear the regular tab draft and any active provider-resume
  draft before transitioning to the handoff screen.
- On **Create Another App**, clear those drafts and remount a fresh Builder so
  it receives a new random app name and matching repository name.
- Drafts remain private to the browser tab and disappear when that tab closes.
  This work adds neither cross-device persistence nor a visible saved-state or
  discard UI.

## Verification

- A generated initial name and repository are stored after hydration and are
  restored after a simulated reload.
- Edits to all persisted form and selection fields, including ownership flags,
  restore without overwriting user-entered names or repositories.
- A valid provider-resume draft takes precedence over the regular tab draft,
  retains its provider focus behavior, and remains compatible with the current
  serialized draft shape.
- Reload does not prevent unload after edits.
- Handoff and reset clear their relevant stored drafts and start a fresh
  Builder.
- Run `mise run format-check`, the focused App Builder unit tests, and `mise
run typecheck`. Exercise a browser reload when the local authenticated
  Builder route is available.
