# Generated app lifecycle completion roadmap

The first milestone is a usable protected Preview reached from a saved Builder
session. Production use is a separately authorized milestone. Full lifecycle
completion covers the app after first delivery, including changes, recovery,
access, operations and retirement.

This roadmap defines acceptance evidence. The
[Builder lifecycle](../autograph-app-builder-lifecycle.md),
[GitHub publication gate](../github-publication-gate.md),
[hosted app runtime](../hosted-app-runtime.md) and
[Production handoff](../production-readiness-handoff.md) define the existing
behavior and authority boundaries. The
[A-469 delivery plan](2026-11-03-a469-normal-builder-public-delivery.md) owns its
specific public delivery and revision qualification. The
[November continuation handoff](../app-builder-next-session-handoff-20261105.md)
records existing signup and recovery work, prior receipts, and the ownership
of overlapping initiatives.

## M1 · Verified protected Preview

| Step                      | Owner and status                                                                                                                                                    | Evidence required                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resume and validate       | Builder and the target repository own the existing private flow. Qualify it as part of the delivery walkthrough.                                                    | Resume the saved session with its selected tenant, app and candidate intact. Use the repository's actual validation commands. Retain their outcomes and paged logs, independent source review and the user's review of the current candidate.                                                                                                                        |
| Publish a draft           | Builder owns authorized publication. GitHub owns PR state and checks.                                                                                               | Record the authorized destination and exact candidate as an owned draft PR. Read back the draft and head. Report required checks as deferred for an eligible draft. A deferred or placeholder status supplies no validation evidence.                                                                                                                                |
| Ready and merge           | GitHub owns Ready for review and required checks. The user authorizes the merge of the reviewed revision. Qualify the full transition.                              | Observe Ready for review and the required checks on the current head. Bind the separate merge approval to the reviewed target and expected head. Reject stale approval after a head change and confirm the merged revision independently.                                                                                                                            |
| Prepare and prove Preview | The protected operator owns separately approved preparation and access. The native provider owns deployment and activation. Builder reports the resulting evidence. | Read back the deployment and scoped runtime bindings for the intended Preview. Use the app's supported Auth flow and role. For a persistent workflow, perform a real authorized write and independently read it back in a fresh session or process. Verify a denied access case. Record the observed app, tenant, release and outcome without recording credentials. |

Exit when a representative persistent app completes every row from the same
saved session and the intended participant can use the protected Preview. Show
the live app and the tested behavior. Record missing evidence and the next
supported action if any row remains incomplete. UI review, local validation,
GitHub success, deployment readiness and authenticated runtime proof are separate
observations. For a static app, exercise its declared behavior and record
persistence as inapplicable.

The Arrusted PR contract was exercised on
[#1748](https://github.com/withAutograph/arrusted-development/pull/1748).
The draft aggregate was skipped, and the ready event ran the required check
successfully at the same head. This validates the repository behavior in
isolation. The public Builder session, approved merge and protected app
verification remain the milestone exit evidence.

## M2 · Approved Production use

| Step                | Owner and status                                                                                                                               | Evidence required                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review and prepare  | The protected operator owns Production preparation. Builder can supply its existing operator handoff. Production qualification is a follow-up. | Review the repository descriptor, release, environment, tenant and provider target. Obtain separate authorization for applicable database preparation, access and bindings. Independently confirm installed release, restricted runtime principal and app assignments before activation. |
| Activate and verify | The native provider owns activation. The operator verifies the approved outcome.                                                               | Observe the intended native deployment and active Gateway route. Verify real authentication, intended role and tenant, and the app's approved user workflow. For persistent apps, include an authorized write and independent readback, plus negative access evidence.                   |
| Recover             | Operator and provider own recovery. Qualify the recovery path for this release.                                                                | Record the supported response to a failed activation and prove that the prior usable state or an approved recovery target can be restored. Confirm route, runtime and data compatibility with independent readback.                                                                      |

Exit when an authorized participant can use the intended Production release and
the operator can identify and recover the deployed state. Preview proof remains
attached to Preview. Apply the separate approval and provider authority described
in the [Production handoff](../production-readiness-handoff.md).

Builder's public-release tool already covers approved synthetic Production
runtime bindings and Git delivery. Qualify that path using the saved app session
after M1. Customer Production uses Arrusted's operator-owned release, access
and recovery flow. Coordinate the hosted activation and rollback proof with
[A-481](https://linear.app/withgraph/issue/A-481/add-hosted-lifecycle-operations-separately).

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
