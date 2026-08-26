# Implementation gates

The loopback local adapter and approval-gated isolated workflow through target
validation are usable for local development and testing. Apply remains confined
to a fresh builder-owned overlay; validation uses independent copies of that
exact tree. Reviewed change-set generation and both approval-bound local
publication outcomes for an existing checkout are implemented; hosted
operations remain fail-closed until their typed tools and receipts land; the
generic shell and writer remain disabled. Hosted use also remains
fail-closed until the production identity and session gates below are complete.

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

Before enabling GitHub or hosted repository publication:

1. Build and pre-load an externally approved OCI image pinned by manifest
   digest, containing Git, `mise 2026.8.12`, `bun 1.3.14`, and the exact
   target-bound external dependency closure. The committed `linux/arm64` build
   definition and digest-resolution procedure are in
   [`containers/eve-sandbox`](../containers/eve-sandbox/README.md). This
   repository accepts an image only through `APP_BUILDER_SANDBOX_IMAGE` as an `@sha256` digest,
   with the microsandbox backend's `pullPolicy: "never"`, deny-all networking,
   and an image-bound template revalidation key. Image build, publication, and
   acquisition remain separate authority. Require the typed toolchain receipt
   to match every pinned version before any target-owned command can run. With
   no configured image, the agent selects just-bash and is deliberately not
   toolchain-ready.
2. The implemented approval-gated dependency preparation verifies the fixed
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
   apply tool separately approves the exact proposal, reruns execution readiness,
   writes only a fresh builder-owned overlay, and stores pre/post tree,
   changed-content, strict command, and recovery-required partial-failure
   receipts. Its durable planning-tree binding is distinct from the
   prepared-source pre-tree: the accepted AppSpec is verified in planning,
   restored to the prepared-source baseline for the pre-snapshot, and then
   staged as an allowed canonical apply change. The exact AppSpec path and
   digest remain receipt-bound by the V2 apply, validation, and normalized
   change-set receipt shapes; the aggregate workflow remains V12. Every reuse,
   validation, review, and local or branch publication boundary checks literal
   V2 before accepting reconstructed digests, so JSON omission of the AppSpec
   path cannot recreate current authority. Failures
   before command dispatch remove only the
   fresh apply overlay and permit a clean retry; a post-dispatch snapshot failure
   records a recovery-required receipt and retains the overlay for reconciliation.
   Reuse re-observes the planning, prepared, and applied tree digests. The
   implemented validation tool
   persists pending state before
   execution, rechecks readiness and the exact applied tree, and runs only the
   adapter-owned `mise run check` and `mise run test` commands in independent
   builder-owned copies. It records only bounded, digested output evidence and
   durable pass or recovery-required failure state. It rechecks protected
   source, cache, planning, and applied bindings after each command and records
   drift instead of claiming success; validation overlays never supply files to
   the future reviewed change set. The implemented typed change-review tools
   derive an ordered, path-safe normalized proposal only from the exact canonical
   applied overlay and passed validation receipt. `change_set_status` is
   read-only; `accept_change_set` separately approves its digest and rechecks
   the same overlay before recording the durable reviewed receipt. Neither
   validates, executes a target command, or publishes. The implemented
   `target_execution_status` rechecks the exact planned proposal, prepared
   workspace, and immutable toolchain receipt before any future target command;
   gate every mutating operation in code.
4. The exact-checkout, branch/worktree, and fresh-repository local publishers are separately
   approval-gated and verify the destination/source SHA, index, remotes, full
   status, dirty-path overlap, approved paths, modes, and change-set digests.
5. Eve evals prove approval, cancellation, stale input, dirty overlap,
   partial-failure, lost-response, no automatic redispatch, and separately
   approved recovery behavior without generic shell or writer use.
6. The fresh local-template receipt and acquisition approval remain separate
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
   reset in this slice. GitHub
   draft-PR publication and remote template acquisition remain unavailable.
   Local operators expose this production capability only with `mise run
local:start -- <owner-only-state-root> <owner-only-destination-root>`; direct
   environment configuration is not a supported interface.

Re-run the observational real-backend receipt with:

```bash
mise run test:sandbox-toolchain
```

This command does not install missing tools or authorize target command
execution. It requires a host supported by Eve's microsandbox backend. The
2026-08-24 proof passed every eval gate; Eve also emitted a non-fatal cleanup
diagnostic (`configure is not a function`) after the sandbox had been stopped.

GHCR publication has its own closed authentication gate. `mise run image:login`
accepts the operator-approved token once on bounded standard input and compares
it directly with the existing keyring credential read by pinned GitHub CLI
2.98.0. GitHub CLI status, keyring source, `write:packages` scope, account, and
namespace membership must all match; login, OAuth, refresh, and credential-store
operations are not available. Push and remote inspection later re-read only that
same digest-bound keyring credential through the lifecycle-owned Docker `get`
helper. Tokens never enter argv, environment, receipts, or persistent files.

Before enabling real MCP mutations:

1. Configure the implemented strict remote-JWKS verifier against the approved OAuth authorization server with CIMD, PKCE, consent, and the workspace OIDC provider; prove revocation behavior separately.
2. Supply the request-scoped workspace membership adapter. The implemented boundary derives `workspaceId` and `ownerUserId` only from verified claims and makes missing, mismatched, denied, and failed workspace lookups indistinguishable.
3. Apply the checked-in Drizzle-derived migration with `mise run database:migrate`
   and prove that issuer, audience, workspace, and owner remain in every query.
4. Encrypt any cached continuation credential with versioned server-side keys.
5. Resolve Eve's idempotency capability. If no deterministic start key exists, persist `submission_unknown` and never redispatch automatically.
6. Inject an approved workload-identity provider into the implemented HTTPS
   transport/membership adapters and prove the fixed gateway paths with manual
   redirects in the deployed environment.
7. Map only installed Eve `0.43.0` events through the public allowlist and prove cursor behavior.
8. Complete the MCP Apps host bridge. The iframe must invoke tools through the host, never call Eve or private endpoints directly.
9. Pass cross-tenant, OAuth-negative, disclosure, cancellation, and lost-response tests.

The provider-neutral service prerequisite is documented in
[`hosted-eve-bridge.md`](hosted-eve-bridge.md). It implements the closed
request-principal boundary, strict Bearer and remote-JWKS verification,
protected-resource metadata, tenant-scoped durable PostgreSQL store adapter,
idempotency state machine, five-operation service core, public event projection,
workload-authenticated HTTPS transport/membership adapters, and local
conformance tests. The MCP route selects a request-scoped service without a
hosted-to-local fallback, while the checked-in composition intentionally
supplies no database handle or workload identity. Migration execution,
deployment composition, and registration still require separate evidence and
authority.

Do not advertise exactly-once starts or a production installation until these gates have evidence.
