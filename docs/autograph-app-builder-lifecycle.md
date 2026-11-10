# Autograph App Builder lifecycle

Autograph App Builder takes a brief through a working preview or the requested
delivery. The [complete app authoring contract](full-app-authoring.md) defines
the Build decision, implementation, review, and delivery.

## The user-facing flow

### 1. Understand the brief

The builder identifies the job to be done, the people involved, the desired
outcome, and any explicit constraints.

### 2. Choose safe defaults

It infers a concise app name, app ID, initial interface pattern, navigation,
roles, and provisional behavior. Explicit choices are preserved. The builder
asks a question only for a material ambiguity, unsupported identity, or real
collision.

### 3. Create a component-backed UI preview

It prepares the exact Arrusted source, inspects public components and
compositions plus their real production consumers, and creates a fixture-backed
React UI in a disposable overlay. Navigation, controls, actions, first-use,
empty, loading, and error states work without APIs, persistence, or backend
implementation.

### 4. Refine the design and prepare the plan

Builder incorporates feedback and infers safe defaults for behavior, roles,
persistence, and failure handling. It prepares the implementation proposal as
part of the same conversation. It asks only about material product decisions.

The implementation handoffs from planning and automatic design acceptance include
`implementationRouting.routes` copied verbatim from the saved proposal's
`plan.topology.routes`, including when a plan is reused. Catalog ownership
preserves those public paths; the app router must serve them, including navigation
and redirect destinations. This is authoring context, not a selected launch path,
prescribed source layout, new approval, or additional validation requirement. The
projection preserves the accepted product, scope, artifacts, and saved plan.

### 5. Ask once to build

Builder shows the initial design and proposed scope and asks **Build this app?**
That decision starts implementation and covers in-scope setup, preview, checks,
and repairs. External effects retain their own approvals.

### 6. Run and review the app

Builder implements the agreed changes and starts the applied app directly.
It diagnoses startup failures and repairs the same app. Technical validation
and independent review establish a reviewed result separately from startup. When GitHub storage is selected, the repository can be public
or private according to the user's selection. Builder asks before taking an action that needs separate authorization.

Validation runs against the selected applied checkout. Ordinary changes in the
separate host source become input to the next plan. When planning observes no
source change, keep the current workspace without loading native transport
history. When reconciling changed source, use the owned transport evidence
needed to preserve the app's edits and bind the actual workspace.

Ordinary build validation skips authenticated browser preparation and browser
tasks. Builder can opt into a declared app browser task with `runBrowserTests`
when that task serves the app’s testing needs.

The current `runBrowserTests` selection also applies when resuming an owned
draft candidate. False or omitted selection removes only the pending,
tool-owned browser step for that same app; completed required checks remain
valid for unchanged candidate bytes. An explicit selection can add the browser
step before capture. A selected browser failure remains failed in its separate
command history and logs. Later opting out does not record a browser pass or
reuse a sealed candidate approval; the remaining required checks and release
capture must succeed before the current candidate becomes reviewable.

With no implementation files, ordinary validation selects the current owned
draft candidate when one is available. Its successful result continues to that
candidate's review, which reobserves the checked tree before recording the
current diff. It does not validate or review different files in the original
creation checkout. If owned-publication inspection finds that the creation
review is stale while that checkout lacks completed validation, Builder returns
an internal `validationTarget: "creation-workspace"` continuation. That selection
runs the existing repository checks against the actual creation checkout,
without selecting the draft candidate again. Passing those checks permits a
fresh current-app review and continuation of the same owned draft. The two
validation receipts remain separate; neither a retained old review nor a passed
candidate authorizes an update of different bytes. Current review and exact
publication approval remain required. Builder owns this selection; creators do
not choose source workspaces or repeat Build approval for it.

Repairs to that isolated candidate can add app-owned text files through
`edit_github_draft_pr_candidate` with `kind: "create"`, `path`, and `content`.
Creation is limited to the selected app and requires an absent path; it cannot
overwrite a file or write through a symlink. Builder preserves the same owned
publication, source review and candidate across preparation, and checks current
session state and cancellation before writing. A successful creation invalidates
the candidate's previous validation, review and sealed update proposal while
preserving its other files and publication history. A known refusal before the
write retains those proofs. A completed write retires them even if cancellation
then interrupts the response. An unresolved write outcome also retires old proof
for that same candidate and is reported for reconciliation, without an automatic
retry. Validate the complete updated candidate, review its base and prior-head
diffs, and use the ordinary exact update approval before GitHub changes.

