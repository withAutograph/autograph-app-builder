# Hosted operator deployment and Spend Review qualification

**Status (2026-10-09):** proposed target and source-backed qualification sequence;
provider migration and hosted Spend Review acceptance remain unproven. The
2026-10-07 source inventory below is historical, not the current implementation
status. Current source includes the native composition and worker snapshot
support described in [native composition](../hosted-operator-native-composition.md)
and [worker snapshots](../hosted-operator-worker-snapshot.md).

This plan records what the merged Builder and Arrusted sources provide, what
must be composed and registered before hosted effects are possible, and the
evidence required to qualify the original Spend Review request. It authorizes
no provider changes, credential creation, database writes, deployment, or
Production activity.

## Source, database and environment target

Keep one Git `main` in each existing repository. Arrusted app code, app-owned
schemas and checked releases share Arrusted's `main`; short-lived review
branches flow back into it. Builder retains its own repository and `main`.
This does not merge the two repositories or create a schema-only Git branch.
Git publication is source review, not database migration authority.

The proposed clean baseline is the default `main` branch of a **new,
synthetic-only Neon project**, built from reviewed source. Temporary Neon
contexts for schema changes and qualification derive from that baseline.
The baseline is not a live application database and does not replace existing
Production storage. Keep durable Production app databases, Auth identities,
sessions and data on their current physical targets until a separately reviewed
migration proves continuity. Do not empty, reset, reparent or relabel an existing
Production branch to obtain a clean baseline.

A Neon branch is an environment/recovery context, not an app ownership boundary.
Each app owns a separate PostgreSQL database and restricted runtime principal;
Auth owns a separate database shared by the apps in its realm. Sharing the Neon
project or branch does not make these one database. Sharing sign-in does not
grant app access. Generated apps receive only their own runtime credential and
public Gateway verification settings under the
[app environment contract](../hosted-operator-app-environment.md).

HC, Vendor and other existing Arrusted apps are included in this target even
though their source is already in Git `main`. The earlier generated-app compiler
plan's exclusion of existing-app rewrites is not an exemption from database and
credential separation. Preserve their existing data and behavior while bringing
them through the supported app provisioning and binding lifecycle. Renaming or
moving schemas inside the shared database does not meet this target.

## Current implementation gaps

At Builder `5b5ce4e`, both native Neon readers require `default: false` and
`init_source` of `parent-schema` or `schema-only`. The protected plan accepts only
`synthetic-only` Neon input. An intentionally clean default Neon `main` is
therefore not a supported operator target today. Its branch name is not the
reason for rejection. Supporting the proposal requires explicit enrollment and
readback of the new synthetic project/root, while retaining exact owner,
project, branch, endpoint, database, role and effect-approval checks. Removing
the default-branch check for every project would not establish safe authority.
Schema-only creation metadata alone also does not establish ongoing synthetic
ownership or authorize a write.

The current composition fixes one native Neon scope and a shared Auth resource
alongside per-app database definitions. Credential checkpoints bind the app,
Auth and physical context together and generate both credential pairs for a
fresh journal. Reusing a realm across independent app journals needs explicit
ownership and credential-continuity evidence; do not silently generate a new
Auth realm or rotate shared Auth credentials to onboard the next app.

Existing dedicated database names are inventory, not proof that running HC or
Vendor uses them. Current Arrusted runtime source rejects their prefixed
database URLs on Vercel and selects generic `DATABASE_URL`; observed app
environment key metadata has generic URLs without HC/Vendor-prefixed keys.
The database selected by the live credential remains unproved by those key
names. Resolve and verify the runtime binding before claiming app separation.

## Safe sequence and original Spend Review continuation

1. Complete metadata-only inventory of every app's source release, provider
   project/environment, physical database, runtime principal, Auth realm and
   known consumers. Do not inspect customer rows or return credentials.
2. Review the new synthetic project's exact ownership, baseline source,
   database/role layout, cost and retention. Keep
   `preview/spend-review/protected-2026-10-09` in `bitter-lab-49627418`
   uncreated while the target is being resolved. A docs change grants no
   provider creation, deletion or reset authority.
