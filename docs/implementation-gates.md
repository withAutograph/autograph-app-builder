# Implementation gates

The public execution contract has exactly two modes: non-release
`mise run dev`, and immutable promotion through `mise run release:prove`
followed by separately authorized `mise run release:publish`. All task names
below describe internal gates within one of those modes; none is an additional
supported development or proof entrypoint. The complete boundary is defined in
[App Builder execution modes](execution-modes.md).

The loopback local adapter and isolated workflow through target
validation are usable for local development and testing. Apply remains confined
to a fresh builder-owned overlay; validation uses independent copies of that
exact tree. Reviewed change-set generation and both approval-bound local
publication outcomes for an existing checkout are implemented; hosted
operations remain fail-closed until their typed tools and receipts land; the
generic shell and writer remain disabled. Hosted use also remains
fail-closed until the production identity and session gates below are complete.

Better Auth Infrastructure is a post-migration operator surface, not workspace
authority. Its fail-closed Starter dashboard configuration and activation order
are defined in [Better Auth Infrastructure](better-auth-infrastructure.md).
Verified GitHub and Vercel first-login provisioning, invitation precedence,
account linking, and rollback are defined in
[Self-serve onboarding](self-serve-onboarding.md).

Local publication requires `APP_BUILDER_LOCAL_PUBLICATION=1` and an exact
canonical checkout under `REPOSITORY_LOCAL_ROOTS`. Workflow V10 atomically owns
the exact pending and terminal publication attempt. The builder applies one
binary-capable patch through fixed `git apply` arguments after recording durable
intent and rechecking root, Git-directory, HEAD, index, remote, unrelated-work,
and reviewed-path identities. Topology is dispatched last. A reported
post-dispatch failure is inspected and reversed only when every publisher
postimage still matches. Multi-file publication is not globally crash-atomic;
an interrupted or conflicted rollback is recorded as recovery-required and is
never automatically retried. It does not touch the Git index, HEAD, branch,
remotes, commits, providers, deployments, or releases.

The distinct branch/worktree outcome additionally requires
`APP_BUILDER_BRANCH_WORKTREE_PUBLICATION=1` and an existing canonical
builder-owned `APP_BUILDER_BRANCH_WORKTREE_ROOT`. The root must be an absolute,
realpath-identical directory owned by the current user with mode `0700`, on one
filesystem, and disjoint from the source checkout and its Git/common
directories. Symlinked, hard-linked, cross-owner, or permissive lock, journal,
staging, and worktree paths fail closed. Its proposal binds the exact
source root and Git-directory identity, base SHA/tree, symbolic HEAD, index,
remotes, full status, review, approved paths, modes, and content digests to a
deterministic full-digest branch/worktree identity. It journals intent outside
the target Git directory before atomically creating the branch ref and adding a
hook- and filter-disabled no-checkout worktree. Base and postimage files move
from fsynced builder-owned staging through atomic rename, so interrupted writes
cannot poison the final tree; exact branch-only and partial registered-worktree
states remain recoverable. An OS-managed `flock` or `lockf` excludes concurrent
attempts and releases on process loss. Helper liveness is checked before and
after every bounded side-effect boundary. Once helper exit is observed, no
later side effect is dispatched; a synchronous operation already in flight may
finish before that observation and remains represented by the exact durable
recovery state. A valid lease marker is written to the locked inode before the
ready handshake and cleared only by explicit clean release. Abnormal helper or
parent loss leaves it abandoned, so later contenders fail closed; this slice
provides no automatic reset. The helper and Git children use fixed executables
and minimal environments without ambient Node, Git, user-config, or
dynamic-loader injection.
Git children additionally use fixed hook-, filter-, fsmonitor-, and
attribute-affecting options. A graceful hook failure or cancellation before
journal creation performs explicit clean release and leaves the reviewed
workflow retryable. Abnormal helper or parent loss before journal creation
leaves no journal or branch but preserves the abandoned lease and is not
automatically retryable. A verified durable success reconciles
pending or failed workflow state. Only that new worktree receives the reviewed
postimages; the source checkout is re-read and must remain exact. It creates no
commit and performs no push, GitHub, provider, release, or deployment
operation. A partial failure or lost response is
durable and cannot retry automatically. The recovery tool has its own approval,
is bound to the exact pending/failed journal digest, resumes only preimage or
already-applied postimage states, and refuses conflicts.

