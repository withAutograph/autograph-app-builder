# A-469: isolated central integration infrastructure

Status: retained legacy isolated-host implementation plan; no central setup or
hosted acceptance is claimed. Fresh normal app capability/public-release plans
must use the [normal existing-platform reference](../optional-integrations-delivery.md#normal-existing-platform-reference).
This isolated Preview path is not their prerequisite or fallback. Existing frozen
isolated plans, approvals, receipts and catalog entries retain their meaning.
This extends the [normal Builder acceptance plan](2026-11-03-a469-normal-builder-public-delivery.md).

The generated app keeps its one normal `apps-<app-id>` Services project and
public production domain. BetterAuth owns application access. The existing
central Integrations service is platform infrastructure; this plan creates no
additional app, acceptance, Preview, Auth or integration-backend project.

## Why a separate infrastructure setup is needed

Read-only provider metadata on 2026-11-03 identifies the existing `apps` Services
project linked to `withAutograph/arrusted-development`, but lists no
`INTEGRATIONS_*` environment rows. This is not evidence of a functioning isolated
central service. Missing configuration must become a concrete supported Builder
setup operation, rather than an assumed endpoint or a manually finished app.
Customer Production deployments, data and installations remain outside A-469;
their rollout remains A-481.

A deployment-owned profile must independently bind the existing central project,
repository and installation, isolated database/roles and provider resources,
reviewed source, webhook receiver, and workload authority. Never infer those
facts from a name, model output, new app, latest deployment or prior approval.
Unavailable authority returns an actionable prerequisite with preserved work.

## Separate approved intents

A central infrastructure setup plan owns only its explicit existing-project,
isolated Preview resources. It freezes a new operation-owned source branch,
reviewed source, exact environment keys and hashes, private custody references,
webhook subscription and workload-access changes before effect approval.
Existing branches, shared environment maps and unrelated project settings are
preserved. The branch is published only after its isolated bindings and event
receiver are ready. Its Services composition and effective bindings must prevent
unrelated customer services from starting with inherited customer credentials.

An app integration capability plan remains a different approval. It consumes an
independently verified READY central setup receipt, then prepares its own scoped
control login, installs/verifies the fixed schema as required, binds approved
service actors, and atomically registers that app's central authorities. These
four app effects are `prepare-control-database`, `install-control-schema`,
`bind-service-memberships`, and `register-central-app`. They cannot deploy or
reconfigure customer Production infrastructure. The existing public release
plan independently approves the generated app's actual destination/exposure.

All these operations use the existing five public Builder tools and ordinary
concrete effect approvals. They preserve frozen plan meanings, accepted receipts,
current owner/cancellation checks, resource fences and unknown outcomes. Never
reuse old consent for a changed target, resend an uncertain write, or manufacture
settlement of `a469-preview-target-approved-batch`.

## Native delivery and deployment identity

Use Git publication followed by Vercel's native Git deployment. Do not call a
deployment POST, promote, assign aliases, or elect a deployment from a list,
commit/PR mapping, branch-alias construction, readiness ordering or time.

A narrowly scoped signed provider deployment event supplies the actual accepted
deployment ID for the operation-owned branch. Persist that ID once, then
independently read that exact provider resource and immutable origin. Branch and
source SHA only correlate the approved publication and record provenance; they
are not deployment selectors. Duplicate event/ID is an idempotent observation;
conflicting IDs or an unacknowledged dispatch remain visible and stop automatic
selection or retry. Verify loaded central configuration and isolated resources,
not just READY or source metadata. Subscription permissions and actual event
shape must pass provider readback before this path is enabled.

[Vercel's webhook contract](https://vercel.com/docs/webhooks/webhooks-api)
distinguishes created, ready and succeeded events. A built/ready event alone is
not completed functional delivery. Signature checking uses the exact raw body;
retain only bounded verified event/resource facts, never raw provider payloads
or credentials. A newly returned webhook secret must be sealed before source
publication; a lost secret/creation acknowledgement needs reconciliation.

A protected central Preview may accept server-to-server calls through the exact
approved Vercel project/environment Trusted Sources rule and a short-lived
workload token. This grants no browser access or application permission. Actual
rule scope must be disclosed and independently read back; do not promise
origin-only provider scoping when the provider grants an environment pair.
Signed central application authority still restricts the app/tenant and exact
origin. Use no bypass secret, alternate personal token, public SSO exception or
weakened protection. See [Trusted Sources](https://vercel.com/changelog/trusted-sources-for-deployment-protection).

## Credential and database boundary

Central infrastructure retains the activation signing private key, provider API
credentials and its own central control login. Generated apps receive none of
those credentials. Setup, activation, removal and provider inspection use
signed central operations. Public provider ingress belongs to the app's public
endpoint and is verified before canonical writes.

Each app's cross-database binding lease uses a distinct restricted control login.
Owner-only SQL metadata binds immutable `SESSION_USER` to that app and its exact
approved tenant set. App/tenant/manage GUCs cannot widen that authority; an app
cannot create shared connections or grants, alter registry rows, use another
app's scope, or read/modify the private principal registry. Only the fixed
owner-authorized registration operation may change scopes, with monotone fences
and exact replay. Scope revocation must wait for admitted work to drain.

Actual kernel service actors need reviewed schema role/grants and a separately
approved membership effect. Human finance roles are not implicitly service
policy. Observe actor kind, role and membership fence independently from the
control principal's generation; a resumed execution lease does not rewrite
accepted generations. Runtime readiness verifies actual restricted connections,
current app release, database scopes and loaded private configuration.

## Development and evidence

Implement and iterate locally first, following
[the parallel local Builder guide](../local-development-lifecycle.md#run-and-use-the-local-builder).
Use separate worktrees, ports, state, generated outputs and client connections.
Do not replace the selected hosted app with a diagnostic app. Local tests,
fixtures and native recovery proofs remain separately labeled.

Record central setup, app provisioning/publication, Auth, provider activation,
canonical data, isolation/lifecycle and public Builder evidence separately.
A-469 remains incomplete until every applicable acceptance row has exercised
hosted evidence. Cleanup has its own concrete scope. Broad CI remains deferred
until functional completion; do not restructure it.
