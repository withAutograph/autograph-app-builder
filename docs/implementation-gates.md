# Implementation gates

The loopback local adapter and approval-gated read-only workspace preparation
are usable for local development and testing. Local app execution and
publication remain fail-closed until typed plan/apply/review/publication tools
replace the disabled generic shell and writer. Hosted operation also remains
fail-closed until the production identity and session gates below are complete.

Before enabling local repository mutation or publication:

1. Build and pre-load an externally approved OCI image pinned by manifest
   digest, containing Git, `mise 2026.8.12`, and `bun 1.2.20`. This repository
   accepts it only through `APP_BUILDER_SANDBOX_IMAGE` as an `@sha256` digest,
   with the microsandbox backend's `pullPolicy: "never"`, deny-all networking,
   and an image-bound template revalidation key. Image build, publication, and
   acquisition remain separate authority. Require the typed toolchain receipt
   to match every pinned version before any target-owned command can run. With
   no configured image, the agent selects just-bash and is deliberately not
   toolchain-ready.
2. Extend the implemented durable prepared phase and implemented accepted
   AppSpec/read-only proposal phases, which are bound to source SHA,
   eligibility digest, source tree, workspace digest, and AppSpec digest, with
   reviewed change-set phase and digest.
3. Add typed identity, planning, prototype-artifact, apply, validation, and
   change-review tools. Gate every mutating operation in code.
4. Add an approval-gated local publisher that verifies exact destination SHA,
   dirty-path overlap, approved paths, and change-set digest before applying.
5. Prove denial, interruption/retry, stale-input, overlap, and lost-response
   behavior through Eve evals.
6. Add fresh-template acquisition and GitHub draft-PR publication only as
   separate source/publication adapters with their own approvals.

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
7. Map only installed Eve `0.38.3` events through the public allowlist and prove cursor behavior.
8. Complete the MCP Apps host bridge. The iframe must invoke tools through the host, never call Eve or private endpoints directly.
9. Pass cross-tenant, OAuth-negative, disclosure, cancellation, and lost-response tests.

Do not advertise exactly-once starts or a production installation until these gates have evidence.
