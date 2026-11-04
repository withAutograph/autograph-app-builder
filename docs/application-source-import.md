# Application source in an authenticated Builder handoff

An application source candidate is untrusted source data. Its opaque upload ID,
app ID, and manifest digest identify one immutable owner-scoped artifact. They
are not repository ownership, publication permission, a Build approval, a Git
commit, or a migrated local session.

Handoff creation and redemption read the completed artifact independently and
validate the actual bytes and preserved app ID. Omitting `sourceCandidate`
preserves existing handoff intent digests and redemption behavior. The normal
single-session handoff reservation remains authoritative.

In the authenticated session, use `source_status` to acquire the genuine
platform source and import the prepared application. The original platform
`SourceReceipt` remains unchanged. `applicationSourceImport` reports the
separate upload digest, original source session, current authenticated session,
private workspace, platform receipt digest, and preserved app root. Ordinary
`accept_app_spec` and target planning retain that app identity. An unchanged
import can form an existing-app proposal; the normal fresh Build approval still
precedes application execution. The proposal binds the acquired platform's pure catalog registration plan; registration is written only inside the approved
private apply overlay. Review compares all imported app files against their
absent acquired-platform baseline, so unchanged uploaded bytes still receive
ordinary source review. Normal review and separate publication and
public-release approvals follow.

The importer stages bounded transport chunks outside the repository, checks
raw byte digests and modes, and installs only `apps/<app-id>` into an absent app
root. It never loads imported package scripts, mise tasks, or hooks. Shared
platform files remain acquired platform source. Binary assets and app-owned
schema history are ordinary source bytes. Secret, runtime-state, and cache paths
are rejected independently of the exporter.

An exact completed import marker permits continuation without overwriting later
app edits. A foreign binding, occupied app root, symlinked parent, altered bytes,
or an interrupted marker without its destination fails visibly and preserves
source for reconciliation. It does not adopt a Drive, replace an existing app,
copy native workflow state, or settle an uncertain provider operation. A new
Sandbox with no import marker must acquire source and materialize the original
candidate again; it cannot claim the previous workspace's authority.

See the [source handoff implementation plan](plans/2026-11-03-builder-application-source-handoff.md)
for the public export/upload journey and separate final hosted acceptance.