Before enabling GitHub or hosted repository publication, require Eve 0.44.4's
native Vercel Sandbox backend. Its exact Development, Preview, or Production
binding must agree with `VERCEL_ENV`, and authentication must come from the App
Builder project's short-lived Vercel OIDC identity. No static key, local
container runtime, image registry, or silent execution fallback is an active
execution authority. The reusable Vercel template installs the
exact checksum-pinned mise and Bun binaries for `aarch64` or `x86_64` with a
two-host bootstrap allowlist. A server-only traced artifact supplies the
exact Arrusted Git tree and a platform-portable, planning-only dependency
closure; its source, cache, and artifact digests are part of the template
revalidation key. The bootstrap installs those bytes before every live
session changes to deny-all networking. The artifact is never a public
route or static asset. The hosted backend can run only the fixed read-only
identity and planning commands; missing, Development, or mismatched Vercel
environments use the non-executing backend.
The bounded command backend is active for every hosted template and live
session command. It shares one stdout/stderr byte budget, rejects direct
authored process spawning, enforces wall and no-output deadlines, actively
kills the process, cancels stream readers, and bounds kill cleanup. Eve
0.43 exposes no provider-native per-command timeout on its public sandbox
session surface, so no such timeout is claimed.
Durable per-turn execution leasing remains dormant unless a deployment sets
the exact `EVE_HOSTED_SANDBOX_EXECUTION=enabled-v1` gate. The awaited
`turn.started` hook acquires before dynamic tools and each command reasserts
its PostgreSQL epoch; terminal turn hooks stop compute before releasing.
`session.waiting` is deliberately not a release boundary because it may be
an in-turn authorization park. `mise run test:postgres-sandbox-leases`
proves same-subject serialization, the workspace cap, idempotent replay,
rollback, expiry, heartbeat, and recovery/reacquisition races against an
ephemeral digest-pinned PostgreSQL container. A provider stop failure keeps
the fenced lease orphaned and admission-blocking; only a successful stop may
settle it as released, and one failed stop does not abort the remaining
recovery batch. This source proof does not activate the gate or prove
provider-side orphan lookup and stop.
The combined `hosted:artifact-prove-typed` gate first proves those exact
artifact commands offline, then exercises the silent Eve tool flow
to terminal `planned` and emits its asserted called/forbidden tool trace. 2. The implemented automatic dependency preparation verifies the fixed
image-internal manifest and archive bytes, binds Arrusted commit/tree and
contract/lock hashes, and extracts `node_modules` only into builder-owned
planning metadata under deny-all runtime networking. It precreates the
archive's directories and preserves their metadata during extraction so the
verified cache remains reliable on the sandbox overlay filesystem. Its durable receipt is
internally observed; `APP_BUILDER_DEPENDENCY_CACHE_DIGEST` is not accepted.
The cache target, durable source receipt, and prepared workspace must agree
on both the exact source commit and tree. That binding is carried through
dependency, identity, proposal, apply, validation, review, and publication
receipts; a SHA match with a different tree fails closed.
Source receipt V3 hashes only this immutable logical binding; its absolute
local checkout path is diagnostic and deliberately excluded. Generate the
strict path-independent evidence with:

```sh
mise run source:inspect -- --source-kind <existing-repository|fresh-template> --source-path <absolute-allowlisted-path>
```

The command emits no local path, rejects the V2
schema and unknown arguments, and does not prepare or mutate the source.
The implemented fixed target identity and planning operation then uses a
builder-owned overlay, bounded execution, strict output schemas, and durable
receipts. Real execution still requires both the immutable image and a
matching durable dependency-preparation receipt. Named mise test tasks inject
a process-scoped structural capability for fixture execution only after a
non-Node launcher rejects ambient `NODE_OPTIONS`, replaces the Node child
environment with an explicit allowlist, and a wrapper-owned root key plus
one-shot private IPC challenge succeeds. Pre-exec dynamic-loader influence on
the launcher itself remains an operating-system/parent-process trust boundary.
The non-Node launcher remains the wrapper parent. The wrapper verifies exact
launcher executable, source digest, cwd, and tokenized argv before creating a
key; the registry separately accepts only exact launcher-root wrapper argv
tokens and binds the inherited key. No test protocol fixture is an accepted
authority parent. A non-authorizing pure harness verifies bounded complete
frames, exact counts, backpressure, and terminal closure. The registry brands
only that authorized capability for the process lifetime after the signed
proof is consumed. Linux uses `/proc`; macOS exact process inspection requires
the approved local boundary and fails closed in an ordinary Codex sandbox.
Exact supported workers
derive fresh one-shot proofs from that authorized parent broker;
arbitrary Node, shell, and worker descendants do not. An ambient tracked
preload, copied flags, a self-created channel, or a forged public symbol cannot select simulated
target or publication behavior. Vitest and Eve use the same broker. The real
sandbox proof is structurally denied those capabilities. Fixture tests
execute no Arrusted command. The read-only pre-plan workspace readiness receipt binds the
prepared source/workspace receipts to the immutable toolchain observation.
The implemented proposal-bound apply-readiness receipt adds the exact
proposal digest. Neither executes a target command or authorizes apply.

