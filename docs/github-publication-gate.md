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

The repository also contains a disabled-by-default runtime composition seam.
`createGitHubAppPublicationAdapter` accepts only an injected provider port,
requests the exact operation-scoped permission set, closes every provider
snapshot before returning it, and sanitizes provider transport failures. The
provider port—not Eve input—owns GitHub authentication, the fixed API origin,
and template materialization. Reviewed file bytes come only from a typed,
read-only content source over the re-observed validated apply overlay. The
runtime verifies every postimage path, mode, digest, and byte digest against the
exact reviewed receipt before passing an ephemeral content bundle to the
provider mutation port.

`createPostgresGitHubPublicationStores` persists closed proposals and delegates
mutation receipts to the single shared PostgreSQL CAS journal in the
Drizzle-owned tenant-scoped `hosted_github_publication_proposal` and
`hosted_github_publication_journal` tables. Every primary key, idempotency
index, read, insert, and compare-and-set includes the exact issuer, audience,
workspace, and owner tuple. The JSON record is authoritative; duplicate index
columns are rebound on every read, and receipt transitions use one SQL
compare-and-set against the prior receipt digest. The earlier unscoped V5
tables remain unused compatibility artifacts. Migration remains the mise-owned
`database:migrate` operation.

`hosted_github_installation` binds that same tenant tuple to one exact GitHub
App installation and expected account identity. Binding is available only
through the owner-only, confirmation-digest-bound
`hosted:github-installation-bind` mise task. It stores no application private
key, installation token, user OAuth token, or provider response.

`composeGitHubPublicationRuntime` enables the typed tools only when an adapter,
proposal store, and receipt store are all injected with `enabled: true`. The
shipped singleton passes `enabled: false`. It reads no token, endpoint,
environment variable, or database URL, and this slice performs no GitHub or
database call. A later deployment composition must supply the credential-bound
provider and database handle, then prove the behavior against GitHub before
EXT-BLD-04 can be accepted.

Publication content is never written to a proposal, workflow aggregate,
database row, mutation receipt, or log. Both fresh-repository and draft-PR
mutation calls require the live reviewed receipt and content source. A missing,
mode-drifted, or digest-drifted postimage stops before provider dispatch. If a
prior provider call has an exact successful read-back, lost-response recovery
returns that receipt without reopening or rereading the overlay.

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

The repository now supplies the PostgreSQL CAS store, its additive schema, and
a fixed-`api.github.com` HTTP provider. The provider reads only the closed
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`
credential contract, creates short-lived App JWTs, and mints a fresh
installation token with the exact permissions for each operation. It accepts
immutable template or reviewed-change bytes only through an injected,
digest-verified material source; tokens, endpoints, raw responses, and raw
errors never enter a proposal or receipt. The fail-closed runtime still does
not compose these pieces with live credentials.

The permission contract includes `workflows: read` for source inspection and
`workflows: write` only for fresh-history or reviewed draft-PR mutation. This is
required because a complete supported template can include approved files
under `.github/workflows`; contents permission alone cannot write those paths.
The provider creates a parentless initial Git commit from the full immutable
template material rather than asking GitHub to resolve a mutable template ref.

A
proposal digest is the journal authority key; duplicated digest, idempotency,
kind, and status columns are rebound to the closed JSON receipt. The hosted
tenant retention task cannot delete these rows. `hosted:storage-verify` proves
the exact installed schema read-only, not GitHub installation or mutation.

The typed tools accept no command, executable, working directory, environment,
credential, endpoint, arbitrary refspec, or provider response. Generic shell,
local Git publication, release activation, deployment, tenant activation, and
Production are not fallback authority for this boundary.
