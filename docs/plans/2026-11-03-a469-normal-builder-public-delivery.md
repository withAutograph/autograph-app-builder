# A-469: normal Builder create, public delivery and revision acceptance

Status: accepted implementation direction; implementation and hosted acceptance
remain incomplete. Publish this decision before implementation. Iterate on the
local Builder first, then publish the reviewed shared workflow and exercise the
saved hosted app. Documentation publication is not deployment or provider proof.

## Outcome and destination

Continue the saved generated app through the ordinary public Builder product.
Deliver one working app at a public domain, with Better Auth handling sign-in,
organization membership, app assignment and action permissions. An app visitor
must not need a Vercel account.

The accepted destination is the saved Builder app, not the existing shared live
`apps` project or another app. Read its accepted repository, provisioning result
and pending actions. Reuse the recorded project only after owner-scoped provider
readback agrees. If it has no project, normal Create App creates the standard
`apps-<app-id>` repository-linked Services project rooted at `.`. A matching name
alone never establishes ownership. Revisions and delivery reuse that project.

Gateway, Auth and app Services use the selected repository's supported
single-project composition. Do not allocate an extra acceptance, Preview or Auth
project. The privileged operator/installer remains separate infrastructure.
Standard Protection can protect deployment URLs while leaving the production
domain public; application data still requires ordinary Better Auth authority.

Public app distribution is separate from provider environment. This acceptance
uses approved isolated development/Sandbox provider data and test identities.
It does not authorize changes to existing customer Production deployments,
databases or provider installations. Broader Production rollout remains A481.

## Current implementation and known gaps

- Normal provisioning already derives `apps-<app-id>` and creates a Services
  project rooted at `.`, linked to the selected repository.
- The retained failed attempt used the distinct native Preview onboarding path,
  whose current frozen contract requires Vercel Authentication for All Deployments.
  That is not the intended prerequisite for a normal public release.
- Standard provisioned identity must be carried consistently into runtime setup,
  publication, delivery and revisions. Verify this behavior locally; do not claim
  it from the existence of a provisioning helper.
- The existing hosted runtime contract targets Preview. Public release needs an
  explicit supported effect plan and public-origin observation. A manual deploy,
  renamed Preview receipt or source-only test cannot fill that capability gap.
- Auth origin/callbacks, secure cookies, restricted runtime credentials, installed
  schema release, app assignments and actual service bindings require independent
  verification before app tests or provider effects.
- The earlier project-create 403 has no independently identified provider cause.
  Correcting the product path does not prove a protection setting caused or
  resolved it. Preserve bounded error codes and request references without raw
  provider bodies, tokens or credentials.

## Ordered milestones and exit evidence

### 1. Local shared Builder implementation

Inspect current source and repair the shared workflow in an isolated checkout.
Keep the evaluator at the normal web/public-tool boundary; do not implement the
generated app on its behalf. Preserve the public tool registry and ordinary
product questions/effect approvals.