When draft reconciliation selects an app-owned browser task, Builder runs it
against the candidate's own prepared runtime or ordinary frontend server. The
session's optional working preview cannot supply its launch authority or origin
to that candidate. Protected runtime resolution and refusal remain authoritative
before dispatch; local candidates require their own readable localhost Auth
origin, while frontend candidates may have no local Auth binding. Selected test
failures and cancellations remain failures. Ordinary and prior-artifact private
previews retain their owner, app, source, lifetime, origin and recording
protections. This internal target creates no creator input or prepared-Preview
requirement.

For requested GitHub delivery, passing repository build and declared app tests
produce a technically validated, reviewable candidate. The tool keeps that
technical result successful when an optional private browser check fails or is
unavailable, retaining the separate browser failure and unverified acceptance.
Builder continues normal destination review and native draft-publication approval
before optional browser qualification. This saves reviewable work without claiming
the app is usable, Ready, merged or deployed. Actual build or test command failure
still requires repair, and exact reviewed-source approvals and required CI remain
in force.

A saved starter checkout adopts a needed shared test-tool repair through the
ordinary open owned draft's current-base reconciliation and candidate validation.
The original app edits, session, destination and resources remain retained. Builder
performs that continuation and reruns the affected app-owned behavior checks; an
outside evaluator neither drives internal stages nor hot-patches shared source.

Before the first draft, a saved fresh-template app can also need a shared
repository repair. After an actual failed local setup command, Builder may
reconcile its owned checkout with the current canonical foundation and retry
that command once when the foundation changed. The transition checkpoints the
original bytes and preserves the same app, authored changes, runtime data and
accepted Build authority. It records the new source facts and recomputes the
validation and review evidence affected by them. This is failure recovery, not
a requirement to refresh every app or a minimum-version admission check. An
unchanged foundation or another failed command remains a failure. The selected
canonical transition is frozen before mutation and authenticated server-side
using the existing repository-reader credential; editable Sandbox metadata
cannot choose another source or obtain that credential. Interrupted transitions
reuse that selection. A changed signing credential cannot silently authorize an
old or substituted transition; Builder retains the app and reports recovery as
unavailable instead.

Browser and continuity check progress reflects the returned check outcome,
not merely completion of the tool call. A failed, cancelled, missing or
unassessed check outcome is never a pass. Successful technical validation
does not establish product acceptance when that acceptance remains unassessed.
Private browser failures retain the test location and bounded allowlisted
access stage or failure category when available. Builder uses those facts to
distinguish access setup, browser launch, navigation, assertion and timeout
repairs. Unknown diagnostics remain unclassified; they do not justify weaker
authorization or changed test expectations. Private traces, page contents,
credential values and raw protected browser errors remain withheld.

Private preview and browser checks can use the retained validated artifact
while a draft remains unapplied. Keep the selected app, owner, workspace and
artifact identity bound to that action. When identifying retained source for a
private preview, compare its paths and content. Ignore permission-only
differences. Use the actual launch and dependency command results to diagnose
failures. An absent cache marker or an unapproved draft alone must never
require a new Build. A pending or uncertain write still needs reconciliation
where it affects the checkout being used. Preview creates no release authority
and never carries a prior approval into a new apply or provider effect.

For a failed private apply, Builder names the failed repository command and
exit status, includes sanitized compiler or command diagnostics, and gives a
repair or retry instruction. If the response cannot carry all diagnostics,
preserve the complete sanitized output in retrievable storage and provide an
excerpt with a continuation reference; never discard the only copy. Follow the
[Builder workload capacity policy](builder-workload-capacity-policy.md).
For delivery, Builder uses the selected checkout's native build runner and its
output verification, including on older checkouts. It compiles the schema
before the build when that validation pass has not already compiled it.
Application tests run separately and lint remains advisory. The validation
receipt records the command that ran.
For hosted app checks, each stdout and stderr channel is sanitized while it is
streamed to tenant and session scoped immutable chunks. A validation receipt
contains each channel's log ID, SHA-256 digest, byte length, and chunk count.
`get_validation_log` reads one authenticated page at a time using the exact
attempt digest, command, channel, log ID, digest, and returned cursor. The
caller verifies the assembled UTF-8 bytes against the digest. A filtered
repair excerpt marks `truncated` whenever it omits nonempty output or matching
lines that exceed its per-response budget. Sandbox cleanup leaves the durable
log readable until the durable session itself is removed by retention or
tenant deletion.
Dependency recovery uses the same streaming writer and authenticated reader.
The existing dependency probe precedes `bun install --frozen-lockfile`; a live
checkout with dependencies is reused. Each execution gets a digest bound to
its checkout identity, command, session and unique execution attempt. Before
surfacing failure, Builder saves both channel references, exit status, a bounded
sanitized excerpt and its truncation indicator in workflow state. Recover these
with `get_validation_log` using `operation: dependency-attempts` and page each
`dependency-probe` or `dependency-install` channel after compute cleanup.
Normal exit, including nonzero exit, publishes complete sanitized logs. The
optional `completion` metadata distinguishes complete capture, interruption,
and an unavailable durable suffix; legacy manifests retain their old shape
and read as complete. Page `complete` means only that paging ended. Storage
failure leaves the install running, continues bounded sanitized draining, and
reports unavailable durability while retaining any publishable acknowledged
prefix. Builder never repeats a successful install to repair logging. Persisted
byte lengths use SQL bigint; source content and dependency command contracts
remain unchanged.
Checkout-backed execution readiness uses the prepared checkout and its hosted
sandbox binding; absence of
an obsolete offline dependency cache is not an image-configuration failure.
Schema release compilation may follow an initial validation pass. It clears
that pass before changing the private checkout so normal app checks run again
against the compiled result before review.

