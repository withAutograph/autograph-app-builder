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
Builder origin marker in the PR body and current head commit. The PR-body
marker is a standalone HTML comment within the description; normal evidence
text and whitespace do not change its meaning. Identical repeated markers are
accepted, while distinct conflicting markers leave the origin unverified.
These comments still require the configured App's bot author, matching Builder
branch and full marker in the current head commit. It then writes one immutable
adoption record in `hosted_github_draft_adoption`, keyed by the
tenant and exact repository and PR IDs. Each later Builder update commit
preserves the origin marker so subsequent reads keep that commit-level proof.
The sealed proposal still binds the current head and exact reviewed app-owned
diff; a separate approval and GitHub atomic expected-OID update are required.
If GitHub provenance cannot be verified, Builder reports that reason and leaves
the PR branch untouched.

An isolated existing-app draft retains the complete original reviewed workflow
as private lineage. Authoring and technical validation can use that lineage if
creation-workspace validation later loses its current review, provided the
original app, apply, selected-source, repository, proposal, identity and workspace bindings still
match. A different current review supersedes the retained lineage. The retained
review does not assess edited candidate bytes or authorize their publication:
the actual candidate still needs its own validation, diff review and exact
publication approval.

An ordinary no-edit validation of a currently owned draft selects the existing
candidate validation service before changing creation-workspace state. Its
result describes the candidate's actual source; creation-workspace results do
not establish that separately authored candidate's correctness. Explicit
creation repairs remain creation-workspace operations.

Legacy recovery may recover a missing complete lineage only from the original
owner-authenticated native session history at the supported recovery boundary.
Compact review summaries and unverified proposal metadata cannot reconstruct
it. Recovery preserves the latest draft and its edits, does not roll back the
current workflow, and grants no permission to replay an external effect.
For a starter-created app's owned published draft, the retained full review
must match the current starter/apply/workspace and the verified publication
origin of the same candidate. A later recovery may look into predecessor native
executions only through the committed, owner-authorized public recovery receipt
chain. It checks each owner's original checkpoint boundary and orders records
within that execution; event slots from different executions are not comparable.
A newer conflicting or incomplete review cannot be bypassed by searching for
an older favorable one. If the full original review or candidate is unavailable,
recovery retains the existing state and reports the limitation.
For an already waiting hosted session, an explicit owner `recover-idle` request
reaches that boundary through the existing native recovery reservation and
receipt. Normal resume keeps the healthy handle and does not reconstruct
history. Idle recovery must independently prove a closed, unchanged native
inbox wait before stopping the old owner; it cannot recover a pending approval
or treat missing approval evidence as consent.

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
install step, and child Mise processes inherit that policy. Each coherent candidate
validation pass starts with the fixed cached `bun install --frozen-lockfile` operation
in that candidate's root. Builder first unlinks only that candidate's borrowed
checkout dependency-view roots; it preserves candidate-owned installations and
never installs through those links into the original checkout or shared cache.
Saved validation runs without a successful locked-install acknowledgement insert
this setup before their pending check, preserving acknowledged schema compilation
and historical command evidence. Installation failure stays pending with its real
cause. Normal source edits can start a new pass using the same package-manager
cache and installed candidate files; they do not rebuild a sandbox or dependency
closure. Actual checks and fresh source review remain required after setup.
Candidate local-runtime preparation uses the same owner-bound durable log capture
as app checks and tests. `get_validation_log` discovery identifies these attempts
as `local-preparation`, retaining their exact candidate and invocation identity,
exit status, capture completion and durability across later edits or sandbox
cleanup. A successful preparation is `prepared`; it does not prove an app check
passed. Sanitized log references remain session-scoped. Missing storage or an
interrupted command stays explicit and never changes the command's outcome.
The candidate-bound `normalize_github_draft_pr_dependency_catalog` operation
aligns one dependency already declared by the selected app with a shared Bun
catalog without selecting a new version. It verifies compatible existing
consumers before writing, retains unrelated manifest data, and uses pinned Bun
with install scripts disabled to generate lock metadata. Its server-retained
receipt binds exact changed metadata bytes and the resulting non-app index.
Normal candidate review includes those shared metadata paths; arbitrary shared
edits, changed receipt bytes, symlinks and unrelated root edits remain denied.
The original automatic-merge receipt remains provenance, never substituted by
caller-provided catalog authority. Successful normalization is not validation,
publication, deployment, or hosted acceptance. A failed lock operation retains
its metadata result and failure so the same candidate can retry normally.
Additional repository checks stream through detached execution into the same
durable, tenant-bound validation log store as app tests. Their `additional-check`
references remain discoverable and pageable after a later repair; a failed
manifest command no longer loses its output through whole-result truncation.

