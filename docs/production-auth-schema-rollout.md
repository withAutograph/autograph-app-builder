# Existing Production Auth service rollout

This is private platform maintenance for an already owned Auth database. It is
not a generated app requirement, a public MCP operation, or another approval in
ordinary app delivery. Creators continue using normal Builder setup and
provider-owned native deployment.

The protected operator exposes `POST /v1/auth-schema-rollout` with closed actions
`plan`, `status`, and `execute`. Requests carry the trusted Builder workload,
current canonical owner context and session. Planning selects an enrolled
`profileId`; status and execution select a saved `operationRef`. Execution also
carries the saved `planDigest` and native approval call identity. Requests cannot
supply SQL, resource identities, credentials, roles, binaries or arbitrary commands.

## Deployment enrollment

Operator configuration `PRODUCTION_AUTH_SCHEMA_ROLLOUT_CONFIGURATION` is a version
1 object with `builderWorkload` and `profiles`. Each profile contains:

- `id`, human `label`, and `administrators`: exact hosted tenant authorities
  (`issuer`, `audience`, `workspaceId`, `ownerUserId`). Workspace membership alone
  does not authorize shared Auth maintenance.
- The original Production Auth `resource`: `resourceId`, version 1, environment
  `production`, hostname, port 5432, database, public schema, migrator/runtime
  roles and original Neon project/branch identities.
- The existing restricted `authOperatorRole`, distinct from schema owner and
  runtime roles.
- `runtime.sandbox`: immutable image or snapshot, operator project and team.
  `runtime.worker` is the fixed `auth-protected-schema-v1` descriptor;
  `runtime.proposalWorker` is the Auth proposal descriptor. Both bind executable
  path, SHA-256 and exact catalog source capture. `catalogAppIds` identifies the
  source-owned Auth catalog.
- `runtime.migrationConnectionEnvironment`: the **name** of an existing
  server-side schema-owner binding. Configuration/journals contain no credential
  values. A restricted Auth operator/runtime URL cannot replace this authority.
  This service does not generate or rotate credentials.

Builder receives only `PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS`, a JSON
array of the same enrolled administrator authorities, for dynamic discovery.
The two internal tools `plan-production-auth-schema-rollout` and
`apply-production-auth-schema-rollout` are absent from ordinary creator tool
selection. This mirror does not authorize service operations: the operator
independently verifies current canonical ownership, workload, profile enrollment
and exact resource/role on every request and worker authority frame. The existing
`REPOSITORY_PRODUCTION_OPERATOR_URL` selects the protected service origin.

## Plan, review, apply and readback

Planning invokes the pinned read-only Auth proposal binary against the original
target, privately using its migration binding and explicit managed operator role.
The existing Preview proposal API stays Preview-only. Returned resource/role
must match deployment enrollment.

An existing Neon binding with one `sslmode=require` is strengthened in memory
to `verify-full` before planning, approved apply, or readback. The stored binding,
password, target and roles are unchanged. Duplicate or missing TLS parameters,
unsupported query overrides, pooled endpoints and mismatched resource identities
still fail the independent strict connection assertion.

Auth maintenance failures emit server-only `builder.auth_schema_rollout_failure`
diagnostics identifying a closed phase, error class, and optional allowlisted
operator code or SQLSTATE. These distinguish configuration, canonical owner,
profile selection, migration binding, OIDC, VM creation, proposal and journal
failures. They never include exception text, SQL, credentials, URLs, caller
attributes, request arguments or native inputs. Public errors remain generic;
diagnostics neither authorize effects nor change retry or cleanup behavior.

The existing tenant-owned `builder_provisioning_journal` stores separate
`production-auth-schema-rollout-v1` records. Each freezes the complete original
schema proposal, catalog/source, worker, sandbox, connection **reference**,
resource, role and session. Review shows the existing resource's human label and
concrete schema/permission effects. Eve's native approval must match the entire
reviewed input, current administrator, tool and call; a caller digest is not consent.

Execution verifies approval before resolving mutation credentials. A physical
PostgreSQL lease spans sessions and rollout operations on the same Auth database,
with a new fence per continuation. A separate Production schema launcher admits
only `auth-protected-schema` and read-only `auth-protected-schema-readback` in
`auth-protected-schema-v1`. It uses the fixed file-spool protocol and exact
original plan/resource/role. Credentials travel in private task-owned files,
never argv or environment. Only `auth:apply-schema-plan` with no tenant is
authorized. App allocation, membership, runtime bindings, deployment activation
and Preview bootstrap are outside this capability.

Approval is durably retained while the operation remains planned. Credential
lookup, VM creation and startup failures before worker dispatch are safe to retry
on that same operation and approval. Immediately before invoking the detached
worker command, the transport durably marks the operation pending. A lost or
rejected dispatch response is uncertain and requires original-plan readback.

The worker replans before DDL and independently reads back schema and ACL. The
journal retains its resource-bound checkpoint before acknowledgement. An
interrupted or uncertain result retains the same operation in `reconciling`.
Continuation rechecks the original approval and uses the closed readback command
to verify original verified Auth history and current source-derived schema/ACL.
Unknown readback cannot become success or trigger blind DDL retry. Successful
readback marks the original operation ready.

## Rollout order and retained operations

Commit the final Builder/Arrusted source pair, including Auth readback and ACL
changes. Build its five-family catalog with `mise run source:operator-worker-catalog`.
The platform operator stages the immutable snapshot and config references,
preserving older paths/snapshots needed by pending operations. New plans select
new catalog descriptors; saved rollout plans retain theirs. Changing enrolled
physical resource, role or connection reference cannot retarget an old approval.

Select compatible workers before applying the existing Auth schema/ACL plan.
Then let native provider deployment activate compatible Auth runtime and perform
authenticated readback. Source tests, catalog receipts and green CI do not claim
a provider migration or live access result. This one-time service operation adds
no per-app qualification or release gate.
