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

An existing Builder-created draft can be updated from a later Builder session
even when its original publication receipt is unavailable to that tenant.
The recovery path does not invent an original receipt. It asks GitHub for the
current open draft, verifies the selected same-repository branch and head,
checks that the PR author is this GitHub App's bot, and requires the same
Builder origin marker in the PR body and current head commit. It then writes
one immutable adoption record in `hosted_github_draft_adoption`, keyed by the
tenant and exact repository and PR IDs. Each later Builder update commit
preserves the origin marker so subsequent reads keep that commit-level proof.
The sealed proposal still binds the current head and exact reviewed app-owned
diff; a separate approval and GitHub atomic expected-OID update are required.
If GitHub provenance cannot be verified, Builder reports that reason and leaves
the PR branch untouched.

Initial source selection is separate from publication. In a new session,
`resolve_github_source` accepts a named branch or any open same-repository PR,
including a PR already marked ready for review. It shows the selected branch
and PR number and reads the provider's current revision before preparing the
private checkout. Source inspection grants no publication authority. Draft
updates and reconciliation still require their existing draft, provenance,
review, and approval checks. An occupied session keeps its selected repository
and branch; choosing another source requires a new session.

An initial app baseline can select an older same-repository app while retaining
the selected platform branch. The ordinary brief identifies the app and either
a full commit ID or a merged PR. Before inspecting any app implementation,
Builder passes `appBaseline: { appId, source: { kind: "commit", commitSha } }`
or `source: { kind: "merged-pr", pullRequestNumber }` to
`resolve_github_source`. Provider reads verify the historical commit and tree;
the merged-PR form requires a merged same-repository PR, including one whose
head branch was deleted. No public MCP fields or evaluator preparation are
required.

Builder projects only `apps/<app>/` and the conventional
`.config/app-specs/<app>.cue` and `.md` inputs before returning source for
inspection. Shared platform and routing files stay on the selected platform.
Checked `apps/<app>/schema/release/` archives are immutable: existing archives
are retained, differing bytes at a historical archive path fail preparation,
and later retained archives are omitted from initial model source inspection.
The initial schema source and selected-release index come from the historical
app. An occupied source cannot adopt a new baseline.

The separate durable baseline receipt records the historical app commit/tree,
actual platform commit/tree and branch, session, source-selection call,
projection call, scoped source digest, and retained release count. Private
preimage digests compose the final review against the actual platform base;
historical baseline restoration and newly authored edits are both in that
review. Only the selected app and its two conventional spec inputs are eligible
for publication. An interrupted projection resumes its private plan before
source exposure; a healthy retry preserves later Builder edits. Replacement
compute uses the saved platform commit and restores the same app baseline.
This source provenance does not prove application behavior, production
readiness, deployment activation, or Builder authorship of historical files.
Publication retains its separate exact-diff review and approval.

When the current draft head conflicts with its live base, Builder prepares a
private merge candidate from the exact observed head and base commits. It may
resolve only conflicts under the selected app. The candidate runs its own
locked dependency install, schema compilation, repository app checks and tests,
and the app browser task when requested. Builder then exposes the complete
resolved diff against the live base and the complete delta from the old PR head
for review. A separate sealed approval binds both parent commits, the resolved
tree, both diffs, the draft PR, and the tenant-scoped repository. GitHub receives
a merge commit through an expected-head update without force pushing. A moved
base or head requires a fresh merge, validation, review, and approval.

`hosted_github_installation` binds that same tenant tuple to one exact GitHub
App installation and expected account identity. Binding is available only
through the owner-only, confirmation-digest-bound
`hosted:github-installation-bind` mise task. It stores no application private
key, installation token, user OAuth token, or provider response.