Independent semantic source review
remains required through the app acceptance workflow. Separately,
`review_github_draft_pr_reconciliation` records a deterministic exact-candidate,
two-parent receipt and returns a bounded metadata summary with honest full counts
and all repository head metadata; it does not perform the independent app source
assessment. Optional `inspect_github_draft_pr_reconciliation` calls with
`kind: "changes"` page the file index, while `kind: "diff"` supports raw byte
cursors/path selection for the resolved diff against the live base and the delta
from the old PR head. Neither pagination must be exhausted. Inspection progress
is not review or publication authority. Use the review's returned `nextCall` to
seal that exact candidate. A separate approval binds both parent commits, the
resolved tree, both diffs, the draft PR, and the tenant-scoped repository.
GitHub receives a merge commit through an expected-head update without force
pushing. A moved base or head requires a fresh merge, validation, review, and
approval.

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
When recovery verifies an already applied result for the still-current approved
candidate, Builder retains the recovered reconciliation for Ready and merge.
Recovery records the existing publication without a second GitHub update.

When the original app review cannot be replayed onto its current owned draft,
`prepare_github_draft_pr_reconciliation` supports the explicit
`recovery: "reopen-current-owned-draft"` mode. Builder verifies the same owned
publication, current draft and live base, then creates a fresh isolated merge
candidate without replaying the ambiguous original overlay or an earlier
candidate. The original starter provenance, apply workspace and earlier private
candidates remain retained. The result identifies the unreplayed original
review and preserved workspaces; those edits are not claimed as part of the new
candidate. A prior candidate of the same owned publication remains available for
inspection even when the newly completed review has a different digest; that
retention does not authorize replaying its edits or its prior review.

If the first owned draft omitted the new app manifest, use
`restoreInitialAppSource: true` in the same reconciliation tool. Builder reads
the retained app and its registration changes against the original starter.
For a draft in the starter repository, Builder verifies the recorded starter
commit and tree in Git and reads registration preimages there. Other repositories
use the prepared starter manifest. Builder stages the exact app bytes and checks
shared registration preimages before its private merge with the current base.
If the restored app conflicts with the current Bun lockfile, Builder regenerates
it from the merged workspace and the current base lockfile. Unresolved shared
source conflicts report the conflicting path. The resulting draft
candidate still needs its normal build, review, and approved update.

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
Follow the accepted review's `nextCall` to seal its current-session review
reference. Builder resolves the source and destination from that same saved
review and rechecks the exact candidate. Follow the seal's returned publication
call through the existing approval flow.
Preparation invalidates the previous review and sealed proposal while retaining
its mutation journal. For an acquired existing repository, Builder also retains
the sealed lookup context in the original logical session, independently of the
current review or compiled-source association. After a re-plan, Builder uses it
to verify the canonical publication journal and GitHub. An open PR continues in
the same draft. An owned merge into the current default branch supports a new
app-only revision. A pending or potentially partial prior publication must be
recovered before another destination review. A seal alone grants no authority.

If GitHub accepted a draft but Builder could not record its source association,
follow the returned `recoverAppliedPublication` call. It reads the exact
successful journal receipt and retries only the association. It cannot dispatch
a GitHub write or use a different app, session or revision. Managed Production
setup still verifies the published source before applying its effects.
A starter-created app's first destination review includes its complete
app-owned source even when its latest repair diff contains only a few files.
For a selected existing Arrusted repository, Builder verifies that the app is
absent from the destination and prepares its registration and dependency changes
against the observed default branch. It adds the selected app to the live
workspace, route catalog and lockfile. Unrelated apps added after the starter
was acquired stay in the resulting composition. The selected app and the
resulting shared-file changes are part of the same review and approval.

A saved new app may have acquired its delivery repository as its source. The
same `prepare_github_draft_review` flow can recover its first publication.
Builder retains the saved app, private workspace, original source receipt and
destination. It verifies the app was absent at the acquired source commit and
tree and is still absent on the destination's observed default branch. It then
reviews the complete app and the repository-produced root registration needed
by that app, including the workspace lockfile and route registration when they
changed. When the saved build selected concrete framework versions, Builder
applies those versions to the destination's catalog and shows the shared
upgrade in the same review. That scope comes from the verified first creation,
accepted build plan and repository output. Revisions to an app already present
in the destination use the existing-app review scope. The creator accepts the
current destination diff and approves the sealed publication through Builder.

