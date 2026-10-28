# App Builder / Autograph optional integrations delivery

This is the App Builder handoff for the shared Arrusted integrations capability,
including Vendor migration and optional generated-app composition. Publishing
this handoff does not authorize implementation, environment provisioning,
permission changes, provider operations or production activation.

Use the existing [optional integration authoring reference](../agent/skills/create-app/references/optional-integrations.md)
for executable app definitions, typed recipe bindings, the configured server
host, `install-app-integrations`, and the standard/embedded component. Use the
selected Arrusted checkout's `docs/integrations/optional-app-integrations.md`
for the authoritative operating sequence, migration prerequisites, owner roles,
validation and recovery procedures. The source baseline is tracked in
[Arrusted PR #1598](https://github.com/withAutograph/arrusted-development/pull/1598).
This handoff does not define a second control-plane or schema contract.

## Current evidence — 2026-10-28

[Builder PR #784](https://github.com/withAutograph/autograph-app-builder/pull/784)
merged on October 27 at `22:39:43Z`, as commit
`9416113d7506f21ac5450abc83b08978b4f47dfe`. Its final head was
`6023e9407dea86037b850245277cb3d874868985`.
[CI run 40595013466](https://github.com/withAutograph/autograph-app-builder/actions/runs/40595013466)
passed every executed job; Vercel proof was skipped for the PR. The reported
Preview status was Ready. Neither CI nor that status establishes authenticated
provider behavior or a completed public Builder journey.

[Arrusted PR #1598](https://github.com/withAutograph/arrusted-development/pull/1598)
merged on October 27 at `22:20:45Z`, as commit
`9c03def23a5ffa428c56edeeccc53345bf0d7b7d`. Its final head was
`e2fee31d91a3363e5931004d69faf1e840402d65`, with passing
[CI run 40582097399](https://github.com/withAutograph/arrusted-development/actions/runs/40582097399).
These merged implementation PRs are not active publication targets for this
recovered documentation; the handoff is a follow-up documentation change.

The former Gateway Trusted Sources blocker is superseded. The merged delivery
configuration disables Git-triggered deployments for the dedicated Gateway
project root using `git.deploymentEnabled: false`; root and apps Git delivery
remain enabled. No new Gateway permission request is needed for this handoff.
That delivery configuration is separate from provider/runtime readiness.

The implementation session recorded tests of installer-emitted standard and
embedded pages with a synthetic host, plus PostgreSQL isolation and replay
tests. These are local/source evidence, not a normal public Builder session or
authenticated hosted provider proof. This documentation update reruns neither
those tests nor provider operations. Its documentation changes are not covered
by the implementation CI runs above.

## Ordered handoff

| Step                                 | Owner                                                            | Prerequisite, action and exit evidence                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Select the merged source          | Delivery coordinator and both repository owners                  | The implementation PRs are merged. Confirm the selected Builder/Arrusted source includes them and use the current checked app release. Publish this recovered handoff through its follow-up documentation PR; source publication does not activate a provider.                                                                                                                                                                      |
| 2. Establish runtime readiness       | Platform integration owner, database operator and provider owner | Supply the real central host, protected authentication/configuration, exact provider identity inspection, binding leases and restricted service actor. Bind QuickBooks/Xero to their shared read/setup/installation adapters. Ramp still needs its distinct proxy-sync host and is deferred from the recommended pilot. Record unavailable capabilities explicitly; a typed recipe is not a deployed host.                          |
| 3. Qualify the shared path           | Vendor/provider and acceptance owners                            | Follow Arrusted's fenced migration sequence and prove one connection serving two apps independently. Adoption creates an active binding: fence and drain the old writer before adoption, then verify the checked release supports protected `actor_kind: "service"` membership and current authorization before resuming. The shared resolver is generic; integration recipes do not define another actor kind or schema authority. |
| 4. Request the new app normally      | Product requester and public acceptance owner                    | Submit an ordinary product brief requesting supported provider data and an optional standard Integrations page. The brief describes product intent and authority, not evaluator implementation instructions. Retain the public session and ordinary question/approval replies.                                                                                                                                                      |
| 5. Let Builder compose and validate  | Builder workflow owner                                           | The ordinary workflow uses typed app definitions and the repository-owned installer after private build approval. It validates generated app behavior and supplies the real app DAL/host. A page, installed receipt or successful setup callback does not prove activation or canonical ingestion.                                                                                                                                  |
| 6. Exercise an existing-app revision | Public acceptance owner and app owner                            | In a separate saved public revision session, request embedding the same component in an existing page and select whether navigation/standard page is wanted. Verify that existing app-owned content is preserved. Also exercise an app that did not request integrations.                                                                                                                                                           |
| 7. Decide release readiness          | Coordinator, acceptance owner and environment approver           | Review independent database readback, UI states, isolation, revocation, replay and recovery evidence. Authorize any provider/production expansion separately. Close only issue acceptance that actually passed; source CI and this handoff do not establish rollout completion.                                                                                                                                                     |

The merged source supplies shared mechanics, not a configured deployment host.
The host must bind the existing authentication/DAL, central authority, protected
service identity, exact provider inspection and canonical-write lease. Shared
read/setup/installation support exists for QuickBooks/Xero; Ramp normalization
alone does not supply its proxy transport or sync host. Builder must report a
missing host as unavailable instead of inventing an application backend.

The central authority precedes app activation; proven host/recipe availability
precedes claims of public Builder success. Publication, environment preparation
and runtime activation are distinct decisions. Git/PR identities above record
evidence and do not select provider deployments.

## Public acceptance and recovery

Follow [full-app authoring](full-app-authoring.md), the
[public MCP contract](public-mcp-contract.md), and the public-driver discipline
in [self-reproduction evidence](evals/self-reproduction.md). Use the normal web
product or public MCP surface. For this capability, use an integrations product
brief and a separate existing-app revision brief; do not claim full App Builder
self-reproduction from these two narrower journeys.

Preserve session IDs, request IDs, cursors, replies and approval records. The
evaluator observes the workflow and independently reads its result; it does not
invoke internal Eve stages, prepare the implementation for Builder, repair a
backend manually or silently replace a failed session. A missing configured
host is a capability blocker; missing functionality in a supposedly supported
generated result is a failure. Report passed, failed, blocked and unassessed
requirements separately.

Verify the optional standard page and embedded component use the same shared
implementation, preserve desktop resizing and partial-failure states, and grant
no authority through presentation filters. Verify a non-opted-in app gains no
integration routes, sync jobs or integration UI behavior. Provider activation
and test writes require their own scoped authority. Authenticated canonical
record/provenance/history readback is separate from a screenshot or HTTP 200.

If composition fails, retain the app's existing files and saved public session,
report the actual installer/validation error, and let the ordinary workflow
perform an authorized repair. Do not generate a replacement integration backend
or fake success. If provider activation or ingestion fails, keep admission
blocked and hand recovery to the Arrusted runbook's platform/provider owner.
Application rollback does not undo database migrations, canonical writes or
shared provider effects; preserve the observed installed release and data.

## Decisions needed to start the pilot

1. **Identify the rollout approver and provider-consent owner.** The delivery
   coordinator can prepare the supported host composition, protected
   configuration and migration/recovery plan using the existing contracts. The
   requester need not design database roles, signer formats or SDK internals.
   Before hosted resources, credentials or roles are changed, the operator must
   present the concrete target and effects for scoped approval. Coordinate with
   the existing A191/A197/A198 implementation streams rather than duplicating
   their work; those engineering prerequisites are not solved by blanket approval.
2. **Confirm the pilot scope.** The recommendation is QuickBooks in a
   nonproduction environment, migrating Vendor and adding one minimal second
   app with different target bindings against the same reusable connection.
   Confirm the approved organization/test account and acceptance owner. Do not
   include production activation or unbounded backfill in this approval.
3. **Decide whether Ramp belongs in the first rollout.** The
   recommendation is to defer it until the QuickBooks pilot passes. Choosing
   Ramp now adds a separate proxy-sync host and its acceptance work; its recipe
   and catalog presence do not make that host available. Xero can follow the
   same read-host qualification path after the initial pilot.

After runtime readiness, the operator presents the concrete migration window,
fence/drain and bounded retry/backfill plan, rollback owner and evidence
location for approval before provider effects. Then run the normal public
create and existing-app revision journeys, preserving their sessions and
independent canonical readback. Production expansion and organization-wide
disconnect remain separate approvals. No new Gateway permission decision is
required. These are rollout decisions; they do not reopen the merged source PRs.

A469/A480's dependency reconciliation was already approved and applied in the
implementation session; it is not a new approval request or an action to repeat.
A189 remains canceled. This documentation publication does not authorize new
Linear status/dependency changes, implementation, purchases, permission changes,
deployments or production/provider writes.

This handoff intentionally leaves the executable skill and its generated bundle
unchanged. Future authoring-guidance edits must use the repository's normal
bundle-generation/parity workflow before claiming the product consumes them.