3. The operator owner implements and qualifies enrolled synthetic-origin
   support, including default-main and temporary-context readback, without
   permitting current Production targets. Preserve the existing protected
   operator journal, approvals, resource fencing and unknown-effect recovery.
4. After approval of the concrete provider plan, build the synthetic baseline
   from reviewed source and prepare the exact temporary qualification context.
   Use the original public Spend Review session and its Builder-authored release.
   Bootstrap or reuse the explicitly selected nonproduction Auth realm, complete
   normal sign-in, then approve exact app preparation and requester/reviewer
   access through the public workflow. Do not submit a replacement brief or
   drive private stages from an evaluator.
5. Observe the authenticated product journey, denial and concurrency cases,
   independent readback, reload, process restart and a new native deployment
   against the same app database. Preserve the original session and scenario
   results. This qualification does not require moving HC/Vendor live data.
6. For HC, Vendor and each remaining app, prepare a separate data-preserving
   migration proposal using the same app database and credential boundary.
   Name source and destination, supported copy/upgrade mechanism, writes during
   transfer, verification, cutover and reversal. Keep Auth user/session identity
   and app authorization intact. Prove restore and rollback continuity before
   requesting production migration approval; retain old resources and bindings
   until the approved rollback window and independent acceptance complete.

Publication/integration belongs to the delivery coordinator; provider effects
belong to the authorized operator. Source corrections, synthetic provider
preparation, Production data migration, credential revocation and resource
retirement are separate outcomes. The review must name which are actually
approved. No destructive cleanup follows from source landing in `main`.

## Historical 2026-10-07 evidence and implementation inventory

The remaining sections retain the original source baseline and qualification
requirements. Statements that composition or worker support is absent describe
that baseline; they are superseded by current source and the gaps above. They
must not be used to claim current hosted readiness or to select a replacement
public session.

### Evidence boundary

The Builder source baseline is `68895726` (protected planning for direct public
MCP sessions). The Arrusted source baseline is `1fbf221b` (strict protected
installer lint fix). The HC installer command and `packages/protected-installer`
support a fixed worker protocol; source tests and disposable PostgreSQL tests do
not prove a deployed operator, real owner grants, Preview deployment behavior,
or the product session.

The terminal read-only Production receipt for Arrusted CI SHA `e1c47894` passed
current-QA route and access checks for `/hc`, `/hc/api/storage/validate`,
`/spend-review`, `/vendor` and `/vendor/api/schema/active`, including private
service denials. This is current-QA readiness evidence only. It does not show
that the generated Spend Review release was installed through the operator or
recover the original public session below.

The generated-app worker and protected Auth worker are being implemented in
separate source slices. They are not deployed building blocks in this baseline.

Arrusted's current Spend Review release pointer is
`apps/spend-review/schema/release/2026-10-06.fenced-membership-v17/data-server`.
The app requires a verified Better Auth session, active organization, exact app
role and restricted database login. The release contains no demo seed or reset
control. The app README and production handoff require distinct requester and
reviewer actors and exact tenant/role grants.

Readiness evidence for the current QA tenant does not establish that the
installer host can prepare a fresh tenant. Retain the **PR #1537 fresh-tenant
dependency** until a concrete protected installer-host composition has been
deployed and observed preparing a new synthetic Preview target. A later
readiness proof applies only to the tenant it actually read back.

### Existing source building blocks

