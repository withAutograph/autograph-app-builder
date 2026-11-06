# Generated app lifecycle completion roadmap

The default delivery path is a single live app with an internet-reachable
Production domain. Builder validates the app privately, then prepares the
approved destination and delivers the reviewed revision through native Git
delivery. The owner starts with authorized access to the live app. Invitations
and role changes update access to that same URL, deployment and data.

Hosted Preview, synthetic acceptance and app behavior checks are optional.
Run the normal build and native deployment using the approved source and target.
When an app needs managed storage or Auth, Builder provisions those resources
through the protected operator and reuses them on revision. Report actual
provider build or deployment failures. The app owns any additional tests.
A successful deployment can be reported with its final URL without a separate
browser walkthrough or persistence exercise.

The [public release contract](../public-app-release.md) describes the current
synthetic-runtime dependency and the change required to remove it.

## M1 · Deliver a usable app at its final URL

1. Resume the saved Builder session and keep the selected repository, app and
   tenant. Run applicable local validation and review the proposed changes.
2. Resolve and verify the approved live resources. Provision the dedicated
   database and restricted role when needed. Install the checked release and
   grant the intended owner access. Reconcile interrupted operations before
   retrying. A static app skips app database setup.
3. Publish the reviewed revision under existing GitHub policy. Where the
   repository uses a draft PR, observe deferred checks, run the required
   checks when ready, and merge only the approved revision after they pass.
4. Read the provider's active deployment and final URL. Report any build or
   deployment failure. App behavior checks are owned by the app and can run
   independently of release.

## M2 · Share and revise the same live app

Grant a second authorized participant access, then verify their role and use
on the same deployment. Revoke that access and verify the change. Deliver an
approved revision on the same app identity, preserving its data and access.
For an interrupted setup or revision, resume against the same owned resources
and verify the resulting state. Qualify provider rollback or a forward repair
under the [Production handoff](../production-readiness-handoff.md).

## M3 · Operate and retire the app

| Capability            | Owner and status                                                                                                                          | Evidence required                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revise and recover    | Builder, the app repository and the operator share this path. Existing saved-session and reconciliation primitives support qualification. | Resume an existing app, preserve app identity and user data, review a revision, reconcile a moved base, validate and publish the exact update, and verify the new behavior. Exercise interruption at an outward effect and reconcile the original attempt before any retry. |
| Enroll and revoke     | App Auth and the protected operator own access. Qualify for the app's declared roles.                                                     | Enroll an authorized participant, deny cross-tenant access, revoke an assignment, and prove the revoked participant loses access while other users retain theirs.                                                                                                           |
| Operate reliably      | Builder and provider operators own their respective observations. Establish baselines before making reliability claims.                   | Record elapsed time, supported cost evidence and failure or recovery outcomes from representative sessions. Verify resumability after process loss, durable diagnostics, replay safety and provider failure handling.                                                       |
| Export and retire     | The operator owns separately authorized export, archive and deletion. Qualify each applicable operation.                                  | Export only authorized scope and verify readable contents. Confirm archive removes intended access while honoring retention. For deletion, verify the approved resource scope and distinguish deleted, retained and unresolved resources through provider readback.         |
| Qualify the lifecycle | Builder and platform owners coordinate representative acceptance.                                                                         | Exercise a fresh participant, a new app, an existing app revision and interrupted recovery through normal entrypoints. Retain tested app, environment and coverage boundaries for every claim.                                                                              |

Qualify these capabilities separately after first delivery. Use existing
tenant-scoped sessions, publication receipts and compare-and-set effect journals.
When an outward result is uncertain, reconcile the exact prior intent through
readback before retrying. Bind each consequential approval to the intended
effect and target. A receipt for one environment or revision does not authorize
another. Follow the
[hosted runtime recovery contract](../hosted-app-runtime.md#approved-sequence-and-recovery)
and [protected recovery qualification](../a515-protected-recovery.md).
