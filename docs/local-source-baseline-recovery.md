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

## Explicit archive recovery

Run the maintained operation only after reviewing a source-only request:

```sh
mise run source:recover-local-baseline -- \
  --runs-root /absolute/existing-instance/state/runs \
  --request /absolute/reviewed-source-recovery.json
```

`--runs-root` must be the actual closed launcher's existing directory. The task
derives the inner authority state root from its parent and verifies that root,
`runs`, OS ownership/private permissions and the existing sibling `eve-cycle`
binding. It never creates a cycle or infers the root from an outer command-line
`--state-root` name. The request is strict JSON:

```json
{
  "originalSourceRoot": "/absolute/genuine-git-checkout",
  "originalSourceSha": "<40 lowercase hex characters>",
  "workspaceDigest": "<64 lowercase hex characters from the frozen plan>",
  "archives": [{
    "path": "/absolute/source-only.tar.gz",
    "sha256": "<actual archive SHA256>",
    "files": [{
      "path": "apps/example/source.ts",
      "mode": "100644",
      "sha256": "<actual raw file SHA256>"
    }],
    "ignoredMetadata": [{
      "path": "recovery-manifest.json",
      "sha256": "<actual raw metadata SHA256>"
    }]
  }]
}
```

Every regular archive entry must be declared exactly once as source or ignored
metadata. Directories are traversed only as archive metadata: no archive entry is
extracted into a filesystem destination. Traversal, links, special entries,
duplicate source declarations across archives, secret/runtime paths, incorrect
archive/file hashes and executable-mode mismatches are rejected. The source union
may replace genuine original Git files only with the explicitly declared bytes.
Ignored metadata is verified but never becomes repository source.

The operation creates a new capture commit with explicit recovery provenance,
retains genuine original commit/tree/blob objects and shallow boundaries, checks
the complete frozen inventory, and publishes through the shared immutable writer.
It reports only custody path and bounded identities. Private scratch capture packs
remain separate for inspection. No native state, approval, database, provider
configuration or app data is imported or rewritten. Matching custody is not a new
approval; normal product continuation still owns subsequent planning and effects.