| Need                           | Existing source                                                                                                                                                                                                                                                                 | What it supplies                                                                                                                                                                                                                                                   | What remains to compose or prove                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP operator contract         | `lib/provisioning/hosted-operator-service.ts`: `createProtectedHostedOperatorHandler`, `ProtectedHostedOperatorDependencies`                                                                                                                                                    | Mandatory callback interface for planning, authorization, durable approval, journal, lease, reconcile, execution, verify and bindings.                                                                                                                             | No production `createDependencies()` adapter module wires all callbacks together.                                                                           |
| Authenticated owner resolution | `hosted-operator-owner-context.ts`: `createHostedOperatorOwnerContextResolver`; `hosted-operator-owner.ts`: `createHostedOperatorOwnerAuthority`; `hosted-operator-deployment.ts`: `createHostedOperatorControlPlane`                                                           | Exact tenant-scoped owner/session resolution, active membership and current owner provider authority checks for handoff or direct-start sessions. The factory wires these to Builder's durable Eve, handoff, membership and Vercel installation stores.            | Configure the separate process with the existing control-plane database and workload policy; verify deployed claims.                                        |
| Terminal approval              | `hosted-operator-owner.ts`: `createHostedOperatorReadApproval`; `hosted-operator-deployment.ts`: `createHostedOperatorControlPlane`                                                                                                                                             | Reads the private terminal approval receipt bound to exact action, call, frozen plan digest, operation, target and responder. The factory composes same-origin Eve observation with operator OIDC and an exact durable owner/session check.                        | Grant and verify the operator's separate read-only Eve permission. It must not borrow a Builder bearer or default to allow.                                 |
| Workload verification          | `hosted-operator-workload.ts`: `createOperatorWorkloadVerifier` and `OperatorWorkloadPolicy`                                                                                                                                                                                    | RS256 signature, issuer, audience, subject, owner, project and environment validation.                                                                                                                                                                             | Supply the exact policy and trusted key resolution in the separate operator deployment; prove the deployed identity claims match it.                        |
| Owner Vercel authority         | `hosted-operator-owner.ts`; `lib/agent/prepared-provider-context.ts`; `lib/integrations/postgres-vercel-installation.ts`: `readActiveVercelInstallationToken`, `readVercelInstallationBindings`; `lib/integrations/vercel-installation.ts`: `readVercelTokenKeyringEnvironment` | Existing tenant-bound Vercel OAuth installation storage and project access checks. The decrypt-only reader needs active/previous token-encryption keys, not OAuth client credentials.                                                                              | Configure the existing keyring in the operator process. Recheck active installation and project grants at operation time.                                   |
| Read-only public origin        | `hosted-operator-gateway.ts`: `readHostedOperatorPublicGateway`                                                                                                                                                                                                                 | Verifies selected project/branch deployment metadata and alias before including the origin in the frozen plan.                                                                                                                                                     | This is provider metadata, not browser reachability or application health. The deployed Preview still needs independent HTTP/authenticated behavior checks. |
| Sole journal                   | `postgres-hosted-runtime-journal.ts`: `createPostgresHostedRuntimeJournalStore`; `hosted-operator-deployment.ts`: `createHostedOperatorControlPlane`                                                                                                                            | CAS, approvals, frozen plan, positive fence generation, checkpoint and receipts in existing `builderProvisioningJournals`; the factory uses the same control-plane database as owner/session reads.                                                                | Deploy with access to existing checkpoint-encryption keys under least required access. Do not add another journal.                                          |
| Shared resource fence          | `postgres-hosted-operator-resource-lease.ts`: `createPostgresHostedOperatorResourceLease`; `hosted-operator-deployment.ts`: `createHostedOperatorControlPlane`                                                                                                                  | Dedicated per-operation control-plane SQL lock client; serializes physical Neon project, branch and database identities; rechecks journal lease, operation and generation. The factory opens a separate lock connection.                                           | Prove both deployed connections reach the same journal authority and remain available through recovery.                                                     |
| Fixed installer execution      | `hosted-operator-sandbox-launcher.ts`: `createHostedOperatorSandboxLauncher`                                                                                                                                                                                                    | Source-free Vercel Sandbox, project/team OIDC, allow-all networking, pinned worker digest, frozen context, explicit tenants, per-effect authority and checkpoint relay, cleanup.                                                                                   | Pin each worker artifact and the full operator dependency closure; configure image/catalog and prove the exact deployed worker digest.                      |
| Generated app and Auth workers | Generated-app installer worker and protected Auth lifecycle implementation                                                                                                                                                                                                      | Separate implementation paths select a generated app artifact/release and manage shared Auth identities/assignments under their own protected contracts.                                                                                                           | Compose and pin the actual artifacts, prove exact operation plans and readbacks, and keep generated app schema work separate from Auth lifecycle effects.   |
| Separate service process       | `scripts/serve-hosted-operator.mts`; `.config/mise/tasks/operator/serve`                                                                                                                                                                                                        | Loopback server that checks the adapter entry-module SHA and requires all dependencies at startup.                                                                                                                                                                 | It is a local entrypoint, not a deployed host, TLS ingress, identity policy, artifact store or complete dependency-closure pin.                             |
| Builder caller                 | `hosted-operator-client.ts`: `hostedOperatorClientForSession`; `lib/eve/vercel-workload-identity.ts`: `createVercelWorkloadIdentity`                                                                                                                                            | Resolves trusted owner context and sends the request with invocation-scoped Vercel OIDC; missing `HOSTED_RUNTIME_OPERATOR_URL` fails closed.                                                                                                                       | Configure an HTTPS operator origin in Builder and verify actual caller claims. No legacy installer fallback is allowed.                                     |
| HC worker                      | Arrusted `apps/hc/src/server.rs` `protected-install`; `packages/protected-installer`                                                                                                                                                                                            | Fixed worker for the HC app only (`context.app_id == "hc"`) and its embedded HC release. It has a protected Rust session, explicit tenant targets, pinned installer/release identity, per-write authority and checkpoint protocol. HC is not a Better Auth worker. | Build and pin this artifact only for HC operations. Do not route Spend Review or Auth work through it.                                                      |

