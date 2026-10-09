# Shared Auth adoption and retained ownership

The native operator can adopt an already prepared Auth realm for another app.
It uses the existing owner-bound journal, encryption, approvals, compare-and-set
updates and physical resource lease. Each app keeps its own database and
migrator/runtime passwords. Adoption retains Auth users, sessions, data, roles,
passwords and sibling Gateway settings. Source tests do not establish hosted
multi-app continuity.

## Approval and retained provenance

An initial adoption names `authAdoptionSource`: the complete source runtime
target and owner context hint. The operator rechecks current owner/workspace
access to both apps. The plan freezes the source journal, selection, approved
prepare plan, operation, encrypted checkpoint hash, Auth physical identity,
readiness artifact and canonical Gateway row references with verified value
hashes. Source and target must have distinct app databases and roles.

Completed Auth ownership is retained in `retainedAuth` within the same journal
record. It contains the approved prepare plan, operation, call and approval,
complete receipts, verified Auth readiness and Gateway metadata. Auth-bootstrap
completion records it; an existing completed source can also record it before
replacing its plan, after rereading the original approval and checking that the
source ciphertext and completion evidence have not changed. Partial or
unapproved operations cannot create retained ownership. Gateway checkpoints
update retained row metadata through the existing fenced journal update.

App cleanup replaces the current operation and approval but preserves retained
Auth provenance and encrypted credentials. A later adopter can use that source
under fresh owner authorization and an exact read of the original terminal
prepare approval. Source leases, pending effects, unresolved Gateway writes,
missing readiness, changed ciphertext or ambiguous ownership block a new
adoption. Provider comments alone never establish ownership.

## Pending verification and activation

Under the physical resource lease, the target seals a pending v2 credential
bundle before releasing any plaintext. It copies only the Auth password pair
and generates an independent app pair. Retries reuse the acknowledged bundle.
Pending credentials remain unavailable to ordinary workers and binding readers.

The trusted control plane reads `_auth_schema_readiness.read_current()` in a
read-only transaction using the pending restricted Auth runtime credential.
It validates the target-owned artifact and readiness SQL asset, database,
login, role, target and catalog fingerprint against the source proof. The SQL
asset hash is distinct from the Auth worker executable hash.

Canonical Gateway verification uses provider GETs to check all five exact
approved rows: project, branch, key, row ID, original operation comment,
Preview target, encrypted type, unmanaged status and current value hash. It
cannot release worker credentials or write provider configuration. Source and
target authorization, approvals, lease and checkpoints are rechecked across
awaits. Normal renewal of the same lease is allowed; replacement is not.

Only after both checks succeed does a compare-and-set replace the pending
ciphertext with an active v2 bundle containing the verified evidence. The
operator requires independent acknowledgement of that exact checkpoint before
returning an applied Auth-resource receipt. A failed check leaves credentials
pending. A lost acknowledgement can resume from the active target checkpoint
without generating passwords again.

## Independent app lifecycle

An active target validates its own encrypted identity, approved adoption and
verified evidence. Credential reads, app resource preparation, bindings,
retirement and replanning no longer require the original app to stay prepared
or its configured source hint to remain available. Auth-resource retries use
fresh read-only readiness checks with the local active credential. Adopted
Auth schema reconciliation and execution also use read-only readiness; missing
or mismatched readiness never falls through to genesis or the schema worker.
The Auth resource worker cannot receive adopted Auth passwords.

App resource creation uses only that app's separate credential pair. Existing
access, membership, identity, delivery and binding paths retain their current
authorization and lease checks. Cleanup revokes app access, removes only owned
app bindings and retires only that app's database and roles. Shared Auth and
Gateway ownership remain retained.

A completed adopter can itself supply the next adoption. Its current verified
Gateway rows and its own retained prepare approval become the new source
snapshot; the next app receives the same Auth pair and a fresh app pair. This
does not recursively depend on the originating app's active operation.

## Shared Gateway continuation

Initial activation always verifies every approved value hash. Afterwards,
local active ownership supplies the canonical row identities. Fixed Auth and
realm-link values still require exact verification. Protected-app lists and
app deployment projections may include later sibling additions: their values
are parsed and validated, sibling entries preserved, and only the current app's
projection replaced. Such changes cannot redirect a row to another project,
branch, key or original owner operation.

Before an adopted PATCH, the journal records the exact intended value hash
under the current operation. An unknown write outcome is reconciled by GET
readback. Pending writes prevent that app from supplying a new source snapshot,
but do not prevent its own active credentials from supporting recovery. Caller
inputs are captured before awaits for provider writes, checkpoints and returned
row references.

## Evidence boundary

Focused source fixtures cover retained approvals and cleanup provenance,
pending/active credential isolation, independent app passwords, adopter chains,
source-first cleanup, activation failures and retries, caller mutation, lease
renewal/replacement, canonical ownership and sibling-preserving Gateway updates.
Results are reported with the source commit. No fixture performs provider
mutation or proves real users, sessions, deployments or hosted continuity.

First-app new-empty Auth creation remains a separate supported path and does
not depend on second-app adoption. Provider enrollment, approved synthetic
resources and configuration, native delivery, and real multi-app acceptance
remain separate coordinator-owned work. This source change adds no database
table or schema migration and does not approve any provider effect.
