# GitHub acquisition and publication gate

The builder defines a provider-neutral, typed boundary for future GitHub App
composition. The current runtime is deliberately fail-closed: it performs no
live GitHub calls until a selected-repository installation adapter and durable
compare-and-set receipt store are configured.

This is a contract precursor, not completed live GitHub publication. It proves
the closed proposal, approval, provider-read-back, journal, and receipt boundary
under a deterministic adapter. It does not prove GitHub App installation,
authentication, network behavior, repository creation, pushing, or opening a
pull request against GitHub.

The boundary supports four operations:

1. Resolve one installation-selected private repository ref to an immutable
   repository ID, SHA, and tree receipt.
2. Create one private repository with fresh history from an exact reviewed
   fresh-template tree.
3. Publish an exact reviewed path set to a deterministic branch and open one
   draft pull request.
4. Recover an unknown provider outcome by the proposal's idempotency key
   without repeating the mutation.

Repository creation and draft-PR publication are separate approvals. Each
proposal binds the exact installation identity, selected repository or private
destination, reviewed change-set digest, source/base SHA and tree, and the
absence of `REPOSITORY_RELEASE_ENABLED`. Immediately before mutation, the
adapter must re-observe those bindings and refuse stale base state, changed-path
overlap, branch or destination collision, release-gate drift, or digest drift.

Receipts contain opaque provider identities and canonical digests, but never a
token, authorization header, raw provider response, or raw provider error.
Provider calls are journaled through durable compare-and-set intent before the
side effect. A mutation transport failure, provider read-back failure, invalid
postcondition, or terminal-store failure remains pending and is reconciled by
exact idempotency read-back. Only an explicit provider rejection becomes a
bounded sanitized failure receipt and requires explicit recovery.

The typed tools accept no command, executable, working directory, environment,
credential, endpoint, arbitrary refspec, or provider response. Generic shell,
local Git publication, release activation, deployment, tenant activation, and
Production are not fallback authority for this boundary.