### 7. Authorize consequential effects separately

Writing changes to an external repository, opening a pull request, publishing,
deploying, changing providers, or creating external resources each requires
authorization for that specific outcome. Approval for one outcome does not
authorize another.

## Durable session behavior

Every build is a tenant-scoped durable session that remains resumable until it
is explicitly deleted:

- `autograph_start` begins a build, redeems an opaque web handoff, or resumes a
  selected durable session.
- `autograph_get` lists recent sessions when no ID is supplied and reads new
  progress and evidence when a session ID is supplied.
- `autograph_respond` answers the complete current batch of input requests.
- `autograph_send` sends an unrelated follow-up while the session is waiting.
- `autograph_cancel` requests cooperative cancellation.

`waiting` means the current turn has settled and the session can continue.
`input_required` means the exact outstanding request must be answered first.
Cancellation is complete only after a public event proves the resulting state.
User-facing sessions remain discoverable until explicitly deleted; compute and
active-turn leases remain short-lived implementation boundaries.

## What counts as completion

Use the result the user requested to determine completion. A working preview
requires the applied app to start and return a usable page. Review describes
the checks and behavior actually exercised. A release requires the working app
at the selected destination after the approved effects. A revision delivers
the requested change to the same app and preserves unaffected content, data,
and destination.

The default delivery path is a single live app with an internet-reachable
Production domain. Builder validates the app privately, then prepares the
approved destination and delivers the reviewed revision through native Git
delivery. The owner starts with authorized access to the live app. Invitations
and role changes update access to that same URL, deployment and data.

Hosted Preview and synthetic acceptance runs are optional engineering tools.
Neither is a prerequisite for initial release. Release preparation verifies
the actual target and provisions its required database, schema, restricted
runtime credentials, and owner access through the protected operator.
Builder derives database details from its managed configuration. After
provider-owned activation, verify the owner's authenticated workflow on
the live app. For persistent apps, save an authorized record and read it
back independently. Record delivery and behavior as separate outcomes.

See [public app release](public-app-release.md) for the target flow and the
remaining implementation gap.

## Source documents

This overview summarizes the detailed [design workflow](../agent/skills/design-app/SKILL.md),
[UI preview review options](ui-preview-review-experiences.md),
[create-app workflow](../agent/skills/create-app/SKILL.md), [orchestration
workflow](../skills/autograph-app-builder/SKILL.md), and [session
semantics](../skills/autograph-app-builder/references/session-semantics.md).

### Generic development runtime for a normal destination

A deployment may configure `standardDevelopmentRuntime` with kind
`standard-development-runtime-policy-v1`, its immutable policy ID, an existing
reviewed synthetic-only Neon enrollment and nondefault branch, the genuine
Production database identity to exclude, and `workloadIdentity:
vercel-team-oidc-v1`. This is a generic development custody preset, not an
app-specific alias of a historical onboarding profile. Existing explicit
owner/app runtime profiles retain precedence and their original meaning.

Builder resolves the canonical current owner and the settled ordinary
provisioning receipt, independently reads that exact team/project/repository,
and captures the accepted release. The generic path independently lists the
project's domains and requires exactly one verified, nonredirecting production
domain; missing or ambiguous selection is a typed prerequisite. It also verifies
current Standard Protection and enabled team-mode OIDC. The actual team slug and
project name produce the exact Preview and Production workload subjects. Neither
a project name nor an old Gateway can stand in for domain or workload proof.