Builder development is universally local-first: keep the local live-code loop
running and retry the affected behavior without a PR, shared deployment or
plugin publication for each iteration. Parallel branch work uses isolated
worktrees, Next/Eve ports, state/destination roots, build outputs and client
endpoint/profile connections. Follow the
[parallel-instance lifecycle](../local-development-lifecycle.md#parallel-branch-instances);
port-specific MCP identity does not prevent the shared active-profile plugin
selector from being overwritten. Do not switch another task's registration.
Local startup grants no provider-mutation authority.

Local iteration tests the shared Builder implementation; it does not transplant
the saved hosted session into a local database or runtime. The last verified
hosted observation is waiting at cursor 1414, with no verified handoff rows.
Re-read that session before continuation. Transfer execution only through a
supported, independently verified recovery/handoff flow; otherwise preserve the
hosted session and use separate local controlled inputs as local evidence only.
Do not copy its checkpoint, approvals or operation records to manufacture a
local continuation or replace the saved public creation journey.

Use the normal provisioned project identity as the destination for runtime setup,
publication, deployment and revisions. Implement any missing public-release
planning and delivery mechanics in Builder, including the approved public origin
and exposure. Keep private installer credentials out of app processes and browser
output. Do not add evaluator-only tools or a separate integration backend.

Exit evidence: focused behavioral checks of destination reuse, normal creation,
owner/tenant denial, changed-target approval, public exposure planning and durable
recovery. Report gaps rather than freezing incidental source or fixture details.
Run only checks needed for concrete repairs during iteration; keep broad CI
deferred until functional completion and do not restructure it.

### 2. Reviewed workflow release and saved-session reconciliation

Publish the reviewed shared workflow through its normal release process. Read
the saved app, current pending actions and authoritative project/resource records
again before continuing. Reconcile the obsolete Preview intent through supported
cancellation/supersession while preserving its complete history. A changed target
or exposure needs its own concrete effect approval.

Exit evidence: observed workflow release, saved-session continuity, verified
destination and isolated bindings. Source publication, deployment readiness and
provider activation are separate facts; none is inferred from the others.

### 3. Public Builder creation and delivery

Continue the saved creation session using only ordinary product replies and
concrete effect approvals. Builder completes the real data model and optional
standard Integrations page, performs its review/validation, and publishes and
delivers through supported native Git deployment. Observe the public domain in a
browser without Vercel authentication, then sign in through Better Auth and
perform a persistent application action with independent readback.

Exit evidence: saved public session and replies, actual project/repository and
deployment, public-domain behavior, Auth denial/approval, selected/installed
release and durable canonical result. A private preview or draft PR is not exit
evidence for requested delivery.

### 4. Real provider and isolation acceptance

Use the approved QuickBooks development/Sandbox account. Reconcile exact provider
identity and app service membership before activation or ingestion. Follow the
Arrusted optional-integrations runbook and separately scoped effect approvals.

Exit evidence:

- Real activation and ingestion with independently read canonical records,
  provenance and audit history.
- Two apps sharing one tenant-owned connection through distinct bindings and
  installations; two tenants remain isolated; a same-organization unassigned
  member and foreign app/tenant inputs are denied.
- Replay adds no duplicate canonical writes; conflicts and uncertain outcomes
  remain visible and reconcile without blind provider retries.
- Disabling one app blocks new admission and drains its jobs, preserving the
  other app and shared connection, with independent provider readback.
- Secrets and raw provider payloads are absent from retained logs/artifacts.

### 5. Existing-app revision and closeout

Run a normal saved existing-app revision against the same delivered app. Request
the shared embedded Integrations component in an existing page and exercise the
standard-page/navigation options. Verify preserved content, data, repository and
project. Verify non-opted-in behavior and safe installer reconciliation without
unapproved provider cleanup or canonical-data deletion.

Exit evidence: public revision interaction and deployed result, standard/embedded
shared behavior, optionality, and unchanged destination/data. Complete one final
functional acceptance pass, then applicable exact-head broad checks. Record
passed, failed, blocked and unassessed criteria separately. Close A469 only when
every applicable acceptance row has exercised evidence; customer Production
rollout is not silently claimed.

## Recovery and preservation

Never resend `a469-preview-target-approved-batch` or fabricate its settlement.
Preserve original sessions, approval receipts, frozen plans, journal history,
resources and data. Old approvals do not authorize a changed target or exposure.
An uncertain create is not permission for another POST, replacement project or
name-based adoption. Missing automation must be repaired in Builder and resumed;
manual journal/app repair cannot substitute for product acceptance. Cleanup has
its own concrete scope and approval.

## Supporting contracts

- [Complete app authoring](../full-app-authoring.md)
- [Optional integrations delivery](../optional-integrations-delivery.md)
- [Hosted runtime and protected Preview contract](../hosted-app-runtime.md)
- [Public MCP contract](../public-mcp-contract.md)
- [Production handoff](../production-readiness-handoff.md)

## Resource preparation and public release are separate approvals

Fresh standard single-project setup plans carry
`runtimePreparation: single-project-resources-v1`. Auth bootstrap prepares the
isolated resources and verifies the installed Auth schema. Application setup
installs and independently reads the selected schema and grants the approved
application access. Neither setup plan binds a Vercel environment nor deploys a
Preview. Completed application setup records its actual restricted-role SQL
proof as `prepared/resource-ready`, with `environmentBound: false`.

A separately approved public release binds the app-owned Production runtime
configuration and publishes through native Git deployment. Resource readiness
alone does not establish public delivery or authenticated browser acceptance.
Previously frozen plans keep their original effects and semantics.
The normal Auth handoff is selected from one owner-, app-, session-, and
project-bound READY public Auth bootstrap release. The callback rechecks the
original resource approval and actual public release approval history, the
sealed enrollment and runtime configuration, the exact Auth resource and the
app-owned public signing key. Public callbacks use the explicitly reviewed
Production workload identity; earlier Preview identities remain unchanged.
Normal account capture and organization proof challenges retain the separate
public release binding alongside the original account setup digest.

These local contracts and tests establish implementation behavior, not hosted
acceptance evidence. Public delivery, normal sign-in, persistent app actions and
provider lifecycle observations still require the progressive product run.
A separate existing-app revision session recovers its original normal Builder
destination from the authenticated owner's settled provisioning receipt, keyed
by the accepted app ID and the independently acquired GitHub repository and
installation IDs. This read-only recovery does not copy the creation session,
reuse an effect approval, adopt a project by name, or create another project.
Ambiguous or mismatched receipts remain unavailable. New resource verification
and public release approvals still belong to the revision session.
Separate-session revisions retain the original restricted Auth and application
database password pairs. Normal setup records app-owned private credential
provenance after actual Auth schema readiness. A later resource plan identifies
that exact checkpoint and receives a fresh approval to verify and reuse it.
The operator rechecks original consent and current ownership, then encrypts the
same pairs for the new session. Existing-resource steps run the fixed worker's
read-only ownership, role, and login inspection; an absent or mismatched
resource is a blocker, never permission to recreate it or rotate passwords.
New session enrollment and approved schema/access changes remain separate.
