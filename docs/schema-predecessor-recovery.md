# Schema compilation in a saved app

The normal Builder schema tool keeps the accepted app's GitHub repository and
branch binding across source inspection and workspace preparation. Before
compiling an applied app, it refreshes shared platform source through the
existing source reconciliation path. That path checkpoints authored bytes,
preserves app product files and checked releases, and retains the current
dependency closure. Compilation invalidates current validation and behavior
eligibility before those writes; retained observations remain history.

For an existing local runtime, Builder calls the repository-owned read-only
`mise run app:runtime installed <app> local` against its existing checkpoint.
The runtime reads actual active release IDs and base artifact hashes. Builder
uses those facts or a previously retained matching immutable artifact reference
to read the exact owner/session-scoped compiled release. It never chooses a
historical version by ordering or reconstructs lost compiled bytes.

The checked release is restored from its retained members, and its exact schema
artifact is supplied outside the mutable checkout using
`APP_SCHEMA_TRANSITION_PREDECESSOR_FILES`. Arrusted's normal `app:compile` task
uses that explicit input for its transition plan and contract. A schema change
requires a new release ID when the old ID is already installed. If an internal
build agent reuses that ID for changed bytes, Builder restores the old checked
release and returns `schema_release_identity_reused` before recording a current
operator selection. The internal build agent authors the new ID and compiles
again; this recovery never changes authored CUE or the generated pointer itself.

Missing or ambiguous retained history and unreadable installed identity return
`canonical_schema_predecessor_unavailable`. They do not authorize a database
reset, replacement app, cross-session artifact lookup or fabricated predecessor.
The saved public session remains the generation record; source fixtures establish
this orchestration only, and hosted preparation/app persistence need their own
normal workflow observations.