Public self-service installation uses a separate fail-closed authorization
boundary at `/github/installations`. A same-origin form POST creates a
ten-minute HMAC-signed state containing only an opaque nonce and the digest of
the current authenticated issuer, audience, workspace, and user tuple. Only
the state digest and tenant tuple are stored. The GitHub callback must present
the same live hosted session and workspace membership. The setup callback
atomically consumes the installation state, creates a second tenant-bound
authorization state, and redirects through GitHub's web authorization flow
with S256 PKCE. The authorization callback atomically consumes that second
state before exchanging the one-time code and derived verifier. The returned
GitHub user token is initially request-local: the callback uses it only against
the fixed
`api.github.com` `/user` and paginated `/user/installations` endpoints, accepts
only one unambiguous active installation for the configured App ID, checks
personal installations against the caller, rechecks live App Builder
membership, and then writes the existing tenant installation binding.
For pre-handoff personal-repository creation, it also encrypts the GitHub App
user access and refresh token set with the dedicated versioned credential key;
plaintext tokens remain request-local and are never returned or logged.
Expiring credentials use atomic compare-and-set rotation. Confirmed `401`,
installation deletion/suspension, or `github_app_authorization.revoked`
webhook events deactivate the affected credential or binding. It never
persists or returns the code, client secret, plaintext token, raw provider
response, or authorization header. A replay, tenant change,
provider drift, membership change, or suspended installation fails closed
without a binding. Both GitHub repository selections (`selected` and `all`) are
supported; the live installation identity and per-operation repository
authorization checks remain required.

This route adds the exact hosted environment fields
`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and
`GITHUB_APP_INSTALL_STATE_SECRET`, `GITHUB_APP_USER_TOKEN_KEY`,
`GITHUB_APP_USER_TOKEN_KEY_VERSION`, and `GITHUB_APP_WEBHOOK_SECRET`. The existing `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` remain the separate invited-user sign-in provider.
`GITHUB_TOKEN` and `GITHUB_API_URL` are forbidden ambient overrides. Migration
`0007_github_installation_authorization` owns the digest-only, one-time state
table. The owner-only mise binding remains an operator recovery path; it is not
the public installation flow.

Register the GitHub App under the Autograph organization with the exact slug
`autograph-app-builder`. Use `https://www.autograph.so/` as its public homepage
and configure both its callback URL and setup URL as
`<APP_ORIGIN>/github/installations/callback`. Enable **Redirect on update** so an
existing installation returns to the same state-bound flow after its repository
access changes. Choose either repository selection offered by GitHub and only the
maximum repository permissions exercised by the
operation-scoped installation tokens: metadata read, contents read/write,
workflows read/write, pull requests read/write, administration read/write, and
variables read. The App Builder narrows these permissions again for each
operation and performs no repository mutation during the connection flow.
The connection page offers one **Continue with GitHub** action. When the
requested repository is already accessible, Builder resumes without a GitHub
trip. Otherwise it sends the signed-in user through GitHub App OAuth and binds
the verified installation to the current workspace. GitHub requests installation
or repository selection only when needed. Ambiguous installations fail closed.
The deployment-owned Arrusted starter reader uses a separate fixed installation
ID and mints a token restricted to that one repository with read-only Contents
and Checks permissions. Existing-app source and publication use the tenant-bound
installation and verify the selected repository; the starter reader never
supplies their credential.
For a repository owned by Autograph, these paths may refer to the same
underlying GitHub App installation. The installation's “All repositories”
setting is the outer GitHub grant, not a tenant authorization or the permissions
of every minted token. Each Builder operation still uses its own bounded token
and verifies its tenant, requested repository, and permitted action.

`resolve_repository_access` confirms source-read access with an operation-scoped
token. The source token's Contents read and Pull requests none permissions do
not mean the installation lacks write permissions, and its ready result does
not establish publication capability. Do not request an installation access
update from that read-token observation alone. Once publication is requested
and the workflow is reviewed, `seal_github_draft_pr_proposal` freshly checks the
selected installation and repository with the publication operation's Contents,
Pull requests, and Workflows write permissions. Sealing performs no repository
mutation and does not replace the separate publication approval. Source reads
retain their bounded tokens; provider failures retain the supported connection
and authorization boundaries.

Initial draft publication first prepares a destination review with
`prepare_github_draft_review`. It observes the selected repository's current
default branch and reads immutable preimages only for the intended app change
paths using source-read credentials. The validated private app and its original
source and historical-baseline provenance remain intact. The complete resulting
diff exposes both destination before content and validated after content;
binary artifacts have explicit metadata and content omissions. Read each side's
full paged export with `change_set_status`, then accept the fresh change set.
Preparation invalidates the previous review and sealed proposal while retaining
its mutation journal. A pending or potentially partial prior publication must
be recovered before another destination review.