An app-only correction to that first draft retains its approved registration.
Builder verifies the original proposal, successful publication, and current
draft head before carrying the registration into the private merge candidate.
The repository's automatic merge supplies the non-app files. Builder checks
that those files stay unchanged while reviewing the correction and binds the
update approval to the current draft and resolved tree.

If retained workspace metadata is missing after recovery, Builder reconstructs
that original manifest from the saved source commit's Git blobs and verifies it
against the existing source tree and workspace digest. It restores only the
manifest and checksum metadata, never the app, checkout or index. App-authored
changes therefore remain intact, and metadata loss does not require another
Build approval. If the original objects cannot establish the saved baseline,
Builder preserves the app and session and reports a service recovery issue;
the changed working tree is never substituted as the original baseline.
Fresh canonical clone receipts retain a digest of the original commit and tree
instead of the file list. Their manifests are derived and verified against that
exact Git tree and its blob bytes, including existing manifests and checksums;
the saved source identity and workspace receipt are not rewritten. Full-list
receipts continue requiring their original exact manifest digest.
Restoration publishes missing metadata exclusively. If another preparation has
already restored or refreshed it, recovery preserves that result and validates
the winning manifest against the saved source binding instead of replacing it.

After an owned app's PR merges or closes, Builder can prepare its next PR in
the same session and private workspace. A retained publication digest is enough
to look up the canonical proposal and successful receipt in the current owner's
tenant journal, including after ordinary repair and validation removed the old
review and seal. Approved repair history remains an optional source of lookup
context; it is not required to rebuild a reviewed workflow. Builder verifies the
publication's app paths, repository and selected installation and reads the actual
owned PR through GitHub. An open PR keeps its existing update or reconciliation
workflow. Missing, pending, foreign or unavailable publication evidence never
authorizes a replacement PR.

For a verified owned open draft, `prepare_github_draft_review` returns a
same-draft continuation instead of preparing a new-PR destination snapshot. A
validated correction first uses `accept_change_set` to review its current app
delta; that internal review does not require an initial destination review.
The returned `afterReview` then uses normal
`prepare_github_draft_pr_reconciliation` with the PR number from the canonical
successful publication receipt and no reopen/recovery flag. An already-reviewed
correction goes directly to that step only when its current normalized change
set still matches the reviewed subject. A retained `reviewed` phase alone does
not establish that later app or test edits have been reviewed. The original app, source, workspace,
validation and publication marker stay intact. This routing observation grants
no update consent: the existing owned-head/base preparation, current-byte
validation, candidate review and separate exact publication approval still
apply. A generic provider error cannot supply this continuation; cancellation,
concurrent workflow changes and uncertain publication remain failures.

Normal reconciliation checks the same current app-review subject after proving
the owned publication and before acquiring a merge candidate. If the current
bytes differ, it returns `review_refresh_required` with the ordinary
`accept_change_set` continuation for the same PR. Current app files and prior
private candidates stay intact. At that owned boundary, the obsolete initial
destination snapshot, review and seal are retired; the verified publication
marker and original validation evidence are retained unchanged in scope. The
ordinary `validated` continuation lets Builder review the current app delta;
it does not turn the old commands into validation of edited bytes. The new
candidate still runs its own current-byte validation before any update.
Refreshing review grants no publication consent
and introduces no new Build approval. A concurrent observed review mismatch is
kept distinct from unavailable or missing source bytes, so Builder does not ask
the creator to recreate a file that is still present. Unknown source-read
failures retain their existing recovery. Candidate validation and the later
exact reviewed update approval remain required.

A closed or merged PR authorizes only a new review against the current default
branch. Its historic head and base can have changed without transferring any
approval: this path never writes the retired PR. Active draft updates, Ready and
merge retain their existing exact revision and approval checks. No Git ancestry
or old branch snapshot is deployment authority.

For a PR merged into the current default branch, candidate paths include the
original publication's app paths, current app files and app-owned changes retained from completed private
iterations. This preserves additions, deletions and earlier unpublished changes
without republishing other apps, platform files or the original registration.
The current destination preimages and private bytes decide the actual new diff;
unchanged or reverted paths add no publication change. This app-only path does
not need the original starter manifest. For a PR closed without merging, or
merged into another branch, Builder uses normal full-app preparation, including registration changes that may not yet
exist on the destination branch.