3. The implemented prototype-artifact tools allow only the three conventional
   files, bind AppSpec acceptance to an exact recorded revision, and invalidate
   downstream receipts when artifact bytes or paths change. The implemented
   apply tool automatically handles the exact proposal, reruns execution readiness,
   writes only a fresh builder-owned overlay, and stores pre/post tree,
   changed-content, strict command, and recovery-required partial-failure
   receipts. Its durable planning-tree binding is distinct from the
   prepared-source pre-tree: the accepted AppSpec is verified in planning,
   restored to the prepared-source baseline for the pre-snapshot, and then
   staged as an allowed canonical apply change. The exact AppSpec path and
   digest remain receipt-bound by the V2 apply, V3 validation, and V2 normalized
   change-set receipt shapes; the aggregate workflow remains V15. Every reuse,
   validation, review, and local or branch publication boundary checks literal
   matching current versions before accepting reconstructed digests, so JSON omission of the AppSpec
   path cannot recreate current authority. Failures
   before command dispatch remove only the
   fresh apply overlay and permit a clean retry; a post-dispatch snapshot failure
   records a recovery-required receipt and retains the overlay for reconciliation.
   Reuse re-observes the planning, prepared, and applied tree digests. The
   implemented validation tool
   persists pending state before
   execution, rechecks readiness and the exact applied tree, and runs only the
   adapter-owned `mise run app:check-build <app-id>` and
   `mise run app:test <app-id> <shard>` commands in independent builder-owned
   copies. The V3 receipt binds the exact app id, shard set, and target-owned
   app-validation implementation digest. It records only bounded, digested output evidence and
   durable pass or recovery-required failure state. It rechecks protected
   source, cache, planning, and applied bindings after each command and records
   drift instead of claiming success; validation overlays never supply files to
   the future reviewed change set. The implemented typed change-review tools
   derive an ordered, path-safe normalized proposal only from the exact canonical
   applied overlay and passed validation receipt. `change_set_status` is
   read-only; `accept_change_set` automatically rechecks its digest and
   the same overlay before recording the durable reviewed receipt. Neither
   validates, executes a target command, or publishes. Internal specification
   recording and change review never create a public approval request.
   GitHub publication approval exposes only a canonical closed V2 receipt and
   binds the refreshed, durably sealed
   draft-PR proposal digest. The sealed proposal is stored in the current
   workflow aggregate with its source and review bindings, so an older proposal
   or another session's source cannot be adopted for publication. Missing or
   malformed GitHub publication approval fails publicly without exposing raw
   internal tool input. The implemented
   `target_execution_status` rechecks the exact planned proposal, prepared
   workspace, and immutable toolchain receipt before any future target command;
   gate every mutating operation in code. The sparse-brief conversation must
   continue through this apply, validation, and review chain without an internal
   approval event, then show the reviewable product result and offer a concrete
   outward-effect choice.
4. The exact-checkout, branch/worktree, and fresh-repository local publishers are separately
   approval-gated and verify the destination/source SHA, index, remotes, full
   status, dirty-path overlap, approved paths, modes, and change-set digests.
5. Eve evals prove silent internal completion, outward-effect approval,
   cancellation, stale input, dirty overlap, partial-failure, lost-response, no
   automatic redispatch, and separately approved recovery behavior without
   generic shell or writer use.
6. The fresh local-template receipt and automatic acquisition remain separate
   from publication. Fresh local publication accepts only the exact reviewed
   fresh-template tree, an absent or inode-bound exact-empty destination under
   a configured owner-only root, and a separately approved deterministic Git
   identity. It writes a fully verified same-filesystem sibling stage, creates
   one parentless SHA-1/files-ref commit with fixed Git plumbing and no remotes,
   and uses only the digest-bound native fd-relative NOREPLACE/EXCHANGE adapter.
   There is no plain-rename or in-place fallback. Journal and kernel-managed
   lease state are durable before repository mutation; exact partial and
   swapped-empty layouts require separately approved recovery. A successful
   exact-empty exchange retains the inode-bound old empty directory as a
   receipt-bound tombstone; this slice never removes it through a path-based
   cleanup race. An ACTIVE abandoned lease marker is never takeoverable. Only
   after every bounded synchronous helper has returned and been reaped may the
   still-running coordinator write an exact QUIESCED marker and recovery receipt;
   recovery must name that exact digest under the kernel lock. Parent death
   leaves ACTIVE state fail-closed, and a pre-journal abandoned marker has no
   reset in this slice. The typed GitHub proposal and publication boundary is
   implemented, but the shipped runtime remains unavailable until a deployment
   explicitly composes its least-privilege GitHub App adapter and durable
   stores. Fresh-repository mutation reads the complete prepared immutable
   source manifest and bytes and proves its exact Git tree; it deliberately
   excludes app changes. Draft-PR mutation instead reads only the reviewed
   changes from the re-observed validated apply overlay. The runtime checks
   exact paths, modes, object identities, digests, and bytes before dispatch,
   passes the closed discriminated content only to the provider call, and never
   persists it in workflow, proposal, or journal state. The HTTP provider has
   no independent material source. Exact successful read-back recovery does
   not reread either content source.
   Local operators expose this production capability only with `mise run
local:start -- <owner-only-state-root> <owner-only-destination-root>
<canonical-local-source-root>`; direct
   environment configuration is not a supported interface.