Sealing binds that same reviewed destination commit and tree. It verifies the
same tenant-selected installation and rebinds a fresh publication permission
proof without advancing the reviewed base. Merely resealing an old review
against a newer branch head cannot repair stale file preimages. The provider
still rejects overlapping upstream changes or changed preimages before writes,
and publication still needs a separate approval for the newly sealed proposal.

Review output pages both change metadata and source content within the native
Eve event frame. Continue each side using its returned `contentCursor`; metadata
pages do not replace full before/after reads. Page boundaries preserve UTF-8
bytes and defer the next complete change when its metadata/content cannot fit
after the current page. Missing text remains unreadable across the entire
cursor chain until that side is restarted. Binary artifacts retain their
metadata and explicit content omission.

Preparation and acceptance return compact current-session references rather
than repeating complete path lists, receipts, walkthroughs, and evidence. Their
authoritative data remains in the authenticated session state. After acceptance,
`change_set_status` with `view: "acceptance"` exposes full receipt and product
evidence as reconstructable JSON chunks through `detailCursor`. References and
cursors never select another session or supply repository authority. Native
frame diagnostics contain only event type, tool name, byte count, and envelope
size. Physical page sizing retains the existing provider ceiling and imposes
no total app/file-size limit.

The separate web handoff provisioning path is gated by
`builder-resource-provisioning`. It journals intent before provider calls,
creates a public or private repository from the exact content-addressed
Arrusted starter as one parentless `main` commit, and verifies the repository
ID, privacy, SHA, tree, and complete blob inventory before reporting success.
Organization creation uses the selected installation token with Administration
write. Personal creation uses the encrypted GitHub App user credential because
`POST /user/repos` does not accept an installation token. This does not change
the five-tool public MCP surface or bypass the later reviewed-change-set
publication gate.

Leave GitHub App **Request user authorization (OAuth) during installation**
disabled for this flow. When enabled, GitHub bypasses the setup URL and starts
its OAuth flow directly, returning a code to the first registered callback URL
without this flow's tenant-bound state. The callback rejects that response before
code exchange or binding rather than accepting an unbound authorization. Multiple
registered callback URLs do not select a tenant callback for that automatic flow;
the configured App Builder callback and setup URL must be the same exact
`<APP_ORIGIN>/github/installations/callback` URL.

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
observed `REPOSITORY_RELEASE_ENABLED` state. A fresh repository must keep the
gate absent. An existing repository may already have the gate configured; draft
pull-request publication carries that exact observation through the sealed
proposal and receipt and must not change it. Immediately before mutation, the
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
an Octokit-backed fixed-`api.github.com` provider. Hosted deployment composition is
enabled only by exact `APP_BUILDER_GITHUB_PUBLICATION_ENABLED=1` together with
an exact matching `VERCEL_ENV` and `EVE_HOSTED_VERCEL_ENVIRONMENT` of either
`preview` or `production`, bounded `DATABASE_URL`, `GITHUB_APP_ID`, and
`GITHUB_APP_PRIVATE_KEY`. `GITHUB_APP_INSTALLATION_ID`, `GITHUB_TOKEN`, and
`GITHUB_API_URL` are forbidden. The installation ID is read live from the exact
issuer/audience/workspace/owner database binding after current and initiating
forwarded authority plus membership are revalidated for the session. Local,
unconfigured, unsupported, service, mismatched, inactive, or ambient authority
remains fail-closed. The provider delegates short-lived App JWT creation and
installation-token minting with the exact permissions for each operation to
`@octokit/app` and `@octokit/auth-app`. The runtime
passes a closed, discriminated, ephemeral content value directly into the
provider mutation: fresh creation receives the complete immutable prepared
source manifest and bytes at `sourceTree`, while draft publication receives
only the reviewed validated-overlay changes. The Octokit provider has no second
material source and verifies modes, blob identities, byte digests, and the
exact Git tree before mutation. Tokens, endpoints, raw responses, raw content,
and raw errors never enter a proposal or receipt. Composition makes the typed
capability available; it does not itself prove a live installation, GitHub
mutation, or provider postcondition.

The permission contract omits the workflows permission for source inspection
and requires `workflows: write` only for fresh-history or reviewed draft-PR
mutation. This is required because a complete supported template can include
approved files under `.github/workflows`; contents permission alone cannot
write those paths.
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