A verified fresh publication records its canonical proposal as the saved app's
current published subject after the same owner and exact workflow are rechecked.
Older draft candidates and their private edits remain historical work; they do
not replace this new publication. If an older session lacks that marker, repair
may inspect its exact current seal in the tenant journal before reusing an older
origin. Only the canonical successful publication and the requested owned PR's
verified repository, installation and head complete recovery. A recorded pending,
failed, foreign or unavailable outcome proves nothing, while a genuinely
unpublished new seal still permits recovery of its existing older draft.

A sealed-only proposal with no publication journal remains an initial
publication and retains full-app completeness. An optional legacy publication
marker neither proves a merge nor replaces the journal; a contradictory marker
is never silently replaced. The new review reads current immutable destination
preimages and invalidates the old acceptance, seal and active draft-update
binding only after the owned PR is verified closed or merged. Historical lineage
remains intact. The creator must accept and approve the newly sealed publication
through Builder. The original source,
private edits, workspace and app resources remain intact. A merged PR is used
only as prior authoring provenance here; native deployment activation remains
provider-owned.

Builder reuses the saved app's recorded repository. When a new app still needs
a destination, `prepare_github_draft_review` returns the same saved build's
destination setup at `/builds/<session-id>/destination`. Use that setup to choose
where to store and release the app, then resume the saved build. Publication
retains its separate approval.

For a new app using the canonical `fresh-template` starter, a repository the
user explicitly chose is its delivery destination. Pass it as
`destination: { repository: "owner/name", selectedInstallationId? }`.
Preparation observes the actual repository and installation through the ordinary
session-owned GitHub connection. The creator may supply a GitHub repository URL or
`owner/name`; Builder resolves its connected installation and numeric repository
identity. It saves that selection in the private session’s `builderDestination`
metadata before preparing review, independently of the acquired starter source.
The saved destination page offers the same existing-repository selection even
when creating new repositories/projects is disabled. Selecting an existing
repository does not create a repository or Vercel project and needs no per-app
resource-provisioning journal. Existing journal-backed destination records remain
supported. A later refresh or recovered child session retains the same selection;
normal GitHub access is checked again before publication. Selection grants no
publication or merge approval.
The authenticated current build may save this metadata while its ordinary SEND
has a durable acknowledgement, or while its approved automatic Build continuation
has claimed the exact executing turn. Both paths retain the current owner,
adapter generation, cancellation revision and checkpoint fences. The automatic
path also binds the captured approved app scope and dispatch epoch. Saving a
destination does not settle, replay or approve a pending operation. Unknown
operations without that delivery binding, recovery transfers and unrelated
mutations still block attachment. The web destination action continues to require
settled session operations.
Keep the starter checkout, original source receipt, app files and validation.

After accepting the destination diff, fresh-template sealing uses
`expectedDestinationReviewDigest`; acquired GitHub sources retain
`expectedGitHubSourceDigest`. The fresh proposal binds the actual destination
review, source receipt and reviewed changes. Its prepare, seal and publish
operations select the verified tenant-owned installation explicitly, preserve
current membership and provider permission checks, and retain separate
publication approval and mutation reconciliation.

Independent source review is optional and advisory. An unavailable
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

For a new private Arrusted app with an explicit direct Production request,
Builder can collect a single owner-approved grant for Build, reviewed draft
publication, managed Production setup, and reviewed Ready/merge. The grant
binds the accepted product plan, workspace and creator, verified GitHub
repository, installation and default branch, and whether the app needs managed
storage. A private Build that later receives a Production request uses one
release approval with the same scope. A private-only Build grants no outward
authority.

For an existing starter-backed plan, `release-app-production` accepts the
creator's chosen Arrusted repository as `destination`. Builder verifies the
connected GitHub account through the same repository-access flow and records
the selection against the current private plan. The starter checkout and
accepted app stay in the same session. The ordinary draft review rechecks and
persists that exact repository, installation and default branch as the app's
destination before publication. Protected setup then checks that saved
destination and the reviewed source against the original owner approval.

Each effect retains its own exact current reviewed inputs and operation
journal. The draft writer checks the sealed candidate, the protected operator
verifies the original approval and current setup plan, and the merge workflow
checks the reviewed GitHub head and required checks. Moving or changing a
reviewed revision invalidates stale authority for that revision. Changes to the
approved app, destination, access or storage need a new decision. Activation
stays with Vercel.

