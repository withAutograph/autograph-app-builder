# Autograph App Builder

Autograph App Builder is a durable, portable
[Agent Plugin](https://agent-plugins.org/) for designing, planning, creating,
and validating apps in explicitly supported repositories. Codex is the first
user-facing entrypoint.

The project is based on
[`jasonmorganson/eve-agent-plugin`](https://github.com/jasonmorganson/eve-agent-plugin)
without changing that source repository.

## Install

Once the pre-release `v0.2.0` GitHub release is published, download and verify
its complete asset set, extract the endpoint-bound Codex marketplace, and
install it. These commands fail closed until that release exists:

```sh
(
  set -eu
  release_version=0.2.0
  release_dir="$PWD/autograph-app-builder-release-$release_version"
  marketplace_dir="$PWD/autograph-app-builder-marketplace-$release_version"
  mkdir "$release_dir" "$marketplace_dir"
  gh release download "v$release_version" \
    --repo withAutograph/autograph-app-builder \
    --dir "$release_dir"
  cd "$release_dir"
  shasum -a 256 -c SHA256SUMS
  gh release verify "v$release_version" \
    --repo withAutograph/autograph-app-builder
  gh release verify-asset "v$release_version" \
    "autograph-app-builder-codex-marketplace-$release_version.tar.gz" \
    --repo withAutograph/autograph-app-builder
  tar -xzf \
    "autograph-app-builder-codex-marketplace-$release_version.tar.gz" \
    -C "$marketplace_dir"
  codex plugin marketplace add "$marketplace_dir"
  codex plugin add autograph-app-builder@autograph
)
```

Complete OAuth, open a new task, and mention `@Autograph App Builder`. A shared
marketplace listing is a separate distribution action and is not implied by a
GitHub release. See
[the complete installation guide](docs/installing.md) for every supported
option.

## Current implemented workflow

The current local slice supports an existing eligible checkout or an explicitly
allowlisted fresh-template checkout:

1. inspect the source with the versioned, non-executing V0 adapter;
2. emit a canonical receipt binding source kind, exact SHA, eligibility,
   supported-template contract, and release-disabled state;
3. for a fresh-template source, require a separate acquisition approval that
   does not clone, copy, or create a destination repository;
4. materialize that exact approved receipt at `/workspace/repository` inside the
   App Builder's isolated workspace; and
5. persist the prepared phase in durable Eve state and expose a verified,
   read-only workspace-status receipt while unrestricted shell and file writes
   remain disabled;
6. record and exactly read approval-bound prototype artifact receipts without
   writing the target workspace; and
7. accept a recorded AppSpec revision against that receipt; and
8. after a distinct approval, verify and materialize the image-internal,
   target-bound offline dependency closure only in the builder-owned planning
   overlay; and
9. after another distinct approval, run only the fixed target identity and planning
   commands against a builder-owned input overlay and record their strictly
   parsed, digest-bound receipts; and
10. after a separate apply approval and a fresh readiness check, invoke only the
    fixed target apply command in a fresh builder-owned overlay, recording exact
    planning-input, prepared-source pre-tree, post-tree, and normalized
    changed-content receipts. The exact accepted AppSpec is staged after the
    prepared-source snapshot so a new or changed conventional AppSpec remains
    an explicit reviewed and published path. Its exact repository path and
    digest remain bound through apply, validation, review, and publication. A
    V2 apply, validation, and normalized-change receipt boundary rejects the
    earlier path-less receipt shape while the aggregate workflow remains V12.
    Literal V2 is checked again at apply reuse, validation, reviewed-change,
    local-publication, and branch-publication trust boundaries; recomputing a
    historical receipt digest cannot upgrade its authority. A
    pre-command inspection, baseline-restore, snapshot, or staging failure
    removes only that fresh overlay and remains safely retryable; once command
    dispatch occurs, any observation failure is durably recovery-required; and
11. after a separate validation approval, persist a pending attempt before
    execution, then run only the fixed check and test commands in independent
    builder-owned copies of the exact applied tree and record a durable pass or
    recovery-required failure receipt without publication claims. A passed
    validation can then produce a read-only normalized change-set proposal and,
    after separate approval, a durable reviewed receipt; and
12. after choosing a publication outcome and granting another approval, either
    apply the reviewed set to the exact original checkout or create a
    deterministic builder-owned branch/worktree at the exact base and apply it
    there without committing or mutating the original checkout; or, for a
    fresh-template source only, atomically install a fully built one-commit
    repository at an approved absent or exact-empty local destination.

Prototype artifacts are durable, session-scoped receipts under
`prototype/<app-id>/`; only `app-spec.md`, `decisions.md`, and `index.html`
are accepted. Recording a new artifact revision invalidates any accepted
AppSpec and downstream proposal. Artifact recording never writes the target
workspace. The durable workflow uses its V13 state key so older, synthetic, or
unverified-cache planning state cannot be mistaken for target identity or
planning receipts. Every dependency, identity, proposal, apply, validation,
review, and publication boundary carries the prepared source commit and tree;
the immutable dependency-cache target must match both before target planning;
an intact prepared sandbox can still be recovered and reviewed again.

The real target commands remain fail-closed until an immutable cache-bearing
sandbox image is configured and its fixed manifest and archive bytes are
verified inside the sandbox. No free-form cache digest is accepted. Tests use an
injectable executor and never run Arrusted commands. Apply is proposal-bound,
approval-gated, and limited to a fresh builder-owned overlay; a failed attempt
after command dispatch persists recovery-required state and is never replayed
automatically. Receipt reuse re-observes the planning, prepared, and applied
trees rather than trusting an earlier success alone. Validation
is separately approved, runs each fixed command against an independent copy,
and persists pending state before execution so an interrupted attempt is never
redispatched automatically. Local publication is separately approval-bound,
disabled unless `APP_BUILDER_LOCAL_PUBLICATION=1`, and constrained by
`REPOSITORY_LOCAL_ROOTS` to the exact original existing checkout. It performs
a fixed binary-capable `git apply` invocation behind a durable Git-worktree
journal. The workflow records mutation intent before dispatch, verifies exact
HEAD, index, remote, unrelated-work, and postimage state afterward, and uses a
checked reverse patch after a reported post-dispatch failure. It does not claim
multi-file crash atomicity and never changes Git state.
Branch-worktree publication is a distinct outcome, separately enabled by
`APP_BUILDER_BRANCH_WORKTREE_PUBLICATION=1`, with its canonical pre-created
builder-owned root named by `APP_BUILDER_BRANCH_WORKTREE_ROOT`. That absolute
root must be realpath-identical, owned by the current user, mode `0700`, and
disjoint from the source checkout and Git directories; its lock, journal,
staging, and worktree families reject links, foreign ownership, permissive
modes, or filesystem changes. Its read-only
proposal binds the exact source root/Git identity, base SHA/tree, index,
remotes, full status, reviewed paths, modes, and content digests to a
collision-safe branch/worktree identity. Approval records durable intent
outside the target Git directory before an atomic branch ref creation and a
filter- and hook-disabled `git worktree add --no-checkout`. Base blobs and
reviewed postimages are fsynced in builder-owned staging and atomically renamed;
only the new worktree receives them. An OS-managed `flock` or `lockf` excludes
concurrent publication and is released by the kernel after process loss. No
new side effect is dispatched after helper death is observed at a pre/post
boundary; a synchronous operation already in flight may finish before that
observation and is covered by the exact durable recovery state. The lock inode
retains an abandoned-lease marker after abnormal helper or parent loss, so an
immediate contender fails closed instead of overlapping that operation; this
slice provides no automatic lease reset. The helper and Git subprocesses use
fixed executables and minimal environments without ambient Node, Git,
user-config, or dynamic-loader controls. A graceful hook failure or cancellation
before durable journal creation explicitly releases the helper, clears the
lease, and leaves the reviewed workflow retryable. Abnormal helper or parent
loss before journal creation leaves no journal or branch but retains the
abandoned lease and therefore requires a future separately authorized reset.
Every post-journal retry is bound to the journal. No commit, push, remote publication, provider,
deployment, or release action runs. Partial and lost-response states are never
replayed automatically; a separate recovery approval must name the
exact durable journal digest and fails closed on any conflicting bytes or Git
identity. The original checkout's HEAD, index, and worktree state remain exact.

Fresh local bootstrap is exposed only through the supported mise lifecycle
entrypoint. Pre-create two disjoint canonical directories owned by the current
user with mode `0700`, then start the local builder with:

```bash
mise run local:start -- /absolute/builder-state /absolute/destination-root /absolute/source-repository
```

The task owns the runtime configuration boundary; do not export bootstrap
environment variables directly. Every status, publish, and recovery tool
re-reads the configured roots and fixed executable identities. Without this
entrypoint—or after either root or helper changes—the capability is unavailable.
Publication remains separately approval-bound. Restart recovery uses the same
mise-owned host gate and exact journal digest. An abnormal ACTIVE lease cannot
be taken over; only a still-running coordinator may mark it QUIESCED after all
bounded helpers have returned. Exact-empty publication retains the swapped-out
empty inode as a receipt-bound tombstone rather than deleting it by path.

GitHub source resolution, draft-PR proposal sealing, and publication use typed,
installation-bound operations and closed V2 approval receipts. They remain
fail-closed unless the deployment composes the least-privilege adapter and
durable proposal/receipt stores. A sealed proposal is also bound into the
current workflow aggregate; publication rejects an older review, another
session's source, or any changed proposal before provider mutation. A malformed
receipt-bound approval batch becomes a public adapter failure rather than an
actionable approval. Local AppSpec and change-set approvals instead expose a
closed digest-only local subject derived from their exact tool input; they never
project raw artifact content or changed-file payloads. An input-dependent Eve
approval policy reads the current workflow first, so a missing or wrong-phase
GitHub receipt is denied before Eve creates an approval request and cannot be
reinterpreted as local. The shipped default runtime is still disabled until
that live deployment composition is installed.
The skills do not authorize raw target commands, tokens, or shell fallbacks.

The initial adapter supports the known `withAutograph/arrusted-development`
repository family and fails closed on drift. It deliberately does not infer
workflows for arbitrary repositories and does not use a target-owned repository
template manifest.

## Included surfaces

- Eve `0.43.0` with durable sessions and human-in-the-loop approvals.
- The four app-creation skills: `create-app`, `design-app`,
  `plan-app-creation`, and `scaffold-app-workspace`.
- A purpose-built supported-template eligibility adapter and canonical V3
  source receipt that distinguishes existing-repository from fresh-template.
  Its durable evidence and digest bind the logical source kind, adapter, exact
  SHA and tree, eligibility, contract files, and disabled release policy without
  binding the checkout's absolute path. The local path remains an un-hashed
  runtime diagnostic. Reproduce portable evidence with:

  ```sh
  mise run source:inspect -- --source-kind <existing-repository|fresh-template> --source-path <absolute-allowlisted-path>
  ```

- An approval-gated, digest-bound isolated App Builder workspace tool.
- Durable prepared-phase state plus a read-only workspace integrity tool.
- Approval-bound, session-scoped prototype artifact receipts with exact-digest
  readback and a content-free workflow-status receipt.
- Approval-bound AppSpec acceptance, separate offline dependency preparation,
  and fixed bounded target identity/planning commands. Strict receipts bind
  source commit and tree, workspace, toolchain, observed cache bytes, and artifact revision
  without writing the prepared target workspace.
- Proposal-bound target apply in a fresh builder-owned overlay, with a separate
  approval, a repeated readiness check, normalized pre/post tree evidence, and
  durable success or partial-failure receipts. Planning-input and
  prepared-source tree digests remain distinct, and the accepted AppSpec is
  verified and included in the canonical change set whenever it differs from
  the source.
- Approval-bound fixed target validation in independent exact-tree overlays,
  with an atomic durable claim, protected source/cache/planning/apply drift
  detection, passed or recovery-required failure receipts, and no
  validation-generated files admitted to reviewed change sets.
- Three distinct local publication outcomes: exact-checkout apply, creation of
  an uncommitted deterministic branch/worktree, or atomic fresh-template
  bootstrap into an approved absent or exact-empty destination. Each has
  separate durable intent, terminal, partial-failure, lost-response, and
  recovery receipts.
- A fixed, read-only sandbox toolchain inspection receipt; it cannot accept
  commands, install tools, or authorize target repository execution.
- Five public MCP operations: `autograph_start`, `autograph_get`, `autograph_send`,
  `autograph_respond`, and `autograph_cancel`, mapped to the unchanged internal
  Eve session service as documented in
  [`docs/public-mcp-contract.md`](docs/public-mcp-contract.md).
- A loopback-only local MCP-to-Eve adapter.
- A provider-neutral hosted Eve service core with strict request-scoped Bearer
  and remote-JWKS verification, protected-resource metadata, closed principal
  and membership boundaries, exact per-operation scopes, a tenant-scoped
  durable PostgreSQL store adapter, non-replaying idempotency state machine,
  workload-authenticated HTTPS membership/transport adapters, and public-only
  projection. The checked-in route remains fail-closed because deployment
  credentials and runtime composition are intentionally not supplied; see
  [`docs/hosted-eve-bridge.md`](docs/hosted-eve-bridge.md).
- Confirmation-bound hosted database tasks for exact membership activation and
  revocation, terminal-row retention, and drained tenant deletion. Their closed
  receipts contain only source/authority digests and bounded row counts.
- Confirmation-bound Preview activation tasks for operator-invited users, a
  separately verified least-privilege runtime database role, and bounded
  resource/JWKS initialization. Public signup remains disabled; owner-only
  requests carry secrets while receipts contain only digests, counts, and exact
  privilege/role-attribute booleans. The runtime role has no memberships or
  inherited, replication, bypass-RLS, owner, or extra object authority.
- Deterministic unit tests and Eve evals that drive the real HTTP session
  surface with a fixture model, including approval and cancellation paths.
  A non-Node trusted launcher rejects ambient `NODE_OPTIONS` and replaces the
  child environment with an explicit allowlist before every supported mise task
  can start the pinned Node or pnpm executable. Dynamic-loader influence before
  `/bin/sh` begins remains an operating-system and parent-process trust boundary;
  the launcher does not claim to sanitize its own already-started process. The
  named test tasks then keep the non-Node launcher alive as the wrapper's parent
  and mint a process-scoped structural capability only after the wrapper has
  verified the launcher's exact executable, source digest, cwd, and tokenized
  argv. A wrapper-owned public key is delivered over inherited private IPC and
  a signed, one-shot challenge is consumed. The registry also verifies an exact
  supported launcher-root wrapper parent argv before binding that key. The
  protocol fixture has no authorization path; a separate non-authorizing
  harness proves 4096-byte frame limits, exact frame counts, terminal closure,
  and stream backpressure. Only exact supported Eve,
  Vitest, and harness worker entrypoints receive fresh signed one-shot proofs;
  arbitrary Node, shell, and worker descendants inherit no reusable authority. A
  module-private registry brands the capability for the authorized process
  lifetime after consuming the proof. Importing the tracked preload, copying
  its environment flags, creating a MessageChannel, or
  forging the former public symbol does not enable a fixture path. The real
  sandbox proof receives only the fixture-model capability, so target and
  publication simulation remain fail-closed while the pinned image is observed.
  Linux lineage inspection uses `/proc`. macOS uses fixed, isolated OS tooling
  to read exact process arguments and cwd; Codex's ordinary sandbox blocks that
  inspection, so the macOS lineage proof is intentionally an approved local
  test boundary and fails closed without that access.

## Portable plugin package

The canonical cross-client contract is the published
[Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification).
The repository keeps its portable source components at the fixed standard
locations:

- `plugin.json` is the canonical portable manifest;
- `skills/` contains portable Agent Skills;
- `mcp.json` declares the Streamable HTTP MCP server; and
- `schemas/agent-plugins/1.0.0/` vendors the canonical versioned schemas used by
  `mise run package:validate`.

Build the client-neutral installable directory with:

```bash
mise run package:build
```

The result is `.artifacts/agent-plugin/autograph-app-builder/`. It is validated
as a clean generated artifact containing exactly the portable manifest, MCP
declaration, Agent Skills, and license. It deliberately excludes
`.codex-plugin/plugin.json` and `.app.json`, which are generated OpenAI/Codex
distribution metadata rather than Agent Plugins core. The artifact is the
canonical portable package; client-specific packages are derived adapters.

The source `mcp.json` intentionally retains a loopback development endpoint.
Versioned releases replace it with one literal hosted HTTPS origin and publish
both the portable Agent Plugins package and a derived Codex marketplace archive.
Each archive is deterministic and bound to the source SHA/tree and endpoint by
`release-receipt.json` and `SHA256SUMS`. See
[`docs/installing.md`](docs/installing.md) for installation and release
instructions. Agent Plugins 1.0.0 leaves OAuth, credentials, and client-specific
installation UX to each client; no credential is embedded in either archive.

`mise run package:validate` verifies the source components against the vendored,
digest-pinned Agent Plugins 1.0.0 schemas and the specification's version,
transport, public-header, path-containment, and Agent Skills discovery rules.
The build command separately validates the generated clean artifact, so source
files and client adapters cannot accidentally enter the portable package.
`mise run package:validate-release` additionally refuses the development MCP endpoint; it
does not replace the hosted and cross-client proofs above.

## Run Autograph App Builder locally

Use Node.js 24 and pnpm 11.7.0:

```bash
mise run dependencies:install
mise run check
mise run test:agent
mise run local:dev
```

For a non-interactive smoke test through App Builder itself:

```bash
mise run local:smoke
```

To inspect the fixed tool allowlist through App Builder's real sandbox backend:

```bash
mise run test:sandbox-toolchain
```

Use the named mise tasks for these eval lanes. The internal preload and eval
wrapper are not supported entrypoints and do not create a second runtime mode.
The same rule applies to local, build, package, and unit-test operations: the
named task is the supported boundary because its non-Node launcher rejects
ambient Node options before the pinned runtime starts.

The inspection is observational and remains not-ready unless an externally
built, preloaded OCI image is configured through
`APP_BUILDER_SANDBOX_IMAGE=<image>@sha256:<digest>`. The agent never pulls,
builds, or publishes that image: its pinned microsandbox backend uses
`pullPolicy: "never"` and deny-all network policy. The image must contain Git,
`mise 2026.8.12`, `bun 1.3.14`, and the target-bound external dependency
closure; the receipt verifies the exact versions and cache bytes
before any future typed target command can be enabled. See [the implementation
gates](docs/implementation-gates.md). The reproducible `linux/arm64` image
source and its digest-resolution procedure are documented in
[`containers/eve-sandbox`](containers/eve-sandbox/README.md).

On an exact matching Vercel Preview or Production deployment the agent selects
Eve 0.43's supported Vercel Sandbox backend instead of attempting to start
local microsandbox. Eve's
Vercel backend fixes the runtime to its Vercel Container Registry
`vercel/eve:latest` image and removes author-supplied image/runtime fields. It
therefore cannot consume `APP_BUILDER_SANDBOX_IMAGE`, which is the private GHCR
artifact carrying the exact mise/Bun versions and Arrusted dependency cache.
The Vercel template bootstrap instead installs checksum-pinned mise `2026.8.12`
and Bun `1.3.14` for either supported Linux architecture, allowing only the two
GitHub release hosts while building the reusable snapshot. It also receives a
server-only, digest-bound seed containing the exact supported Arrusted Git tree
and a platform-portable planning-only dependency closure. The seed is included
in the server function trace, is never placed under `public/`, and is copied
into the reusable template before every live session switches to deny-all
networking. The hosted runtime can therefore run the fixed read-only identity and planning
commands against `/opt/app-builder/hosted-source/arrusted-development` without
claiming the private GHCR image as hosted authority. Missing, Development, and
mismatched environment bindings use the non-executing fallback. Production
support here is source capability, not activation evidence.

Rebuild the seed with `mise run hosted:artifact-build -- --arrusted-root
<exact-clean-checkout> --output artifacts/hosted/arrusted-c9a5faf2-preview.tar.gz`.
Validate its server-only placement, exact bytes, and real offline target
commands with `mise run test:hosted-sandbox`.
Run `mise run hosted:artifact-prove-typed -- --image <exact-local-digest-ref>
--source-root <exact-clean-checkout>` to combine that artifact proof with the
approval-bound Eve workflow proof. It must terminate at `planned` and emits the
asserted called-tool and forbidden-tool trace.

For local source access, set `REPOSITORY_LOCAL_ROOTS` to a platform-delimited
allowlist of absolute roots. Fresh-template acquisition means approving one
exact local checkout receipt; it never means cloning or creating a destination
repository. A separately approved preparation copies the reviewed tree into the
durable App Builder workspace; the source checkout is not mutated.

To enable the branch/worktree publication outcome, pre-create a canonical
builder-owned directory, set its absolute path in
`APP_BUILDER_BRANCH_WORKTREE_ROOT`, and set
`APP_BUILDER_BRANCH_WORKTREE_PUBLICATION=1`. This does not enable the distinct
exact-checkout publisher, GitHub publication, commits, pushes, or deployment.
The host must provide `/usr/bin/flock`, `/bin/flock`, or `/usr/bin/lockf`; the
operation fails closed when no OS-managed advisory-lock helper exists.

## Use the local MCP façade

After linking the repository to the intended Vercel project, refresh the
Development environment with `vercel env pull .env.local --environment
development --yes`, then run `mise run local:install-oidc`. The install task
emits only a transient sanitized status record; do not persist it as a public
receipt. It validates the linked Development project without requiring an
unrelated user identity claim and atomically owner-binds `.env.local` at mode
`0600`. This is claim validation; AI Gateway remains responsible for
cryptographic signature verification. `local:start` rejects a missing,
symlinked, expired, mismatched, or permissive credential file.

For the fresh-bootstrap-capable local lifecycle, pre-create the two owner-only
roots described above, then run `mise run local:start -- <state-root>
<destination-root> <local-source-root>`. The third argument is one exact,
canonical, owner-bound existing repository root; it becomes Eve's only local
source allowlist and is never read from ambient environment. The task
supervises Eve on loopback port 2000 and Next.js
on loopback port 3000, and injects the exact same capability and local adapter
configuration into both children. Run `mise run local:smoke` in another shell
to verify the real Next health route and invoke the running Eve service. The
adapter rejects non-loopback hosts and is never enabled implicitly.

The source manifest is intentionally a non-releasable endpoint template. The
existing derived-manifest workflow remains available for an approved deployed
origin:

```bash
mise run package:configure -- --origin https://your-approved-deployment.example
mise run package:validate-release
```

A sealed portable release can instead inject its separately approved, literal
HTTPS endpoint without mutating the source manifest. The command neither
deploys nor registers a connection:

```bash
mise run package:build-portable-release -- \
  --endpoint https://mcp.autograph.dev
```

The resulting archive, SHA-256 digest receipt, and offline client harness
inputs are written below `.artifacts/portable-release/`. Reserved development hosts,
localhost, credentials, and non-literal endpoint templates are rejected before
an archive can be sealed. The tarball contains only the Agent Plugins core;
client-specific offline adapters are emitted beside it and never added to the
portable package root.

Never put bearer tokens or secrets in `mcp.json` or `.app.json`.

Hosted request handling is enabled only with `EVE_HOSTED_ADAPTER=1` and a
complete deployment configuration. The route lazily opens its bounded
PostgreSQL pool on the first hosted request. `withEve(nextConfig)` deploys the
canonical Eve 0.43 session routes in the same Vercel project and origin as
`/mcp`; each request-context hop presents a fresh project OIDC token directly
to those routes. The verified MCP user crosses that hop only through Eve's
closed forwarded-principal field, accepted from the configured exact Vercel
team/project/environment. The environment must be exactly `preview` or
`production`, and `VERCEL_ENV` must match the explicit
`EVE_HOSTED_VERCEL_ENVIRONMENT`; missing, Development, wildcard, and mismatched
bindings fail closed. Production still requires separate activation evidence.
This boundary never falls back to the local adapter. Hosted composition also
requires a fresh, closed
`EVE_HOSTED_ADMISSION_CONTROL` JSON binding to an exact provider readback. That
binding names bounded per-subject and per-workspace start/session ceilings plus
current monthly spend and its ceiling, and expires within 24 hours. Starts are
rejected at the spend ceiling; the durable reservation transaction enforces the
start/session limits before dispatch. The
OAuth resource metadata is served from
`/.well-known/oauth-protected-resource`. The signed, consent-bound
`workspace_id` access-token claim is the sole workspace selector. OAuth
authorization-server discovery is rewritten from the RFC well-known path. The
Hosted scope contract does not advertise OpenID discovery. Its `aud`
must equal the canonical `/mcp` resource URL, and the resource server accepts
only tokens with an integer `nbf`/`iat` and at most a five-minute lifetime. A
live exact subject/workspace membership row is required on every MCP request
before the tenant-scoped store or Eve transport can run. Importing the route
does not create a database connection or obtain a workload credential. The
hosted Better Auth issuer is mounted at `/api/auth`, with exact OAuth AS
discovery, JWKS, explicit sign-in, and sole-workspace confirmation on the
single consent surface. The consent reference is re-read from the user's sole
active workspace immediately before consent and token issuance. Signed-query
public-client prelogin verifies the CIMD client identity and exact requested
scopes before consent; client and resource management endpoints deny every
authenticated user action.
Those routes construct lazily and fail closed until the checked-in schema is
separately applied and the exact supported environment is configured; their
presence does not create a client, consent, grant, key, membership, or token.
Hosted identity uses invite-only GitHub sign-in. The App Builder does not
accept or store a user password, public signup is disabled, and accounts are
bound to a pre-provisioned stable GitHub account ID rather than implicitly
linked by email. GitHub proves user identity only; repository mutation remains
a separate approval-bound capability.
Activating the checked-in CIMD policy remains separately authorized because
discovery may create, persist, or refresh an authorization-server client record;
DCR remains disabled. The checked-in MCP and store contracts contain no
continuation credential.
The first configured request can also overwrite the exact resource seed and
create the first ES256 JWKS key pair in PostgreSQL. Both are separately
authorized database mutations and are not proven by mounting these routes.

The real memory-adapter handler proof exercises both GET-query and POST-form
authorization, CIMD resolution, the signed consent query, allow and deny,
S256 code exchange, exact five-minute ES256 resource/workspace claims, and
membership drift before consent and token exchange. It uses Better Auth's
handler directly; no proxy or compatibility patch is installed. This remains
source proof rather than deployment, database, or client-registration proof.

The deterministic source/configuration receipt is explicitly marked
`source-configuration-only` and `activation.status=not-proven`. A distinct
future live-activation schema requires digest-bound deployment, OAuth metadata,
minted-token, migration, admission-control, workload-identity, tenant-isolation,
and five-tool lifecycle evidence. Neither schema performs or authorizes those
external actions.

Preview database changes are plan-first. Run
`mise run hosted:admin-plan -- --request-file /absolute/owner-only.json`, approve
the exact confirmation digest, then run only the matching
`hosted:membership-seed`, `hosted:membership-revoke`,
`hosted:retention-apply`, or `hosted:tenant-delete` task. The tasks emit
sanitized digests and counts; their presence does not authorize database,
provider, Preview, or Production mutation.

## Authority boundary

AppSpec acceptance, target command execution, source/topology mutation,
publication, release activation, provider provisioning, deployment, tenant
activation, and Production readiness are distinct authorities. A valid proposal
or isolated-workspace receipt proves none of the later outcomes.

Hosted identity, durable cross-process idempotency, and provider resources are
still gated by [the implementation gates](docs/implementation-gates.md).

## License

MIT
