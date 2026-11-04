# Local planning source baseline custody

A local development generation can include uncommitted app files and shared
registration changes. Its frozen `workspaceDigest` hashes regular-file bytes and
executable modes, including the byte-hash prefix used by the existing development
inventory. A historical Git commit alone cannot reconstruct that generation.

Owner-bound baseline artifacts live under the same qualified local instance
state authority as its `runs` directory:
`source-baselines/<originalSourceSha>/<workspaceDigest>/source.git`, alongside
`manifest.json`. The original source SHA and frozen workspace digest form the
lookup tuple. The manifest identifies a separate capture commit and tree; a new
capture never claims to be an old session, approval, run, cycle or journal.

The shared writer accepts only an owner-private canonical authority root and
actual Git pack bytes. It checks the capture HEAD/tree, retained original commit,
and independently hashes every committed regular file before publishing. Real
shallow boundaries retain available historical objects without inventing missing
ancestors. It syncs owned files/directories and publishes the new directory
atomically. Manifest publication follows complete Git materialization; incomplete
staging directories remain unselected for inspection.

Repeated custody of the same tuple and tree preserves the first immutable
capture and provenance. Different genuine source SHAs with identical file bytes
have independent namespaces. A changed captured tree, including symlink objects
excluded by the legacy regular-file digest, remains a conflict rather than
silently replacing the retained capture. Reader checks must require the exact
frozen original SHA/digest and verify the stored bytes again.

Source retention grants no Build, publication, provider, database or approval
capability. Existing journals, approvals, uncertain requests and current app data
remain separate. An explicit source-only recovery can reconstruct missing custody
from genuine original Git objects and verified archives only when the entire
computed inventory exactly matches the declared frozen digest. It cannot admit
an approximate current checkout or change the meaning of a previous plan.