Repository creation and draft-PR publication outside the scoped Arrusted
release use separate approvals. Each
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

Ordinary same-app Build planning and apply retain the explicit published-proposal marker
while giving its new private source changes their own Build, validation and review.
If an older planning projection lost that marker, Builder may recover only the
lookup for the original owned publication from a canonical retained repair and
its original reviewed lineage. The current accepted app, specification, source
and workspace must still match, and current session-scoped repository access
must match that origin's repository and installation. Builder re-reads the tenant's
original successful publication, recorded app source and live owned PR through
the normal recovery path before recording the recovered marker. It preserves the
new private proposal, applied changes and review; the old review grants no update
approval. A contradictory explicit marker is never replaced by this recovery.

## Reviewed pull request delivery

`read_github_pr_delivery` reads the current PR from the session's owned draft
publication receipt. Candidate validation may leave the creation workflow outside
its reviewed phase; delivery then resolves the original review through the same
verified app, specification, source, apply and workspace lineage used by draft
reconciliation. It retains the original publication digest and selected GitHub
installation, preserves private candidate edits, and still reads the published
reconciliation from GitHub before offering or accepting its exact Ready approval.
A private sealed proposal is not publication proof. An open draft defers
validation. On a ready Arrusted PR,
the required evidence is a successful canonical `Check` job for the published
head and current ready cycle. Builder reads the repository's result without
repeating affected-code selection. A moved revision is visible but cannot use
the original review for merge. For a published reconciliation, Builder
checks the retained approved reconciliation against GitHub's current commit
before offering a new delivery approval for that head. The Ready cycle and
required Check then bind to that reconciled head. After merge, Builder can
verify the retained commit from the closed, merged PR even if GitHub deleted
its source branch. The status read continues to inspect the same exact-head,
Ready-cycle `Check` after merge, so a successful merge does not reset its display
to pending. Merge state alone never establishes a passing check; failed or
unavailable check evidence remains nonpassing.

When hosted GitHub publication is enabled, an eligible reviewed publication
can return an input for `finish-github-pr-delivery`. Operators can explicitly
disable Ready and merge with `APP_BUILDER_GITHUB_PR_DELIVERY_ENABLED=0`. This is a separate native
approval to mark the PR ready and merge the reviewed revision when required
checks pass. Eve binds the approval to the current session's tool call. Builder
checks that session's reviewed proposal before requesting approval and rechecks
the authorized repository and revision in the delivery step.

The ordinary parent records a small server-owned delivery projection at the
approval boundary and when its reviewed publication changes. It retains the
app/AppSpec, review, publication/reconciliation and installation identities,
known managed Production requirements, and the exact invocation's input digest,
owner, generation and Stop revision. These are scope facts, not a separate human
approval. At first capture, canonical owner authentication does not depend on an
older delivery projection. Builder can refresh an absent projection or one bound
to a replaced adapter only when the parent's actual retained Build grant matches
the current app, AppSpec, internal Build proposal, logical session and workspace.
It rechecks that approved scope across capture and persistence, verifies the
durable current call and review, and rejects any concurrent owner change before
offering Ready approval. A decision label, retained review or setup approval
cannot substitute for the Build grant. Closed diagnostics distinguish missing or
mismatched projections, owner changes and captured-scope failures without logging
private identities or credentials. Durable child workflow steps re-read the
current canonical owner and projection instead of reading child-local Builder
state. A changed publication,
owner or cancelled execution cannot reuse the old call. The native cancellation
hook retires that turn's calls durably, including local Stop/resume; an unrelated
failed or blocked step does not retire approval. Missing previously
managed setup remains blocked by the existing Production check. One approved
workflow covers Ready, waiting for Check and merge, including a PR already Ready.
After a confirmed managed merge, the workflow follows native Production
availability with a read of the same owned app and destination. The merge
approval ends at merge. Provider activation proceeds independently, and a
currently available app can be opened while delivery of the latest update
remains unconfirmed. A saved session can check its app again through
`observe-app-production` using current owner access. That standalone check
returns the current result, including pending, after one observation. Pending
availability leaves the normal draft and Ready/merge flow available. Old finished
calls are not migrated or resurrected by this recovery.

