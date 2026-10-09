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
store, not fresh database readiness proof. The native continuation then performs
fresh read-only Auth and Gateway checks without activating the credentials.

Under the existing physical resource lease, the target journal checkpoints an
encrypted v2 pending credential record before any plaintext is released. It
copies only the source Auth migrator and runtime passwords. The target's app
database receives a separately generated credential pair. The source
ciphertext is left untouched; a retry reuses the target's checkpointed
ciphertext. Legacy v1 records keep their existing behavior.

The v2 record is not yet authority to use credentials. Until v2 bindings,
read-only resource adoption, and app retirement are composed, all three paths remain
blocked. Adoption preparation checkpoints the pending record, verifies Auth
readiness with the pending runtime credential inside the trusted control plane,
and verifies the canonical Gateway rows through read-only provider requests.
It then returns `reconciliation_required` before worker or provider mutation. It must not recreate
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
change requires a new plan and approval. The plan also freezes the canonical
Gateway row references and verified value hashes from the source journal.
Existing journals without those hashes need ordinary verified Gateway binding
readback before they can supply an adoption plan. A provider comment alone
never supplies ownership.

## Read-only preflight

The Auth verifier validates the exact target-owned Auth artifact and readiness
asset, reads `_auth_schema_readiness.read_current()` in a read-only transaction
using the sealed restricted runtime credential, and compares database, login,
role, target, asset and catalog fingerprint to the independently published
source readiness. Source and target authorization, approval, lease and journal
state are rechecked across awaits. Only the readiness proof returns; the
checkpoint remains pending and generic credential readers remain blocked.

Gateway preflight resolves the exact approved source under current owner
authority. Its complete five-row snapshot must match the source journal and
the frozen target approval. Provider GETs check project, branch, key, row ID,
original operation comment, Preview target, encrypted type, unmanaged status
and current value hash. No runtime URL, app deployment selection, provider
write or target checkpoint is needed for this inspection. Ordinary Gateway
binding readback saves value hashes only for values it actually verified and
preserves sibling app policies and deployment projections during merges.
Before an adopted Gateway PATCH, it checkpoints the exact intended value hash
under the current operation so a lost response can be reconciled by readback.
Unresolved pending writes cannot supply canonical ownership for a new adopter.

## Required continuation before release

For fresh resources, schema reconciliation can mark the Auth schema effect applied when
the existing readiness record matches the approved target and readiness asset.
If readiness does not match, populated Auth state is unknown and blocks. An
absent result is returned only after an empty public namespace check. Keep this
distinction: readiness may short-circuit an already prepared shared realm,
while absent or unknown state must never authorize the genesis proposal as an
adoption migration. Adoption has its own path: a missing, failed or successful
preflight never falls through to an empty-namespace probe or Auth schema worker.
Until lifecycle activation is implemented, it returns reconciliation-required.

The original app's cleanup changes its source journal plan and approval and
drops its saved Auth preparation, while retaining shared Auth and Gateway
resources. Activation must therefore create independent target ownership that
survives source-first cleanup. Later adoption must resolve retained canonical
ownership through an adopter chain without requiring the originating app to
stay prepared. A pending checkpoint and successful preflight do not solve that
lifecycle requirement.

Before enabling v2, integrate verified activation, binding, app bootstrap and
sibling-preserving retirement, including source-first cleanup and later
adopters. Tests and evidence for this prerequisite should remain
separate from provider enrollment and hosted two-app acceptance; this document
does not claim either result.

## Source acceptance

The original prerequisite acceptance covered 85 tests across shared Auth adoption,
legacy resource credentials, native composition, the protected operator, and
owner-context deployment. The adoption fixtures preserve source ciphertext,
copy only Auth passwords, allocate independent app passwords, deny foreign or
revoked authority, reject stale/missing/unknown state and physical collisions,
and recover an interrupted checkpoint without generating replacements. They
also exercise concurrent creation, caller mutation across awaits, lost leases,
and missing checkpoint acknowledgement. Native composition is exercised through
its reconciliation and execution entrypoints: it seals the checkpoint and
blocks without worker/provider mutation. Continuation tests additionally cover
fresh read-only verification, canonical Gateway ownership and value changes,
and the valid app-only retirement worker context. Test results are reported with
the source commit; they do not establish deployed continuity.

The integrated continuation passed 192 focused tests in nine files, scoped
TypeScript, changed-file typed lint and whitespace checks. Lease renewal is
covered: expiry may advance while the same lease, operation, approval, resource
identity and ciphertext remain fixed. Caller data and callbacks are captured
before awaited verification.
These are source fixtures with no database or provider effects. No real second
app, existing Auth users/sessions, native deployment, or hosted continuity has
been qualified. The coordinator must approve and execute that separate proof
after the continuation above is complete.
