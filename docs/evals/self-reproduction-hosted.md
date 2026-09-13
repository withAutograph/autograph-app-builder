# Hosted self-reproduction eval proposal

Status: prerequisite implementation only. No hosted eval controller is deployed,
no GitHub-hosted acceptance run is proven, and the existing self-hosted workflow
still needs a runner.

`acquireHostedEvalOidc` acquires the current invocation identity with the existing
Vercel workload adapter and uses `@vercel/oidc` remote-JWKS verification for the
explicit project, owner and deployment environment. It requires expiration claims
and never reads Development files or static provider keys. Calling it again
reacquires identity; this does not refresh credentials already injected into a
running worker. Local Development validation remains separate. The explicit `--hosted-oidc`
entrypoint option selects this boundary for candidate comparison credentials;
it does not yet adapt the generation subprocess or reference launcher.

## Proposed execution

A GitHub-hosted `workflow_dispatch` job obtains a GitHub OIDC token and calls a
Vercel control endpoint. The endpoint must authenticate issuer, audience,
repository ID, workflow/ref and run identity. It uses its own Vercel project OIDC
to start a detached Sandbox worker and returns a run ID promptly. GitHub polls
status, downloads retained reports and uploads them as Actions artifacts.
Long generation belongs in Sandbox, not one long-lived Function request.

## Remaining prerequisites

- Implement and deploy authenticated start/status/artifact endpoints, with durable
  run state and cleanup. No trigger endpoint exists yet.
- Supply private Arrusted checkout access through an authorized short-lived GitHub
  installation token or authorized source upload. The Builder repository's job
  token does not establish access to another private repository.
- Adapt the reference runtime's existing external-database path to real isolated
  Postgres reachable from Sandbox. Its current launcher assumes local Docker.
- Wire hosted credentials explicitly into generation and comparison; a helper
  does not make the Development-oriented full entrypoint hosted-compatible.
- Refresh worker credentials between phases or through a protected control path,
  and preserve partial reports before shutdown. Never serialize runtime tokens.
- Replace the unavailable self-hosted runner only after the hosted path is
  implemented and one live acceptance run has passed.

Official references: [Vercel OIDC](https://vercel.com/docs/oidc),
[Sandbox duration](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence),
[Trusted Sources](https://vercel.com/changelog/trusted-sources-for-deployment-protection).
