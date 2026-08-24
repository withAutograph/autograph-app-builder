# Implementation gates

The loopback local adapter and approval-gated read-only workspace preparation
are usable for local development and testing. Local app execution and
publication remain fail-closed until typed plan/apply/review/publication tools
replace the disabled generic shell and writer. Hosted operation also remains
fail-closed until the production identity and session gates below are complete.

Before enabling local repository mutation or publication:

1. Extend the implemented durable prepared phase and implemented accepted
   AppSpec/read-only proposal phases, which are bound to source SHA,
   eligibility digest, source tree, workspace digest, and AppSpec digest, with
   reviewed change-set phase and digest.
2. Add typed identity, planning, prototype-artifact, apply, validation, and
   change-review tools. Gate every mutating operation in code.
3. Add an approval-gated local publisher that verifies exact destination SHA,
   dirty-path overlap, approved paths, and change-set digest before applying.
4. Prove denial, interruption/retry, stale-input, overlap, and lost-response
   behavior through Eve evals.
5. Add fresh-template acquisition and GitHub draft-PR publication only as
   separate source/publication adapters with their own approvals.

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
