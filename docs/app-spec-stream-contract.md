# Streamed AppSpec acceptance

Hosted `prototype/<app-id>/app-spec.md` is recorded as a v2 prototype artifact.
Each ordered UTF-8 chunk is written under the tenant, session, path, expected
full-content digest, and chunk index. The final artifact manifest is published
only after every chunk, total byte count, full SHA-256 digest, and revision are
verified. A retry of the same last call returns its saved receipt; a changed
chunk or stale base revision cannot advance the transfer. `get_prototype_artifact`
returns exact digest- and revision-bound pages.

The v2 acceptance input is the completed artifact reference, never content
copied from a tool response. Acceptance verifies the manifest again, scans all
required headings once, checks the exact terminal status-only `Build handoff`,
and derives the acceptance walkthrough. The accepted record stores `version: 2`,
the artifact path and revision, its SHA-256 digest, and that walkthrough. It
does not store the full Markdown. Canonical v2 bytes use LF line endings and
the exact handoff block from the authoring skeleton. If a draft needs
normalisation, the writer must rerecord canonical content before acceptance;
the accepted digest therefore always binds the bytes returned by exact
readback and written to the planning overlay.

The v1 path remains readable. An identical retry of a v1 artifact keeps its
v1 receipt, and a previously accepted v1 snapshot keeps its original content,
normalisation, digest, and downstream receipts. New v2 acceptance never
rewrites an already accepted revision. Planning writes verified chunks to its
overlay with the sandbox's native streamed file API. Independent source review
reopens verified chunks for bounded requirement excerpts against each source
page, preserving the exact accepted digest in its evidence binding. The v1
review interface retains its inline compatibility path.

Legacy GitHub publication v2 proposals, journals, success receipts, exact
readback, and existing-draft updates still bind a complete selected-repository
ID array. The provider adapter pages and deduplicates it, but the authority
contract retains the array. A future publication v3 must introduce a
digest-bound streamed inventory reference through all of those contracts
before the array can be removed safely; the v2 contracts remain authoritative
until then.
