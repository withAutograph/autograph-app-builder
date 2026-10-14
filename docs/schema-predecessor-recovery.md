# Schema compilation in a saved app

The normal Builder schema tool keeps the accepted app's GitHub repository and
branch binding across source inspection and workspace preparation. Before
compiling an applied app, it refreshes shared platform source through the
existing source reconciliation path. That path checkpoints authored bytes,
preserves app product files and checked releases, and retains the current
dependency closure. Compilation invalidates current validation and behavior
eligibility before those writes; retained observations remain history.

For an existing local runtime, Builder calls
`mise run app:runtime resume-installed <app> local` against its existing
checkpoint. This resumes only the already-recorded local PostgreSQL cluster;
it does not initialize or replace a database. The runtime then reads actual
active release IDs and base artifact hashes. A missing checkpoint remains
`not-prepared`. Builder uses the receipt or a previously retained matching
immutable artifact reference to read the exact owner/session-scoped compiled
release. It never chooses a historical version by ordering or reconstructs lost
compiled bytes.

The checked release is restored from its retained members, and its exact schema
artifact is supplied outside the mutable checkout using
`APP_SCHEMA_TRANSITION_PREDECESSOR_FILES`. Arrusted's normal `app:compile` task
uses that explicit input for its transition plan and contract. A schema change
requires a new release ID when the old ID is already installed. If an internal
build agent reuses that ID for changed bytes, Builder restores the old checked
release and returns `schema_release_identity_reused` before recording a current
operator selection. The internal build agent authors the new ID and compiles
again; this recovery never changes authored CUE or the generated pointer itself.

After a successful compilation and capture, Builder retains the original
predecessor references in the owned session. Validation reuses those inputs for
`app:check` and `app:test`, including prepared runtime execution. Runtime
preparation may install the newly compiled release; that does not replace the
compiler's original transition basis. Actual missing predecessor files are
restored through the existing owned artifact reader. Without a saved compilation
input, validation keeps the repository's normal behavior and compilation can
capture its inputs on the next ordinary Builder repair.

Older captures can recover a self predecessor when the owned archive matching
the current checked manifest declares the target schema itself as a predecessor.
Arrusted excludes that target release from its normal prior-release inventory,
so this proves an explicit compiler input. Recovery restores only the external
schema artifact and preserves the current checked release. An unproven legacy
basis falls back to ordinary repository validation; it does not introduce an
ordering requirement or block the next compiler-owned repair.

Missing or ambiguous retained history and unreadable installed identity return
`canonical_schema_predecessor_unavailable`. They do not authorize a database
reset, replacement app, cross-session artifact lookup or fabricated predecessor.
The saved public session remains the generation record; source fixtures establish
this orchestration only, and hosted preparation/app persistence need their own
normal workflow observations.
