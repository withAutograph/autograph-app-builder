# Implementation gates

The loopback local adapter and approval-gated isolated workflow through target
validation are usable for local development and testing. Apply remains confined
to a fresh builder-owned overlay; validation uses independent copies of that
exact tree. Reviewed change-set generation, local publication, and hosted
operation remain fail-closed until their typed tools and receipts land; the
generic shell and writer remain disabled. Hosted use also remains
fail-closed until the production identity and session gates below are complete.

Before enabling local repository mutation or publication:

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
   The implemented fixed target identity and planning operation then uses a
   builder-owned overlay, bounded execution, strict output schemas, and durable
   receipts. Real execution still requires both the immutable image and a
   matching durable dependency-preparation receipt; fixture tests execute no
   Arrusted command. The read-only pre-plan workspace readiness receipt binds the
   prepared source/workspace receipts to the immutable toolchain observation.
   The implemented proposal-bound apply-readiness receipt adds the exact
   proposal digest. Neither executes a target command or authorizes apply.
3. The implemented prototype-artifact tools allow only the three conventional
   files, bind AppSpec acceptance to an exact recorded revision, and invalidate
   downstream receipts when artifact bytes or paths change. The implemented
   apply tool separately approves the exact proposal, reruns execution readiness,
   writes only a fresh builder-owned overlay, and stores pre/post tree,
   changed-content, strict command, and recovery-required partial-failure
   receipts. The implemented validation tool persists pending state before
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
4. Add an approval-gated local publisher that verifies exact destination SHA,
   dirty-path overlap, approved paths, and change-set digest before applying.
5. Prove denial, interruption/retry, stale-input, overlap, and lost-response
   behavior through Eve evals.
6. The implemented fresh local-template receipt and acquisition approval are
   limited to an exact allowlisted checkout and remain separate from workspace
   preparation. Add clone/destination creation and GitHub draft-PR publication
   only as separate source/publication adapters with their own approvals.

Re-run the observational real-backend receipt with:

```bash
pnpm test:sandbox-toolchain
```

This command does not install missing tools or authorize target command
execution. It requires a host supported by Eve's microsandbox backend. The
2026-08-24 proof passed every eval gate; Eve also emitted a non-fatal cleanup
diagnostic (`configure is not a function`) after the sandbox had been stopped.

Before enabling real MCP mutations:

1. Configure Better Auth as the OAuth authorization server with CIMD, PKCE, consent, and the workspace OIDC provider.
2. Derive `workspaceId` and `ownerUserId` only from verified token claims.
3. Apply the Drizzle schema and require both identifiers in every session query.
4. Encrypt any cached continuation credential with versioned server-side keys.
5. Resolve Eve's idempotency capability. If no deterministic start key exists, persist `submission_unknown` and never redispatch automatically.
6. Replace the loopback-only service in `lib/eve/service.ts` with the authenticated `eve/client` adapter using Vercel OIDC and manual redirects.
7. Map only installed Eve `0.43.0` events through the public allowlist and prove cursor behavior.
8. Complete the MCP Apps host bridge. The iframe must invoke tools through the host, never call Eve or private endpoints directly.
9. Pass cross-tenant, OAuth-negative, disclosure, cancellation, and lost-response tests.

Do not advertise exactly-once starts or a production installation until these gates have evidence.
