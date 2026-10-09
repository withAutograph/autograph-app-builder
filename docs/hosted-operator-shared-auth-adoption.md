# Shared Auth adoption prerequisite

This document describes the fail-closed prerequisite for a second app to use an
already prepared Auth realm. It does not establish hosted two-app reuse. The
current Builder Auth planner emits a genesis proposal carrying `new-empty`.
The existing schema worker is not an explicit read-only adoption worker.

## Target-scoped credential adoption

An app may optionally name `authAdoptionSource`, containing the complete
`hostedRuntimeTarget` of an existing app and the existing owner context hint.
The frozen plan must bind that source to the source journal digest, selection,
operation, approved plan, ciphertext hash, and exact physical Auth resource
identity. Source and target must resolve to the same current owner and
workspace under current authorization. Before adoption, the source journal
must still be current and approved, with complete saved Auth readiness and a
matching source artifact. These are reads of the protected journal and artifact
store, not fresh database readiness proof. Native readback remains a prerequisite
to releasing the sealed credentials.

Under the existing physical resource lease, the target journal checkpoints an
encrypted v2 pending credential record before any plaintext is released. It
copies only the source Auth migrator and runtime passwords. The target's app
database receives a separately generated credential pair. The source
ciphertext is left untouched; a retry reuses the target's checkpointed
ciphertext. Legacy v1 records keep their existing behavior.

The v2 record is not yet authority to use credentials. Until v2 bindings,
read-only resource adoption, and app retirement are composed, all three paths remain
blocked. Adoption preparation checkpoints the pending record, then returns
`reconciliation_required` before worker or provider use. It must not recreate
roles, rotate or regenerate Auth passwords, or fall through to a `new-empty`
schema install. Source cleanup, credential rotation, stale approval,
ambiguous journal state, or incomplete saved readiness blocks adoption. A
source or target change during an awaited check blocks completion. A CAS against
the target's prior private state prevents concurrent callers from replacing
the winning checkpoint. There is no source-journal write.

The exact approval must bind the source app and owner/workspace context; source
journal and operation identity; source selection and approved plan digest;
source encrypted credential hash; Auth project, branch, endpoint, database,
schema and migrator/runtime roles; target app and its separate physical
database and roles; Gateway project and branch; and the
explicit intent to retain shared Auth users, sessions, data, credentials and
Gateway settings. The operator must recheck these inputs at effect time. Any
change requires a new plan and approval. The continuation must additionally
freeze and approve exact shared Gateway row references before enabling reuse;
this prerequisite does not yet adopt those rows.

## Required continuation before release

The current schema reconciliation can mark the Auth schema effect applied when
the existing readiness record matches the approved target and readiness asset.
If readiness does not match, populated Auth state is unknown and blocks. An
absent result is returned only after an empty public namespace check. Keep this
distinction: readiness may short-circuit an already prepared shared realm,
while absent or unknown state must never authorize the genesis proposal as an
adoption migration.

The second app also needs cross-journal Gateway ownership readback. Current
binding inspection accepts managed environment rows only when their comment
matches the current operation or their exact row identity is already recorded
in that operation's journal. A fresh app journal does not contain the first
app's row references, so sibling-preserving projection merge cannot reach its
provider read. Add a read-only lookup of the canonical shared Gateway binding
record, verify the prior operation and exact project, branch, key, row ID,
comment, target, type and current value against the provider, then allow the
existing merge logic to preserve sibling bindings. Do not accept a row from its
comment alone or weaken the current ownership checks.

Before enabling v2, compose and prove the read-only Auth continuation and
cross-journal Gateway ownership path, then integrate v2 binding, bootstrap and
retirement flows. Tests and evidence for this prerequisite should remain
separate from provider enrollment and hosted two-app acceptance; this document
does not claim either result.

## Source acceptance

The focused acceptance pass covers 85 tests across shared Auth adoption,
legacy resource credentials, native composition, the protected operator, and
owner-context deployment. The adoption fixtures preserve source ciphertext,
copy only Auth passwords, allocate independent app passwords, deny foreign or
revoked authority, reject stale/missing/unknown state and physical collisions,
and recover an interrupted checkpoint without generating replacements. They
also exercise concurrent creation, caller mutation across awaits, lost leases,
and missing checkpoint acknowledgement. Native composition is exercised through
its reconciliation and execution entrypoints: it seals the checkpoint and
blocks without worker/provider credential access.

The scoped TypeScript check, changed-file lint and whitespace checks passed.
These are source fixtures with no database or provider effects. No real second
app, existing Auth users/sessions, native deployment, or hosted continuity has
been qualified. The coordinator must approve and execute that separate proof
after the continuation above is complete.
