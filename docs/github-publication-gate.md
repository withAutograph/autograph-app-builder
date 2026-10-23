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
and the app browser task when requested. Candidate commands select the existing
`app-validation` Mise environment alongside other explicitly selected profiles.
This carries the explicit dependency-setup boundary through nested formatter,
compiler, runtime and browser commands: dependencies are prepared by the locked
install step, and child Mise processes inherit that policy.
Independent semantic source review
remains required through the app acceptance workflow. Separately,
`review_github_draft_pr_reconciliation` records a deterministic exact-candidate,
two-parent receipt and returns a bounded metadata summary with honest full counts
and all repository head metadata; it does not perform the independent app source
assessment. Optional `inspect_github_draft_pr_reconciliation` calls with
`kind: "changes"` page the file index, while `kind: "diff"` supports raw byte
cursors/path selection for the resolved diff against the live base and the delta
from the old PR head. Neither pagination must be exhausted. Inspection progress
is not review or publication authority. A separate sealed approval binds both
parent commits, the resolved
tree, both diffs, the draft PR, and the tenant-scoped repository. GitHub receives
a merge commit through an expected-head update without force pushing. A moved
base or head requires a fresh merge, validation, review, and approval.

When only the base advances, preparation carries the same draft's private app
repairs into a fresh candidate through a three-way Git merge against the previous
base. Tracked edits, ordinary untracked app files, and retained release archives
merge with current upstream app changes; overlaps remain normal conflicts.
Shared repository files come from the fresh base merge. The old candidate, its
index and conflict state, and ignored private files remain untouched. No saved
validation, review, or publication approval transfers to the new candidate.

Later revisions retain the latest provider-proved approved reconciliation as
their publication baseline, independently of a new unpublished candidate.
Reuse requires the same owned repository, draft, branch and original publication
receipt, plus provider verification of the applied merge's parents, tree and
commit marker. Candidate replacement preserves that proven proposal, and a
verified successful publication records its successor before optional app-source
recording. An unproved head leaves the original baseline and existing conflict
protection in place; independent edits are still preserved and refused on conflict.

Older successful reconciliations may predate retained proposal state. Builder can
recover their baseline from an existing protected published-source completion
marker under the same tenant, original session and app, after verifying the
original owned draft receipt. The marker must match the provider-observed
repository, branch, commit and tree exactly. This reads retained publication
history; it neither selects a latest release nor accepts a supplied historical
commit. An absent or mismatched marker leaves the original baseline unchanged.

GitHub's PR snapshot may still report an older head after an accepted branch
update. Same-draft recovery obtains the tenant-owned publication and its retained
applied proposal or canonical owner/app/spec-scoped source before that mismatch
can prevent source acquisition. The recovery context stays internal and follows
the same operation through inspection, sealing, mutation and exact-result
read-back; public tools accept no caller-supplied source proof.

Recovery binds the same repository, PR, branch and verified Builder origin to
the existing publication. A marker or commit ancestry alone grants no authority.
A later approved merge proves its exact parent commits, reviewed tree and commit
message against that owned baseline, even when the PR snapshot predates it.
Result recovery runs before recording the new published source, so that record
is not a prerequisite for proving an already accepted write. Live-ref rereads,
expected-OID non-force updates, review and separate effect approval remain
required. An unproved branch advance still leaves the draft untouched.

When the original app review cannot be replayed onto its current owned draft,
`prepare_github_draft_pr_reconciliation` supports the explicit
`recovery: "reopen-current-owned-draft"` mode. Builder verifies the same owned
publication, current draft and live base, then creates a fresh isolated merge
candidate without replaying the ambiguous original overlay or an earlier
candidate. The original starter provenance, apply workspace and earlier private
candidates remain retained. The result identifies the unreplayed original
review and preserved workspaces; those edits are not claimed as part of the new
candidate.

The recovery mode follows subsequent preparation attempts within the same owned
review lineage. Original app-review content remains available through
`change_set_status`; retained draft candidates can be read through the bounded,
read-only preserved-workspace selector on `edit_github_draft_pr_candidate`.
Edits still target only the current candidate. Builder must validate that
candidate, review its new base and prior-head diffs, seal the exact result and
obtain separate outward-effect approval. Reopening is private preparation and
does not replace the accepted source or update GitHub.

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
content with `change_set_status` as needed, then accept the fresh change set.
Preparation invalidates the previous review and sealed proposal while retaining
its mutation journal. A pending or potentially partial prior publication must
be recovered before another destination review.

For a fresh-template app, pass the intended existing repository as
`destination: { repository: "owner/name", selectedInstallationId? }` to
`prepare_github_draft_review`. Preparation uses the ordinary session-owned
GitHub connection flow and observes the actual repository and installation.
A later refresh can reuse that exact retained destination. It never replaces
the starter checkout, creates a repository, or fabricates `githubSource`.
Keep the original source receipt, app files, and validation. An absent
destination is an internal workflow selection to resolve from the intended
delivery target; it is not a reason to restart the app or ask the user to
repair source plumbing.

After accepting the destination diff, fresh-template sealing uses
`expectedDestinationReviewDigest`; acquired GitHub sources retain
`expectedGitHubSourceDigest`. The fresh proposal binds the actual destination
review, source receipt and reviewed changes. Its prepare, seal and publish
operations select the verified tenant-owned installation explicitly, preserve
current membership and provider permission checks, and retain separate
publication approval and mutation reconciliation.

The final independent source review attempt remains advisory. An unavailable
or interrupted assessment is reported as unassessed and does not block private
Preview or publication, require another technical validation, or authorize a
replacement app. See [Product source review](product-source-review.md).

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