Re-run the observational sandbox contract with:

```bash
mise run test:sandbox-toolchain
```

This command does not install missing tools or authorize target command
execution. Provider-backed Preview and Production proofs execute on Vercel,
where project-scoped OIDC is present; GitHub CI verifies the exact Vercel Git
deployment and its public contract.

Before enabling real MCP mutations:

1. Configure and prove the checked-in hosted OAuth authorization server with
   CIMD, authorization code plus S256 PKCE, consent, and invite-only GitHub
   sign-in. The App Builder stores no user password and disables implicit
   email-based account linking; a pre-provisioned stable GitHub account ID is
   the identity authority. Its routes are mounted but remain fail-closed until
   the exact supported environment and unapplied schema are separately
   activated.
   It must mint an exact-resource, five-minute JWT with integer `nbf`
   and a consent-bound `workspace_id`; the hosted policy does not claim immediate token
   revocation and has a residual window of at most five minutes. Activating CIMD
   can create, persist, or refresh a discovery-owned authorization-server client
   record and therefore requires the same separate mutation authority as live
   consent and grant creation. DCR remains disabled.
   Every client/resource management action is denied, and signed-query public
   client prelogin must verify the portable CIMD identity and exact requested
   scopes before consent. The first configured request may overwrite the exact
   resource seed and create the first ES256 JWKS key pair; each is a separately
   authorized database mutation. The scope contract does not advertise OpenID
   discovery. Authorization code with S256 PKCE is the interactive grant and
   rotating refresh tokens continue a previously approved session.
   The memory-adapter handler proof covers GET-query and POST-form
   authorization, CIMD, signed consent, allow/deny, S256 exchange, exact
   five-minute ES256 claims, and membership drift. It is source proof only;
   deployment and live PostgreSQL activation remain separately evidenced.
2. Keep the signed `workspace_id` claim as the sole workspace selector. The
   implemented boundary derives `workspaceId` and `ownerUserId` only from
   verified claims and performs a live exact active-membership read for that
   subject/workspace on every MCP request before store or Eve access.
3. Bind each hosted environment to one origin: `/api/auth` is the issuer,
   `/api/auth/jwks` is its key source, `/mcp` is audience/resource, and the
   canonical Eve 0.44.4 routes remain under `/eve/v1/*` on that origin. The
   trusted-forwarder environment must be exactly `preview` or `production`,
   and must exactly equal `VERCEL_ENV`. Missing, Development, wildcard, and
   mismatched values fail closed. This source support is not Production
   activation evidence.
4. Establish an approved Preview database restore point, then apply all
   checked-in additive Drizzle-derived migrations with
   `mise run database:migrate`. Run `mise run hosted:storage-verify` afterward;
   it uses a read-only transaction to require the exact migration order,
   managed columns, indexes, constraints, bounded connection policy, tenant
   predicate contract, and durable GitHub publication CAS journal. Its
   sanitized receipt deliberately reports the external restore point as
   `not-proven`; source verification is not rollback evidence.
   Prove that issuer, audience, workspace, and owner remain in every tenant query.
   Membership seed/revoke, retention, and tenant deletion are separate
   confirmation-bound tasks with identity-free receipts. Retention preserves
   reserved replay authority and never deletes GitHub mutation journals;
   deletion requires a five-minute revocation drain.
5. Before hosted composition can open storage, bind a fresh exact provider
   readback through the closed `EVE_HOSTED_ADMISSION_CONTROL` contract. It must
   name bounded per-subject/workspace request and session ceilings plus current
   monthly spend and its ceiling, and expire within 24 hours. The runtime must
   enforce every field: monthly spend fails closed before dispatch, while the
   durable PostgreSQL start reservation serializes the start and active-session
   ceilings. Every observed session result refreshes the durable status used by
   those checks.