The canonical owner, app ID and recorded destination/provisioning tuple derive
stable, distinct app and Auth database/role names and a new profile identity.
The preset cannot replace an already configured app resource. The selected
branch must belong to the reviewed development enrollment, differ from its root,
and exclude the recorded Production endpoint. This selection creates no resource
and grants no effect. The ordinary resource/Auth/environment plan describes the
actual selected names and origin and requires a fresh concrete approval. Existing
owned-resource custody and retained schema receipts handle revisions; they do
not blindly reinstall Auth or transfer another app's approval.

Different owners and apps receive distinct restricted app/Auth roles. This does
not invent organization IDs or tenant memberships: those still come from normal
verified Realm capture. Sharing a tenant-owned provider connection continues to
use distinct application bindings in the shared integration control plane.
Runtime policy selection, source publication, provider activation and actual
BetterAuth/public-app behavior remain separate acceptance evidence.

When a project has multiple eligible production domains, automatic runtime
assembly reports `builder_public_domain_selection_required` until the owner
chooses through the saved-session destination page. Its same-origin
authenticated Server Action lists current verified production domains on the
recorded project, stores the selected origin against the canonical owner and
unchanged provisioning tuple using expected-origin compare-and-swap, and
re-reads that exact choice against current provider domains before runtime
assembly. Both generic and explicit-profile paths compare the choice again after
the final owner read; a concurrent change rejects the fresh plan without changing
any frozen intent. The provider-verified origin must also equal the captured
explicit choice, so an A/B/A metadata race cannot return a different fresh origin. Both direct and handoff sessions use this ordinary page. Provider
pagination is consumed in order under owner fences; duplicate cursors fail
closed. Branch/custom-environment domains, redirects, unverified domains and
wildcards cannot become the app's public Auth origin.

Choice metadata uses the existing journal table under the separate
`builder-public-origin-choice-v1` record kind, deterministic owner/destination
UUID key and record-level `selectionState: selected`. The existing table
requires the storage-column vocabulary `settled`; for this typed metadata record
that means the selection is durably stored, never that any provider effect has
settled. It is neither a
provisioning operation nor a settlement, approval or resource-ownership receipt;
old provisioning and uncertain operations remain untouched. Routine history
retention excludes current origin-choice metadata through the shared persistent-kind
policy. Explicit authorized tenant forget retains its existing scope and may remove
this non-effect choice; no native/provider operation is replayed or settled by cleanup. Choosing an origin
grants no resource, publication or deployment effect. Auth and release plans
freeze the chosen origin under their ordinary fresh approval; changing the
choice cannot reinterpret a previously approved plan. An origin choice that conflicts
with an explicit frozen runtime profile is reported as a configuration prerequisite
rather than silently replacing or ignoring that profile. The generated app's public
domain uses BetterAuth and does not require a Vercel account. Public delivery
uses the isolated-development Auth deployment profile and carries the exact
retained Auth resource classification into both the runtime configuration and
realm enrollment. Actual domain
existence/verification and public application behavior remain hosted acceptance
checks; project creation metadata alone does not prove either.

The dynamic configuration resolver explicitly admits per-app runtime/Auth,
public release, capability plan/prepare, continuity/managed-runtime and export
transport families. Capability preparation selects the app/session from its
complete frozen plan; the protected handler still verifies that plan and effect
approval. Revision and removal reuse their ordinary runtime/public-release
selectors. Normal actors and Realm callbacks resolve owner-bound nonce/journal
context through their existing handlers. Independent Neon consent and shared
central control/setup/event requests retain separate base authority; unknown
routes never become an inferred generic app operation.

Owned revision-resource custody (`owned-app-resource-source-v1`) is persistent
credential provenance, not expired operation history. A revision rechecks the
original approved setup and private checkpoint and still needs its own fresh
approval. Routine retention preserves both that pointer and only the exact
same-owner `app-runtime` row whose request matches its source target; other
unreferenced history keeps its existing retention behavior. Explicit authorized
tenant forget remains separate. A custody pointer cannot survive meaningfully
while its backing encrypted checkpoint is silently pruned.

### Dispatch-time destination and browser prerequisites

Saved-session destination selection rechecks existing legacy operations after
reservation and before each provider dispatch. A newly creating, unknown, or
ready legacy operation blocks the second destination while retaining the saved
reservation for reconciliation; it does not authorize another provider attempt.

Browser runtime-binding refusal uses the existing bounded failed-check result.
It never falls back to an unbound Sandbox command. Request cancellation still
aborts instead of being represented as an ordinary failed browser assertion.
