# Synthetic Neon resource and approval plan

**Status (2026-10-09):** proposed resource plan; the new synthetic project,
branch and application databases remain unapproved and uncreated. The separately
approved canonical-owner reader, consent-only Preview deployment, Builder
endpoint and scoped Trusted Source rule are configured as recorded below.
Existing application/customer data remains unchanged.
This plan supports the hosted Spend Review qualification in the
[qualification plan](2026-10-07-hosted-operator-deployment-and-spend-review-qualification.md)
and the Arrusted
[topology audit](https://github.com/withAutograph/arrusted-development/blob/main/docs/plans/2026-10-09-main-and-app-database-topology.md).
It is not an authorization to execute the listed provider effects.

## Decision requested

Approve or revise this bounded target before the coordinator/operator prepares
any provider plan:

- One new Neon project in the existing Autograph Neon organization, reserved
  for synthetic Preview qualification. Proposed display name:
  `autograph-spend-review-synthetic`. Confirm the name is available at creation;
  the Neon project ID is assigned by Neon and is intentionally not guessed here.
- A clean default `main` in that new project, installed only from reviewed
  Arrusted schema/installer source. It must have no copied Production rows,
  Auth users, sessions, secrets, or credentials.
- One temporary retained branch named
  `spend-review-qualification-2026-10-09`, created from that clean `main`.
  This is the only qualification context proposed here. It is not the earlier
  `preview/spend-review/protected-2026-10-09` proposal in
  `bitter-lab-49627418`; that branch remains uncreated and that existing project
  remains untouched.
- Two distinct PostgreSQL databases on the qualification branch, with proposed
  names `preview_auth` and `spend_review`: a shared nonproduction Auth database
  and a Spend Review application database. Confirm names at creation. Give each
  database separate installer and restricted runtime principals. Proposed role
  labels are `auth_installer`, `auth_runtime`, `spend_review_installer`, and
  `spend_review_runtime`; the reviewed worker output assigns exact IDs and
  grants. The trusted Gateway/Auth service receives only the Auth runtime
  authority it needs; the Spend Review app receives only its application
  runtime authority. Installer authority remains with the protected operator.
  Approve exact grants after provider IDs and the generated grant plan are
  available; this document does not invent permissions.
- One branch compute shared by the two databases, autoscaling from 0.25 CU to
  1 CU, with scale-to-zero after the default five idle minutes. Keep one shared
  compute/recovery context for this synthetic qualification rather than adding
  a compute per database.
- Retain the qualification branch through the original-session acceptance and
  a 30-day evidence window after continuity passes. Then check for remaining
  consumers and obtain the separate exact cleanup approval before deleting that
  branch. Keep the clean project root available as a synthetic source baseline;
  do not auto-delete the project as part of this qualification.

The source prerequisite for enrolling a new synthetic project's default root
and its temporary descendant landed in Builder PR #649. Hosted preparation
under that enrollment remains unproven.
The source prerequisite for a second app to continue using the same shared Auth
realm without rewriting users or rotating credentials is owned by the shared
Auth continuation lane. Neither is established by this resource plan.

## Account, billing, region, and compute

The connected Neon metadata lists the existing `Vercel: autograph`
organization (`org-holy-waterfall-57859213`) on the Launch plan. The proposed
project should remain under that Neon organization so the current Neon owner
can authorize the existing account. The organization name and Launch label do
not establish whether billing is Neon-managed or Vercel-managed. Before
creation, verify the current native-store installation, payer and invoice path;
retain that reviewed arrangement. Do not create another account or switch
integration types to satisfy this proposal. No project or account is being
created in this step.

Neon reports `aws-us-east-1` as an available default region, and existing
Autograph Neon project metadata places its projects there. This is the
recommended region for the new synthetic project, subject to a final check of
the actual Vercel function regions for the operator, Spend Review, and Gateway
projects. The metadata read did not establish those runtime regions. If any
required service cannot run compatibly with `aws-us-east-1`, stop and have the
owner choose a mutually supported region before project creation; do not infer
compatibility from project names or select a cross-region route by default.

Current Neon documentation describes Launch as usage-based with no monthly
minimum. The published Launch rates are $0.106 per CU-hour and $0.35 per
GB-month of storage. At the proposed 0.25 CU minimum, compute is $0.0265 per
active hour; a 1 CU hour is $0.106. Compute suspends after five idle minutes by
default, while stored data remains billable. Branches are copy-on-write, but
writes add storage; Launch includes ten branches per project, with additional
branches billed at the published rate of $0.002 per branch-hour beyond the
included allowance. Confirm account-specific terms before approval.
These are unit rates, not a total forecast. Actual spend depends on active
qualification time, stored source/schema/synthetic data, retained history, and
branch count. The owner must review the live plan and usage estimator at
creation and approve the resulting cost view; no spend cap or total is invented
here.

The single shared branch compute and five-minute autosuspend minimize idle
compute. Keep the branch available through app-process replacement and a new
native deployment; do not use branch expiry to remove it before the continuity
proof and evidence window. Branch expiry is available for later cleanup, but
applying an expiry date is itself an owner-approved lifecycle choice. Neon
history/restore retention is project-scoped and plan-dependent; it is not a
substitute for the retained qualification branch or the independent continuity
checks below. Choose and record a history window only if the owner finds it
necessary for this acceptance.

## Current Vercel and Neon connection evidence

The following is metadata-only evidence read on October 9. No environment
variable values, database rows, or credentials were read:

| Vercel project | Project ID | Current connector observation |
| --- | --- | --- |
| `autograph-operator-preview` | `prj_3ProSPRCHYQOwHvF6HscPW7S6K5X` | Has the manually configured `neon-preview-operator` OAuth connector in `preview` only. It targets Neon MCP for owner/operator management; it is not a database store or app runtime binding. |
| `autograph-spend-review-preview` | `prj_sWFOQL6OaiiniImMP87bk8eootNL` | No connector is currently listed. |
| `autograph-gateway-preview` | `prj_cpET6J9Vtggxb4nvyN6YJpUCZAv6` | No connector is currently listed. |

The existing operator OAuth connector advertises Neon MCP `read` and `write`
scopes. The Neon owner must complete the supported interactive consent for
the exact organization/project operation. Owner Connect grants management
access; it is not a substitute for a separately approved, frozen resource
plan, nor does it create runtime credentials. Continue to use the existing
protected operator and its project-scoped Vercel OIDC boundary. Do not copy a
Neon management credential into Builder, Gateway, or the generated app.

Vercel Native Integrations connect a resource to named Vercel projects and
selected environments and inject that resource's configured secrets into those
bindings. A resource may be connected to more than one project; that does not
make the injected credentials project-specific. Therefore, do not bind one
broad database-owner credential to all three projects. Review each connection's
project, Preview environment, variable names, and provider scope independently.
The runtime bindings must be restricted credentials: the Gateway gets only the
Auth runtime binding, and Spend Review gets only its app database runtime
binding. The operator's installer/owner authority remains in its protected
path. If the selected native store path cannot supply those distinct
credentials without exposing installer or sibling-database authority, stop and
resolve the supported project-scoped binding design before connecting it.

For the qualification, bind only the exact Preview projects/environments to
the approved synthetic context. Do not enable branch-per-deployment automation
for this retained context: the acceptance requires the same database to remain
selected across app process restart and a new native deployment. Verify that
existing Production and Development environments are not included. Vercel
integration changes affect new deployments; deploy/readback must confirm the
new deployment received the approved bindings. No store or owner Connect
binding has been prepared by the metadata observations above.

## Owner-consent setup before synthetic resources

The merged owner-consent source (PR 645, retained by current main) can resolve
canonical saved-session ownership without an Auth signing secret or token
keyring. Its deployment reader consumes only `DATABASE_URL`, `BETTER_AUTH_URL`
and `MCP_RESOURCE_URL`. The existing Builder control-plane database remains the
source for session, handoff and membership reads; it is not copied into the
new synthetic project. The coordinator observed an empty operator Preview
environment inventory; no connection or hosted ownership proof is established
by the prepared files below. Recheck key/target metadata before applying them.

### Exact scoped environment plan

Target only `autograph-operator-preview`
(`prj_3ProSPRCHYQOwHvF6HscPW7S6K5X`) in team
`team_7NuFMkL3of4cYDt8DYpGg4ZW`, environment `preview`. Resolve and approve the
exact branch/environment filter against the existing operator deployment before
writing a binding; the prepared reference plan does not identify a branch.
Do not copy this configuration to generated app, Gateway, Production or
Development environments.

| Environment key | Reviewed value or private binding requirement |
| --- | --- |
| `PROTECTED_HOSTED_OPERATOR_AUTHORIZATION_CONFIGURATION` | The nonsecret JSON configuration in `/private/tmp/operator-owner-consent-configuration.json`, with the workload identities below. Reproduce from reviewed values; the temporary file is a handoff, not permanent state. |
| `BETTER_AUTH_URL` | `https://new.autograph.so/api/auth`, the coordinator-verified canonical issuer. |
| `MCP_RESOURCE_URL` | `https://new.autograph.so/mcp`, the coordinator-verified canonical resource/audience. |
| `DATABASE_URL` | A private pooled TLS connection to the exact existing canonical owner store, using the dedicated non-owning reader described below. Resolve its actual project/branch/database and credential reference under protected handling; no URL value belongs in this document. Prefer `sslmode=verify-full`; the current hosted Neon parser requires a pooled endpoint and accepts `require` or `verify-full`. |

The authorization JSON has `builderCallbackOrigin: https://new.autograph.so`.
Its Builder workload is project `prj_PpmXwhXGuNLAj7HHlkC1j6n3u1SY`, environment
`production`, subject
`owner:autographing:project:autograph-app-builder:environment:production`.
Its operator workload is project `prj_3ProSPRCHYQOwHvF6HscPW7S6K5X`, environment
`preview`. Both use owner `team_7NuFMkL3of4cYDt8DYpGg4ZW`, issuer
`https://oidc.vercel.com/autographing`, and audience
`https://vercel.com/autographing`. The companion temporary handoff is
`/private/tmp/operator-owner-consent-environment-plan.json`; its database field
is a reference requirement, not permission to export a broad existing URL.

### Approved owner-store capability

The user approved and the coordinator created `operator_owner_reader` in
Builder project `wispy-cherry-74541901`, Production main
`br-autumn-cell-au6bejy0`, database `neondb`. Its fresh credential is bound only
to the protected operator project’s Preview Secret `DATABASE_URL`. Independent
SQL login and catalog readback confirmed its identity, read-only default and
exact grants. No administrator URL or Auth signing secret was copied. The
verified effective privileges are:

- CONNECT to that exact database and USAGE on the actual containing schema.
- SELECT on `agent_session` and `builder_handoff`. Current readers select
  complete stored records, so column-limited grants cannot be assumed to work.
- SELECT on `member` and `organization` for the current membership join.
- No table writes, sequence writes, schema/database creation, ownership,
  administrative flags, installer membership, or broad inherited privileges.
  Inspect effective/default/PUBLIC function privileges for write capabilities;
  do not change global PUBLIC grants or other users as a side effect.

The read path calls only `getSession`, `getSessionByAdapterSessionId`, handoff
`read`, and `isActiveMember`. Other methods on their shared store objects do
not grant this reader write authority. The resolver rechecks exact issuer,
audience, workspace, owner, adapter generation, handoff and active membership
on each consent check/start/completion. Current SQL predicates enforce those
request constraints in trusted operator code; table SELECT privileges are not
an independent per-tenant database authorization guarantee. Session/handoff
rows contain private data, so this credential belongs only to the isolated
trusted operator and must never enter app environments or model-visible logs.

The approval must name the exact database, role, grants and environment
binding effects. No new Neon/Vercel management key, Auth signing secret,
Builder administrator connection, or broad control-plane credential is needed
for consent. Configuring consent does not enable resource effects. Later full
operator journal/artifact/effect operations require their separately reviewed
control-plane read/write capability and keyring; do not broaden this reader
or treat the consent grant as approval for those operations.

### Readback before relying on consent

Provider binding, pooled SQL login identity and effective grants have been
verified without exposing secrets. Builder Production now points to the
consent-only operator; the approved Trusted Source rule permits only Builder
Production to reach operator Preview. The operator deployment is ready, but
these setup facts do not prove canonical-owner consent. Exercise the
ordinary original-session consent flow for the current owner, then prove
wrong owner/workspace, stale adapter/handoff generation and revoked membership
are rejected. Record only sanitized outcomes, not session records or tokens.
OIDC/connector configuration, HTTP 200 or a browser return is not evidence of
current owner authorization or a completed provider grant. This review performs
none of those provider or database effects.

## Ordered owner approvals and assigned identifiers

Approval is staged so that each later request can name actual provider IDs,
permissions, and binding targets instead of guessing them in advance.

| Stage | Exact effect ready for owner review | Values assigned/read back after creation |
| --- | --- | --- |
| 0. Read-only preflight | Confirm Neon organization and billing owner; Launch terms; available name; Vercel function-region compatibility; source-enrollment and shared-Auth source prerequisites. | Actual billing confirmation, runtime regions, and current supported worker output. |
| 0a. Owner consent | Approve the exact canonical owner-store reader role/grants and the four operator Preview environment entries above; complete ordinary current-owner consent. No management key or signing-secret copy. | Actual owner-store identity, effective reader privileges, branch/environment filter, private credential reference, native deployment and current-owner grant readback. |
| 1. Project | Create one synthetic-only project under `org-holy-waterfall-57859213`, proposed name `autograph-spend-review-synthetic`, AWS `aws-us-east-1`, Launch usage-based plan, and clean default `main`. Use no Production project, branch, data, credentials, or user/session state. | Neon project ID, generated branch ID/endpoint, Postgres version, owner, region, compute profile, and actual price/usage display. |
| 2. Qualification context | From the clean root, create `spend-review-qualification-2026-10-09` with the proposed compute settings. Freeze the proposed `preview_auth` and `spend_review` database names and distinct role names in the protected bootstrap plan before any database/role effects. | Branch/endpoint IDs, reviewed resource/role identities and grant matrix. |
| 3. Database preparation | Through the protected operator, approve the fixed worker database/role creation and exact installer/runtime grants, then schema installation from reviewed releases. Human test identities use ordinary sign-up/sign-in; app access is an explicit approved effect. No Auth-user seeding. | Database/role identity, schema readiness, immutable release and private credential references; never include secret values in the approval record or readback artifact. |
| 4. Vercel bindings | Connect only the approved Preview environments of `autograph-gateway-preview` and `autograph-spend-review-preview`, using the role-scoped bindings above. Keep the existing operator's Neon MCP OAuth connector confined to operator Preview. Do not include Production or Development. | Store/connector IDs, project IDs, environment targets, environment-key names, deployment IDs, and observed source commit. Read key metadata only; do not reveal values. |
| 5. Qualification and retention | Continue the original public Builder session and its exact app/release identity, normal sign-in, ordinary public approvals, and requester/reviewer flow. Retain the branch until all acceptance predicates pass and the 30-day evidence window ends. | Original session ID/cursor and saved replies; accepted release, scenario outcomes, independent readbacks, continuity evidence, and a separately reviewed cleanup plan. |

The old `bitter-lab-49627418` project contains live and legacy stores and is
out of scope. Builder's existing `wispy-cherry-74541901` project is
control-plane-only and remains the home of its existing control-plane state;
it is not the Preview Auth or Spend Review database. The new Vercel projects
already exist, but their existence does not prove database credentials or
bindings are ready.

## Source install and synthetic-data boundary

Build the clean root and qualification context from reviewed Arrusted source
and the exact app release selected by the original public Builder request. Use
the supported protected installer and its fixed reviewed workers. Do not clone,
restore, branch from, or export any Production database. Do not copy Auth
users, sessions, secrets, or customer business rows. Install only the reviewed
schemas, required platform metadata created by their owning workers, and
synthetic-only business fixtures. Human test accounts use normal sign-up/sign-in;
app assignments use explicit approved access effects. Do not seed Auth users or
copy Builder user IDs into the realm. Put requester/reviewer workflow data on the retained
qualification context, not in a Production-derived branch or unrelated shared
Auth realm.

The original public Builder session remains authoritative. Preserve its
session ID, cursors, requests, ordinary user replies, approval decisions, and
app identity. Do not submit a replacement brief or ask an evaluator to drive
private workflow stages. No part of this resource plan changes or reconstructs
that session.

## Independent readback and continuity acceptance

The coordinator/operator should report these as separate observed facts before
calling the hosted Spend Review qualification complete:

1. **Provider identity and provenance:** independently read back the exact
   Neon organization, project ID/owner, region, default `main`, its clean
   source-derived origin, and the qualification branch's parent/source. Verify
   that neither branch has a Production parent. Preserve the synthetic-origin
   enrollment/readback evidence required by the Builder source lane.
2. **Database and role isolation:** read database names/IDs, endpoint identity,
   schema/release identity, database owners, role membership and effective
   grants. Confirm the Auth and Spend Review databases are distinct and that
   app runtime principals cannot administer the database, use installer
   authority, or connect as a sibling app. Do not read customer rows or disclose
   credentials.
3. **Binding identity:** independently verify the exact Vercel team/project,
   Preview environment, Neon store/connection, environment-key names, deployment
   ID, and source commit for Gateway and Spend Review. Confirm the app process
   receives only its app runtime connection and public Gateway verification
   settings; the Gateway/Auth process receives only its approved Auth settings.
   Read secret values only within protected runtime verification, never into
   logs or this record.
4. **Product behavior:** use normal authenticated synthetic requester and
   reviewer actors through the original public session. Verify submit, decision,
   persisted result, and the expected denied actor/tenant/self-approval cases.
   Preserve each scenario's pass/fail/blocked/unassessed result.
5. **Durability:** independently observe the same retained app database and
   release after page reload, app-process restart, and a new native Preview
   deployment. Confirm that the restarted deployment still points to the
   approved qualification context and that prior acknowledged synthetic writes
   remain readable.
6. **Cleanup eligibility:** after acceptance and the 30-day evidence period,
   check for remaining consumers and pending recovery obligations. Obtain a
   separate approval naming the exact qualification branch ID before deletion.
   Do not delete the project root or change any existing project's default
   branch as part of this cleanup.

A plan, source merge, deployment READY state, HTTP response, connector record,
role name, or database existence alone is not product or continuity proof.

HC/Vendor and other live app binding/data migration work remains independent.
This plan authorizes no Production migration, live binding change, credential
rotation/revocation, user/session alteration, resource deletion, or reset.

## Official provider references

- [Neon plans and current usage rates](https://neon.com/docs/introduction/plans)
- [Neon usage-based storage, branch and restore charges](https://neon.com/blog/new-usage-based-pricing)
- [Neon Launch compute price change](https://neon.com/blog/major-compute-price-reduction-on-neon)
- [Neon compute sizing and scale-to-zero](https://neon.com/docs/manage/endpoints/)
- [Neon branching](https://neon.com/docs/introduction/branching)
- [Neon branch expiration](https://neon.com/blog/expire-neon-branches-automatically)
- [Vercel Marketplace storage connections](https://vercel.com/docs/marketplace-storage)
- [Vercel native integration installation and project bindings](https://vercel.com/docs/integrations/install-an-integration/product-integration)
- [Vercel Connect for Neon](https://vercel.com/connect/neon)