6. Keep continuation credentials outside the current MCP/store contract. The
   canonical installed Eve 0.44.4 session routes require only durable session IDs.
7. Resolve Eve's idempotency capability. If no deterministic start key exists, persist `submission_unknown` and never redispatch automatically.
8. Prove the checked-in request-context Vercel project OIDC call to the same
   origin's canonical Eve routes, including the exact trusted-forwarder subject,
   forwarded principal, and manual redirect denial.
9. Map only installed Eve `0.44.4` events through the public allowlist and prove cursor behavior.
10. Keep the MCP Apps host bridge limited to progress and input controls. It
    must never display or embed generated app previews. Open previews in the
    integrated ChatGPT/Codex Browser using a hosted HTTPS URL or a loopback URL
    for local proof; use an ordinary link when the integrated Browser is
    unavailable. The public result adds an exact session-and-content-bound URL
    only for those origins. Its route re-reads the caller-owned session and
    exact recorded artifact, returns `404` for absent, stale, or unauthorized
    content, disables storage, and applies a top-level CSP sandbox without
    same-origin authority, networking, forms, framing, or external resources.
    Raw prototype bytes remain workflow evidence and are never rendered by the
    MCP App. The MCP iframe must invoke tools through the host and never call
    Eve or private endpoints directly.
11. Pass cross-tenant, OAuth-negative, disclosure, cancellation, and lost-response tests.
12. Enforce the fixed 30-minute idle and 24-hour maximum hosted session
    lifetimes before transport access, and omit expired rows from admission
    counts. Expiry is not deletion; retention and drained tenant deletion remain
    separately confirmed operations.

The provider-neutral service prerequisite is documented in
[`hosted-eve-bridge.md`](hosted-eve-bridge.md). It implements the closed
request-principal boundary, strict Bearer and remote-JWKS verification,
protected-resource metadata, live PostgreSQL workspace-membership authority,
tenant-scoped durable PostgreSQL store adapter,
idempotency state machine, five-operation service core, public event projection,
same-origin canonical Eve transport, token-only workspace selection, and local
conformance tests. The MCP route selects a request-scoped service without a
hosted-to-local fallback, lazily composes the bounded PostgreSQL store, and
obtains Vercel workload identity only during a request-context hop. The
hosted Better Auth route, RFC OAuth AS discovery rewrite, JWKS, sign-in,
verified-client consent with single-active-workspace binding are mounted
lazily and fail closed
before an approved migration and exact environment are present.
Its source/configuration receipt is explicitly non-activation evidence. A
separate closed live-activation receipt schema requires all external proofs and
cannot be populated from source configuration alone.
The memory-adapter handler test covers OAuth AS discovery, ES256 JWKS, absent
OpenID metadata, management denial, GET/form authorization, signed consent,
allow/deny, PKCE token exchange, exact claims, and membership drift. It remains
in-memory source proof rather than deployed-issuer or live PostgreSQL proof.
Migration execution, deployment, and registration still require separate evidence and
authority.

Do not advertise exactly-once starts or a production installation until these gates have evidence.

Builder resource provisioning is independently fail-closed behind
`builder-resource-provisioning`. Do not enable that flag until all of the
following are true in the target environment:

1. Migration `0015_builder_resource_provisioning.sql` is applied and
   `mise run hosted:storage-verify` proves the tenant-scoped provisioning
   journal, GitHub credential table, indexes, constraints, retention, and
   deletion coverage.
2. The dedicated versioned GitHub user-token encryption key and GitHub webhook
   secret are installed. A signed revocation test must deactivate the affected
   credential or installation, and an expiring-token test must prove atomic
   access/refresh-token rotation.
3. The GitHub App has the required repository Administration and Contents
   permissions, and the selected Vercel installation can link repositories
   through its own GitHub integration. Prove organization, personal, team, and
   personal-scope read-back without exposing either provider token.
4. The resolved canonical Arrusted `refs/heads/main` commit has a successful
   `Template readiness` CI check. Prove the detached clone's canonical HTTPS
   origin/ref, exact source SHA/tree, V4 readiness attestation digest, locked
   bootstrap receipt, and deny-all target-command network policy before
   enabling provisioning.
5. A Preview proof creates and reads back an exact parentless GitHub `main`
   commit and a linked or intentionally standalone Vercel project, while the
   provider audit log proves that no deployments API was called. Keep the flag
   disabled if any migration, secret, permission, template-readiness, or
   provider read-back evidence is absent.