An owned open PR that has already become Ready can be corrected through the same
private preparation, validation, review and approved update flow. Builder proves
its canonical tenant publication, current repository/PR/branch/head and origin;
an adopted draft alone does not authorize changing a Ready PR. The server seals
`returnToDraft: true` into that exact update or reconciliation proposal and its
approval receipt. The ordinary update approval plainly covers returning that
Ready PR to draft and publishing the reviewed correction; omitting or altering
the transition invalidates the receipt. Older proposals remain draft-only.
After approval, Builder uses GitHub's native draft conversion with the verified
PR node ID, reads back the same owned head as a draft, then applies the existing
expected-head update. A lost conversion response is reconciled by that readback;
an interrupted same-head conversion resumes without another conversion. A moved,
closed or foreign PR cannot receive the correction. The cancelled delivery call
stays cancelled, and the revised publication needs its own Ready/merge approval
and required checks. No GitHub action or database details are delegated to the
creator, and no deployment or app-test gate is added.

The GitHub App installation needs Actions read, Pull requests write for Ready, and
Contents write for both Ready and merge. The provider requests a repository-scoped token
attenuated for each operation. GitHub applies its own review and merge policy.

Apply the additive PR effect journal migration to Builder’s hosted storage
as part of normal deployment. The journal claims each approved effect before sending a write. After
an uncertain response, the same operation can observe provider evidence and
settle its receipt. A fresh approval can recover an older, unconfirmed first
Ready attempt made with the previous read-only Contents token. Builder preserves
the older receipt, checks that the exact PR is still a draft with no Ready event,
and journals one attempt with the corrected token. GitHub's merge
request guards the expected head atomically. Base and ready-cycle changes are
checked around the request. A merge result and protected hosted app evidence
remain separate facts.

For an existing repository with native Production delivery, the approved merge
hands off to the repository's native deploy integration. The PR effect journal
records GitHub writes in Builder's own storage. This flow has no dependency on
a Preview app, a managed runtime journal, or synthetic app data. Actual runtime
bindings are owned by the destination's Production setup. GitHub merge evidence
and the provider's deployment result are reported separately.

The initial proposal sealer returns its canonical `approvalReceipt` as reviewed
subject metadata. Builder passes that receipt unchanged to
`publish_github_draft_pr` to present Eve's ordinary approval control. Calling the
tool does not publish before the user approves, and the receipt itself grants
no consent. No separate approval-request tool or creator-supplied receipt is
required. A recovered session can read `artifact_workflow_status` to recover
`githubDraftPublication.nextCall` for its retained exact sealed draft, including
older seals whose tool result did not include the receipt. This read checks the
saved source, destination and reviewed change-set bindings without resealing,
opening a Sandbox, or calling GitHub. A stale binding omits only the publication
input; ordinary status metadata remains readable. Cross-session artifact checks
still reject the read. It returns subject metadata, not consent
or a claim about whether publication has occurred. The normal publication or
recovery flow and native approval still apply. Denial and a changed sealed
proposal continue to prevent publication.

### Correcting an owned app's original composition

A fresh-template app can correct its own published draft through
`prepare_github_draft_pr_reconciliation` with `repairOriginalPublication`.
Builder selects unwanted original additions from that draft's diff; the creator
supplies product feedback, not repository paths or manual commands. This is a
private preparation operation, not publication or approval.

The original tenant-scoped proposal, successful publication, app/spec ownership,
repository, current head and base remain verified. Each selected deletion must
have been added by that exact original publication, remain byte- and mode-identical
in the current draft, and be absent from both its original base and the current
target base. App directories cannot be selected. Unknown or newer head changes
are preserved and reported rather than overwritten.

Builder creates a new private candidate, restores only the proven original delta,
and performs the native app merge. It reconstructs workspace and catalog entries
for the selected app and plans its route registration against the current target's
composition. Lock generation starts from that target's lock with install scripts
disabled. Unrelated app registrations, workspaces and existing catalog versions
stay intact. Previous candidates remain available, and verified private app edits
are replayed before generating matching metadata. The resulting platform-produced
non-app index is bound into the existing reconciliation scope. Generic candidate
editors still cannot write arbitrary shared or root files. The corrected diff
requires normal review, exact update approval and provider readback; a changed
revision cannot reuse an old approval.

Draft validation runs the selected repository build and declared app tests.
Prepare the candidate's local Preview runtime only when a selected browser
check needs it. A direct Production repair does not require Preview setup,
and an unselected Preview step from an earlier attempt does not block the
required checks.