The operator service is not currently a production composition. A checksum on
the adapter entry file does not pin imported modules or dependencies. The
separate host must deploy a reviewed immutable package/toolchain and worker
catalog; neither model-authored repository code nor arbitrary SQL is an
installer input.

### Process and credential boundaries

These identities have distinct jobs and must not be substituted for one
another:

| Principal or secret                          | Consumer and purpose                                                                                                                                            | Current source status                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder invocation Vercel OIDC               | Builder MCP caller authenticates to the operator's exact workload policy.                                                                                       | `createVercelWorkloadIdentity` exists; operator URL and deployed claims still need configuration/readback.                                                                                                                                                                                                                                                                                                                    |
| Operator service Vercel OIDC                 | Operator makes owner-scoped read-only Eve observation for terminal approvals.                                                                                   | Approval reader accepts an `observe` transport; its separate identity and GET permission are not deployed/configured.                                                                                                                                                                                                                                                                                                         |
| Operator Sandbox project/team OIDC           | Creates and controls a source-free installer Sandbox.                                                                                                           | Launcher obtains this token using its configured project/team; host permissions and deployed behavior remain unproven.                                                                                                                                                                                                                                                                                                        |
| Owner Vercel OAuth installation              | Reads selected project and deployment metadata and resolves owner-authorized project access.                                                                    | Existing tenant-scoped integration exists; owner must have an active installation with the needed grants.                                                                                                                                                                                                                                                                                                                     |
| Builder control-plane DB and encryption keys | Reads owner/session/handoff/membership records, reads/writes the sole journal, decrypts the owner Vercel installation and protects private runtime checkpoints. | `createHostedOperatorControlPlane` wires the database-backed owner stores and journal, and decrypts owner Vercel tokens with the encryption-only keyring. Deployment-specific DB and checkpoint-key delivery still need review. Grant only access required by the complete adapter.                                                                                                                                           |
| Vercel-managed Neon resource readback        | Binds the selected Vercel project and native Neon integration to the provider resource identity.                                                                | `hosted-runtime-marketplace-resource.ts` reads only the allowlisted fields from the existing Vercel Storage API: connected project, installation, store ID/status, owner scope and Neon external project ID. The response may contain secrets; they are discarded. This does not expose Neon branch IDs, an installer URL or restricted database roles. No separate Neon OAuth registration is needed for this metadata read. |
| Protected Neon branch access                 | Verifies a fresh synthetic-only Preview branch and supplies a direct URL for one protected worker operation.                                                    | **Unproven.** The Vercel-managed integration injects branch credentials into Preview deployments, while project environment reads do not expose those per-deployment values. Resource metadata supplies project identity, not branch identity or an installer credential. Never infer a branch from the Vercel project/store alone or use a branch that contains copied Production data.                                      |
| Restricted runtime credentials               | App receives only its app database URL, shared Auth URL, Better Auth secret/name/URL and verified public origin.                                                | Contract projection exists; actual service-specific secret isolation and binding readback are still unproven.                                                                                                                                                                                                                                                                                                                 |

