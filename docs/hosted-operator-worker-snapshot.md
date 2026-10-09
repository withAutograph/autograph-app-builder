# Immutable operator worker snapshots

The operator's deployment-owned `sandbox` configuration accepts exactly one
filesystem source. Existing image configurations retain `image`, preferably an
actual digest-pinned VCR image reference. Snapshot configurations supply the
installed Sandbox SDK's native source object instead:

```json
{
  "source": { "type": "snapshot", "snapshotId": "actual-provider-snapshot-id" }
}
```

This field belongs alongside the existing project/team and pinned worker
catalog. Obtain the actual snapshot ID from approved Sandbox preparation;
never use a snapshot ID as an image string. Both the protected installer and
credential-free Auth proposal create from the same configured filesystem.
They preserve project-scoped OIDC, `allow-all` networking, empty VM environment,
worker hash verification and ordinary owner/approval/fence checks.

Prepare only the qualified worker binaries and their required system runtime
in this immutable filesystem, using supported file APIs. Keep provider
credentials, runtime connections, operation inputs and generated app releases
out of the snapshot. The protected launcher supplies these private operation
inputs only after current authorization and removes its owned spool afterward.
Read back the actual snapshot and worker hashes before selecting it for an
operator deployment. Snapshot retention and replacement remain reviewed
provider operations. A source fixture or prepared image alone does not prove
normal hosted preparation, authenticated app behavior or recovery.
