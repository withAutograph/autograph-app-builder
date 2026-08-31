# Autograph App Builder

Autograph App Builder is a durable, portable
[Agent Plugin](https://agent-plugins.org/) for designing, planning, creating,
and validating apps in explicitly supported repositories. Codex is the first
user-facing entrypoint.

The project is based on
[`jasonmorganson/eve-agent-plugin`](https://github.com/jasonmorganson/eve-agent-plugin)
without changing that source repository.

## Install

Register the Autograph marketplace once, then install App Builder:

```sh
(
  codex plugin marketplace add withAutograph/marketplace
  codex plugin add app-builder@autograph
)
```

Complete OAuth, open a new task, and mention `@Autograph App Builder`. The
marketplace imports the immutable endpoint-bound package published by this
repository; it does not rebuild or hand-edit the plugin. See the
[complete installation guide](docs/installing.md) for verified release-archive
installation and every supported client.

## Supported execution modes

There are exactly two user-facing modes:

- `mise run dev -- --arrusted-root /absolute/path/to/arrusted` is the fast,
  non-release loop. It uses that explicit checkout only for local development;
  every new App Builder application acquires the canonical Arrusted `main`
  template through the clone-and-pin source boundary, reuses platform-specific
  dependency state, exposes the
  exact five public `autograph_*` tools on loopback `/mcp`, and cannot publish,
  deploy, select hosted bindings, or mutate a provider.
- `mise run release:prove` builds and locally proves one clean, immutable
  package/image/deployment candidate. After separate authorization,
  `mise run release:publish` uploads and deploys only those proven bytes and
  never rebuilds them.

Eve and the local, image, package, and eval tasks are internal helpers, not
additional development or proof modes. See the authoritative
[execution-mode contract](docs/execution-modes.md) for arguments, safety
boundaries, cache identity, and promotion flow.

## Internal workflow engine

Inside the supported modes, the workflow engine can model an existing eligible
checkout or an explicitly allowlisted fresh-template checkout:

1. for a new app, clone the canonical Arrusted HTTPS `main` ref, resolve its
   exact commit/tree, then inspect that source with the versioned V0 adapter;
2. emit a canonical receipt binding source kind, exact SHA, eligibility,
   supported-template contract, and release-disabled state;
3. for a fresh-template source, automatically verify one exact acquisition
   receipt without cloning, copying, or creating a destination repository;
4. materialize that exact receipt at `/workspace/repository` inside the
   App Builder's isolated workspace; and
5. persist the prepared phase in durable Eve state and expose a verified,
   read-only workspace-status receipt while unrestricted shell and file writes
   remain disabled;
6. automatically record and exactly read prototype artifact receipts without
   writing the target workspace; and
7. silently record a complete AppSpec revision against that receipt; and
8. automatically verify and materialize the image-internal,
   target-bound offline dependency closure only in the builder-owned planning
   overlay; and
9. automatically run only the fixed target identity and planning
   commands against a builder-owned input overlay and record their strictly
   parsed, digest-bound receipts; and
10. after a fresh readiness check, automatically invoke only the
    fixed target apply command in a fresh builder-owned overlay, recording exact
    planning-input, prepared-source pre-tree, post-tree, and normalized
    changed-content receipts. The exact accepted AppSpec is staged after the
    prepared-source snapshot so a new or changed conventional AppSpec remains
    an explicit reviewed and published path. Its exact repository path and
    digest remain bound through apply, validation, review, and publication. A
    V2 apply, validation, and normalized-change receipt boundary rejects the
    earlier path-less receipt shape while the aggregate workflow remains V15.
    Literal V2 is checked again at apply reuse, validation, reviewed-change,
    local-publication, and branch-publication trust boundaries; recomputing a
    historical receipt digest cannot upgrade its authority. A
    pre-command inspection, baseline-restore, snapshot, or staging failure
    removes only that fresh overlay and remains safely retryable; once command
    dispatch occurs, any observation failure is durably recovery-required; and
11. automatically persist a pending validation attempt before
    execution, then run only the fixed check and test commands in independent
    builder-owned copies of the exact applied tree and record a durable pass or
    recovery-required failure receipt without publication claims. A passed
    validation can then produce a read-only normalized change-set proposal and
    durable reviewed receipt without another user interruption; and
12. after choosing a publication outcome and granting another approval, either
    apply the reviewed set to the exact original checkout or create a
    deterministic builder-owned branch/worktree at the exact base and apply it
    there without committing or mutating the original checkout; or, for a
    fresh-template source only, atomically install a fully built one-commit
    repository at an approved absent or exact-empty local destination.

The publication operations in this engine are retained as typed internal gates
and structural test fixtures. The public `dev` mode hard-disables all of them;
they are not a third supported local workflow. Release promotion accepts only
the sealed candidate-byte path described above.

Prototype artifacts are durable, session-scoped receipts under
`prototype/<app-id>/`; only `app-spec.md`, `decisions.md`, and `index.html`
are accepted. Recording a new artifact revision invalidates any accepted
AppSpec and downstream proposal. Artifact recording never writes the target
workspace. The durable workflow uses its V15 state key so older, synthetic, or
unverified-cache planning state cannot be mistaken for target identity or
planning receipts. Every dependency, identity, proposal, apply, validation,
review, and publication boundary carries the prepared source commit and tree;
the immutable dependency-cache target must match both before target planning;
an intact prepared sandbox can still be recovered and reviewed again.

The real target commands remain fail-closed until an immutable cache-bearing
sandbox image is configured and its fixed manifest and archive bytes are
verified inside the sandbox. No free-form cache digest is accepted. Tests use an
injectable executor and never run Arrusted commands. Apply is proposal-bound,
automatic and limited to a fresh builder-owned overlay; a failed attempt
after command dispatch persists recovery-required state and is never replayed
automatically. Receipt reuse re-observes the planning, prepared, and applied
trees rather than trusting an earlier success alone. Validation runs
automatically against independent copies with fixed commands,
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

Local execution is exposed only as `mise run dev`; the `local:*` tasks are
private mechanics. Development always uses an immutable source snapshot and a
separate builder-owned destination. Release proof and promotion are exposed
only as `mise run release:prove` and `mise run release:publish`. Every status,
publish, and recovery tool re-reads configured roots and fixed executable
identities rather than accepting ambient authority.
Publication remains separately approval-bound. Restart recovery uses the same
mise-owned host gate and exact journal digest. An abnormal ACTIVE lease cannot
be taken over; only a still-running coordinator may mark it QUIESCED after all
bounded helpers have returned. Exact-empty publication retains the swapped-out
empty inode as a receipt-bound tombstone rather than deleting it by path.

GitHub source resolution, draft-PR proposal sealing, and publication use typed,
installation-bound operations; outward publication uses a closed V2 approval
receipt. They remain
fail-closed unless the deployment composes the least-privilege adapter and
durable proposal/receipt stores. A sealed proposal is also bound into the
current workflow aggregate; publication rejects an older review, another
session's source, or any changed proposal before provider mutation. A malformed
publication approval becomes a public adapter failure rather than an actionable
request. Internal specification recording and change review never create public
approval requests or project raw artifact content and changed-file payloads.
The shipped default runtime is still disabled until
that live deployment composition is installed.
The skills do not authorize raw target commands, tokens, or shell fallbacks.

The initial adapter supports the known `withAutograph/arrusted-development`
repository family and fails closed on drift. It deliberately does not infer
workflows for arbitrary repositories and does not use a target-owned repository
template manifest.

## Included surfaces

- Eve `0.43.0` with durable sessions and human approval for outward effects.
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

- An automatic, digest-bound isolated App Builder workspace tool.
- Durable prepared-phase state plus a read-only workspace integrity tool.
- Automatically recorded, session-scoped prototype artifact receipts with exact-digest
  readback and a content-free workflow-status receipt.
- Silent internal AppSpec recording, offline dependency preparation,
  and fixed bounded target identity/planning commands. Strict receipts bind
  source commit and tree, workspace, toolchain, observed cache bytes, and artifact revision
  without writing the prepared target workspace.
- Proposal-bound target apply in a fresh builder-owned overlay, with a repeated
  readiness check, normalized pre/post tree evidence, and
  durable success or partial-failure receipts. Planning-input and
  prepared-source tree digests remain distinct, and the accepted AppSpec is
  verified and included in the canonical change set whenever it differs from
  the source.
- Automatic fixed target validation in independent exact-tree overlays,
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
- A product-focused conversation contract that keeps internal orchestration
  silent, infers conventional defaults, and reserves approval for visible
  outward effects; see
  [`docs/public-conversation-contract.md`](docs/public-conversation-contract.md).
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

The result is `.artifacts/agent-plugin/app-builder/`. It is validated
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

Use the repository-pinned toolchain. An explicit Arrusted checkout is only for
the existing-repository development workflow; a new app acquires the canonical
Arrusted `main` clone automatically:

```bash
mise run dependencies:install
mise run dev -- --arrusted-root /absolute/path/to/arrusted
```

Provider-emulation and Preview-reset commands remain internal validation lanes.
They are not supported execution modes and are never selected by `mise run dev`.

To inspect the fixed tool allowlist through App Builder's real sandbox backend:

```bash
mise run test:sandbox-toolchain
```

The sandbox and eval tasks are internal validation lanes. Their preload and
eval wrappers are not supported entrypoints and do not create a second runtime
mode.
The same rule applies to local, build, package, and unit-test operations: the
named task is the supported boundary because its non-Node launcher rejects
ambient Node options before the pinned runtime starts.

The inspection is observational and remains not-ready unless an externally
built, preloaded OCI image is configured through
`APP_BUILDER_SANDBOX_IMAGE=<image>@sha256:<digest>`. The agent never pulls,
builds, or publishes that image: its pinned microsandbox backend uses
`pullPolicy: "never"` and deny-all network policy. The image must contain Git,
`mise 2026.8.12` and `bun 1.3.14`. A fresh-template session bootstraps the
resolved clone's locked dependency closure under a fixed bootstrap allowlist,
seals it to its SHA/platform receipt, and restores deny-all networking before
any typed target command can be enabled. Existing V3 sessions retain their
fixed offline cache while they complete. See [the implementation
gates](docs/implementation-gates.md). The reproducible `linux/arm64` image
source and its digest-resolution procedure are documented in
[`containers/eve-sandbox`](containers/eve-sandbox/README.md).

On an exact matching Vercel Preview or Production deployment the agent selects
Eve 0.43's supported Vercel Sandbox backend instead of attempting to start
local microsandbox. Eve's
Vercel backend fixes the runtime to its Vercel Container Registry
`vercel/eve:latest` image and removes author-supplied image/runtime fields. It
therefore cannot consume `APP_BUILDER_SANDBOX_IMAGE`, which is the private GHCR
artifact carrying the exact mise/Bun versions.
The Vercel template bootstrap instead installs checksum-pinned mise `2026.8.12`
and Bun `1.3.14` for either supported Linux architecture, allowing only the two
GitHub release hosts while building the reusable snapshot. It also receives a
server-only managed tooling seed. For a fresh app, the same server-side
canonical clone resolver verifies the SHA's Arrusted readiness check, records
a V4 receipt, and materializes that reviewed tree into the session workspace.
Its one locked bootstrap is followed by deny-all networking, so planning,
generation, application, and validation never inherit network authority.
Legacy V3 sessions may still read their pre-existing source seed while they
complete. Missing, Development, and mismatched environment bindings use the
non-executing fallback. Production support here is source capability, not
activation evidence.

Validate the hosted toolchain placement and the canonical clone provenance
with `mise run test:hosted-sandbox`.
Run `mise run hosted:artifact-prove-typed -- --image <exact-local-digest-ref>
--source-root <exact-clean-checkout>` to combine that artifact proof with the
silent Eve workflow proof. It must terminate at `planned` and emits the
asserted called-tool and forbidden-tool trace.

For an explicit existing repository, set `REPOSITORY_LOCAL_ROOTS` to a
platform-delimited allowlist of absolute roots. Fresh-template acquisition
never uses that allowlist: it resolves the one canonical HTTPS Arrusted ref,
records its detached clone receipt, and materializes the reviewed tree into
the durable App Builder workspace. Neither source workflow mutates its source
checkout.

To enable the branch/worktree publication outcome, pre-create a canonical
builder-owned directory, set its absolute path in
`APP_BUILDER_BRANCH_WORKTREE_ROOT`, and set
`APP_BUILDER_BRANCH_WORKTREE_PUBLICATION=1`. This does not enable the distinct
exact-checkout publisher, GitHub publication, commits, pushes, or deployment.
The host must provide `/usr/bin/flock`, `/bin/flock`, or `/usr/bin/lockf`; the
operation fails closed when no OS-managed advisory-lock helper exists.

## Use the local MCP façade

Run `mise run dev -- --arrusted-root <absolute-local-checkout>`. Development
does not use hosted OAuth, Vercel project selection, or `.env.local`. It starts
Eve on loopback port 2000 and Next.js plus `/mcp` on loopback port 3000. After
the endpoint proves the exact five-tool contract, the task replaces its stable,
ignored `autograph-dev` local marketplace registration and installs
`app-builder@autograph-dev` into the active `CODEX_HOME`. Keep the task running,
then open a fresh Codex task and select Autograph App Builder (Development).
Open returned prototype links in the integrated ChatGPT Browser. The package
intentionally has no MCP App preview registration.

The source manifest is intentionally a non-releasable endpoint template.
Derived-manifest and release-package tasks are private release helpers, not
additional supported modes.

A sealed portable release is produced only inside `mise run release:prove`,
which injects the separately approved literal HTTPS origin without mutating the
source manifest. Package construction is a private helper of that command:

```bash
mise run release:prove -- \
  --arrusted-root /absolute/path/to/clean/arrusted \
  --endpoint https://mcp.autograph.dev \
  --output /absolute/path/to/release-candidate
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
Hosted identity uses verified GitHub or Vercel sign-in. Local development and
Deployment-Protected Preview deployments may separately enable passkey-first
testing as described in [passkey testing](docs/passkey-preview-testing.md).
Stable callback origins and deployment receipts for hosted integration tests
are documented in
[Preview integration testing](docs/preview-integration-testing.md).
Passkey users receive a real Better Auth session and deployment-bound personal
workspace without being represented as email-verified. Production onboarding
remains disabled. The App Builder does not accept or store a user password.
Before the first provider session, the server
reuses one exact membership, accepts one matching invitation, or—only when
the Vercel-managed `self-service-signup` flag resolves enabled—creates one
Better Auth personal organization and owner membership transactionally.
Same-email provider accounts link only when both identities are verified;
differing emails require explicit signed-in linking. Provider identity proves
the user only; repository mutation remains a separate approval-bound
capability. The exact contract and rollout are in
[self-serve onboarding](docs/self-serve-onboarding.md).
Storybook resolves `builder-connections` from the same Vercel Flags declaration
when it starts or builds, passing only that Boolean result to its browser
bundle. Pull `FLAGS` before running Storybook and restart or rebuild it after a
dashboard change; without the SDK key, Storybook fails closed with Connections
hidden.
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