Any protected worker direct database URL is transient startup input for that
fixed installer process. It must not be written to the app service environment,
public receipt, model context, logs or operator response. Approval and
checkpoint receipts contain identities and sanitized readback facts, never
passwords, URLs, OAuth tokens or signing secrets.

### Remaining implementation before external registration

These source/configuration tasks can proceed without a customer or provider
registration:

1. Add one reviewed operator adapter module implementing the exact
   `ProtectedHostedOperatorDependencies` callbacks. Reuse
   `createHostedOperatorControlPlane` for owner resolution, approval, journal,
   resource lease and active Vercel authority. Add concrete protected planning,
   reconciliation, worker execution, independent verification and strict
   bindings projection. Keep one `builderProvisioningJournals` row as the only
   effect journal.
2. Define deployment-owned schemas for the service's exact workload policy,
   operator project/team/image, immutable worker catalog and secret references.
   Validate required values at startup and fail closed; do not invent a Neon
   environment variable or provider credential source.
3. Build and pin each fixed worker for its own contract. Use the HC worker only
   for `app_id == "hc"` and the embedded HC release. Use the generated-app
   worker for Spend Review's selected release, and use the separate protected
   Auth lifecycle for shared Auth resources and assignments. Verify each
   artifact, operation list, install/repair/replay behavior and explicit tenant
   targets against its frozen plan; never map Spend Review work to the HC
   adapter.
4. Specify least-privilege control-plane database access, encryption-key
   delivery/rotation, operator workload audience, owner-scoped Eve read
   permission, authenticated HTTPS ingress and operational logging that
   excludes credentials. The existing `operator:serve` command alone does not
   supply these.
5. Add composition-level synthetic tests against disposable stores and local
   PostgreSQL, including wrong owner/project/branch/tenant, absent or rejected
   approval, revoked owner grants, stale generation, unknown readback, retry
   after worker interruption, and secret-free public receipts. These are source
   evidence only, not a deployed readiness result.

No Neon mutation or database preparation should be enabled until the following
provider inputs exist and the exact target is independently read back:

- A Vercel-managed Neon resource bound to the exact selected Preview project,
  plus a fresh synthetic-only Preview branch with an installer URL independently
  verified against the branch and database identities. Confirm its scope and
  cost/retention with the owner. Do not write to an integration-created branch
  until its inherited data is proven synthetic-only. Do not derive authority
  from a Production database URL or ambient service key.
- An active owner Vercel installation for the selected Preview project, with
  the exact project/branch access needed for metadata and deployment checks.
- A separate operator host/deployment with its own workload policy and
  operator-to-Eve read-only identity, plus project-scoped Sandbox OIDC for
  installer execution.
- Reviewed storage and rotation for the Builder control-plane connection and
  the existing journal/checkpoint encryption key. Keep those credentials
  outside app services and child Sandboxes.

If the existing Vercel-managed path cannot expose an independently verified
branch identity and protected installer URL, keep database effects blocked at
that predicate. The project/store metadata readback is useful evidence, but it
does not establish a branch or authorize writes. Do not require a new Neon OAuth
registration unless the owner chooses a different provider path.

### Deployment and first original-session qualification

After the source composition and external registrations are reviewed, perform
these as separately approved operational steps. Capture exact resource names,
digests, generation, sanitized receipts and independent readback; never record
secret values.

