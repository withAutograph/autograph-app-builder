# Hosted operator deployment and Spend Review qualification

**Status:** source-backed deployment plan; no operator host, owner Neon registration,
or hosted Spend Review session has been qualified by this document.

This plan records what the merged Builder and Arrusted sources provide, what
must be composed and registered before hosted effects are possible, and the
evidence required to qualify the original Spend Review request. It authorizes
no provider changes, credential creation, database writes, deployment, or
Production activity.

## Evidence boundary

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

## Existing source building blocks

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

## Process and credential boundaries

These identities have distinct jobs and must not be substituted for one
another:

| Principal or secret                          | Consumer and purpose                                                                                                                                            | Current source status                                                                                                                                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder invocation Vercel OIDC               | Builder MCP caller authenticates to the operator's exact workload policy.                                                                                       | `createVercelWorkloadIdentity` exists; operator URL and deployed claims still need configuration/readback.                                                                                                                                                                          |
| Operator service Vercel OIDC                 | Operator makes owner-scoped read-only Eve observation for terminal approvals.                                                                                   | Approval reader accepts an `observe` transport; its separate identity and GET permission are not deployed/configured.                                                                                                                                                               |
| Operator Sandbox project/team OIDC           | Creates and controls a source-free installer Sandbox.                                                                                                           | Launcher obtains this token using its configured project/team; host permissions and deployed behavior remain unproven.                                                                                                                                                              |
| Owner Vercel OAuth installation              | Reads selected project and deployment metadata and resolves owner-authorized project access.                                                                    | Existing tenant-scoped integration exists; owner must have an active installation with the needed grants.                                                                                                                                                                           |
| Builder control-plane DB and encryption keys | Reads owner/session/handoff/membership records, reads/writes the sole journal, decrypts the owner Vercel installation and protects private runtime checkpoints. | `createHostedOperatorControlPlane` wires the database-backed owner stores and journal, and decrypts owner Vercel tokens with the encryption-only keyring. Deployment-specific DB and checkpoint-key delivery still need review. Grant only access required by the complete adapter. |
| Owner-authorized Neon access                 | Creates or verifies the synthetic-only Preview resource set and produces a direct URL for a single protected worker operation.                                  | **Missing.** There is no owner Neon OAuth/credential issuer or `NEON_*` source integration. Do not use an ambient Neon API key, Builder's Production root, a guessed provider token, or a Vercel project-wide database variable as a substitute.                                    |
| Restricted runtime credentials               | App receives only its app database URL, shared Auth URL, Better Auth secret/name/URL and verified public origin.                                                | Contract projection exists; actual service-specific secret isolation and binding readback are still unproven.                                                                                                                                                                       |

Any protected worker direct database URL is transient startup input for that
fixed installer process. It must not be written to the app service environment,
public receipt, model context, logs or operator response. Approval and
checkpoint receipts contain identities and sanitized readback facts, never
passwords, URLs, OAuth tokens or signing secrets.

## Remaining implementation before external registration

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
owner/provider inputs exist through an explicit reviewed registration:

- A dedicated nonproduction Neon project/branch and the owner-authorized means
  to create, inspect and connect to its synthetic-only databases. Confirm its
  scope and cost/retention with the owner. Do not derive this authority from a
  Production database URL or ambient service key.
- An active owner Vercel installation for the selected Preview project, with
  the exact project/branch access needed for metadata and deployment checks.
- A separate operator host/deployment with its own workload policy and
  operator-to-Eve read-only identity, plus project-scoped Sandbox OIDC for
  installer execution.
- Reviewed storage and rotation for the Builder control-plane connection and
  the existing journal/checkpoint encryption key. Keep those credentials
  outside app services and child Sandboxes.

If owner-authorized Neon access cannot be registered, keep planning blocked at
that predicate. Do not claim a ready adapter because a locally injected URL
works; that would bypass the missing owner authority.

## Deployment and first original-session qualification

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

## Completion criteria

This work is complete only when the operator adapter and host are deployed,
the owner-authorized synthetic Neon and Vercel inputs are independently
verified, a fresh synthetic Preview tenant is prepared through the fixed
protected installer, and the original public Spend Review session demonstrates
the required requester/reviewer behavior with independent readback and restart
continuity. Until then, distinguish source, local disposable-PostgreSQL,
current-QA readiness and hosted product evidence; none substitutes for another.