1. Deploy the operator separately from Builder and the generated app. Pin its
   complete package/toolchain, adapter, image and HC installer artifact. Configure
   HTTPS ingress, exact Vercel issuer/audience/subject/owner/project/environment
   policy, operator-only Eve observation, control-plane stores/keys and
   project/team Sandbox OIDC. Verify a rejected workload cannot reach the
   handler and an accepted Builder invocation can reach only the configured
   origin.
2. Set Builder's `HOSTED_RUNTIME_OPERATOR_URL` to that HTTPS origin. Read back
   the deployed Builder configuration and invoke a no-effect protected status
   request. Confirm owner, session, membership, active Vercel installation and
   selected project are independently resolved. No request-supplied owner ID
   or model-selected target can establish authority.
3. Recover the exact original public Spend Review request, retained at
   `docs/evals/evidence/2026-09-29-persistent-apps/spend-review-hosted-recovery.public.jsonl`
   (client request ID `8b48c82f-e9f7-4e31-b3d5-573e0b5a947d`). The receipt is
   `submission_unknown` with no session ID. Call `autograph_get` with that
   original ID; if it remains unresolved, retry `autograph_start` with the same
   ID and byte-for-byte original brief as required by
   `docs/public-mcp-contract.md`. Preserve every session ID, cursor and reply.
   Never create a replacement request ID or use private workflow operations.
4. Let the Builder's public workflow perform planning. The operator must
   independently bind the selected app, Vercel project and Preview branch,
   current owner access, exact current Spend Review release/artifact, synthetic
   Neon project/branch, distinct Auth/app databases, migrator/runtime roles,
   explicit organization/actor/role targets, cost owner and retention. Review
   the plan digest and every ordered effect before approving that exact public
   tool call. No private stage manipulation or implementation instructions are
   evaluation input.
5. Approve resource preparation only after reviewing the named nonproduction
   target. Confirm the generated-app worker independently verifies its pinned
   binary and selected release and performs only the frozen app schema
   install/repair/replay. Run shared Auth resource and assignment changes
   through the separate protected Auth lifecycle. Use the HC worker only for
   HC-specific operations. Each protected write needs an acknowledged
   checkpoint. Verify installed identities, schema/release, tenant scope, Auth
   assignments and restricted runtime grants from independent reads. Unknown
   readback blocks; do not retry with new names or credentials.
6. Approve exact access grants for two real hosted QA identities: requester
   (`member`) and reviewer (`reviewer`) in the same organization. Confirm
   membership before assignment, generation on both authority rows, no
   self-approval, and unchanged sibling app, other-tenant and user/session
   records. Test revoke ordering separately on the synthetic Preview target.
7. Read back operator bindings and native Vercel branch/project deployment
   metadata. Verify app services receive only restricted runtime URLs and
   auth/public-origin settings; prove installer/admin/Neon credentials are
   absent from actual app process environments. A Gateway alias or provider
   `READY` state alone does not establish app behavior.
8. Qualify the original app brief through the public Builder workflow. Observe
   normal signed-in requester submission, requester-only history, reviewer
   queue and one noted terminal approve/reject, self-approval denial, unassigned
   actor denial, cross-tenant denial and concurrent-decision conflict. Read
   request/decision/audit history independently, reload, restart the app
   process, and verify the same records remain. Preserve public transcript,
   session cursors, deployment SHA, branch, release, approval references and
   sanitized readback. Report each scenario as passed, failed, blocked or
   unassessed under `docs/generated-app-behavior-acceptance.md`.
9. Keep Production out of this qualification. Production provisioning,
   activation, pilot grants and any write against production data require a
   separate exact plan, review and explicit authorization.

### Completion criteria

This work is complete only when the operator adapter and host are deployed,
the owner-authorized synthetic Neon and Vercel inputs are independently
verified, a fresh synthetic Preview tenant is prepared through the fixed
protected installer, and the original public Spend Review session demonstrates
the required requester/reviewer behavior with independent readback and restart
continuity. Until then, distinguish source, local disposable-PostgreSQL,
current-QA readiness and hosted product evidence; none substitutes for another.
