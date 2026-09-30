# Complete persistent app implementation evidence

Observed 2026-09-29. These changes enable the delivery path; the two qualifying application builds have not passed acceptance.

## Reviewable changes

- Arrusted shared runtime: https://github.com/withAutograph/arrusted-development/pull/1516
- Builder consumers and public workflow: https://github.com/withAutograph/autograph-app-builder/pull/566
- Persistent Sandbox lifecycle repair: https://github.com/withAutograph/autograph-app-builder/pull/576

Builder PR #566 is merged. Arrusted PR #1516 is reconciled with main's atomic
multi-tenant installer and corrected checked-release provenance; exact-head CI
passed at `8801e0c118d2755164ae569e192a2017d3140495`
([run](https://github.com/withAutograph/arrusted-development/actions/runs/36660874199)).

Arrusted supplies source-derived app descriptions, authenticated context, selected-release Next packaging and provider-neutral runtime lifecycle tasks. The runtime installs releases under isolated database scope, provisions real Better Auth identities and restricted runtime principals, verifies installation identity, and cleans up owned resources. Builder consumes those contracts, authors and deletes application files durably, discovers existing schemas, prepares private authenticated validation and journals approved hosted preparation. Its handoff distinguishes Preview observations from Production approvals.

Runtime review hardening is published at `cf0aa137f39d6ec6adaa3ece1f464bab4b884507`; fresh exact-head CI is required. It removes Auth assignment write authority, requires password-authenticated owned local clusters, serializes lifecycle state, preserves mise argv, and checks release identity. Eleven authenticated runtime tests, seven release tests, two real mise boundary tests, scoped typed lint and HK gates pass.

## Passed local validation

- Eleven real Auth/PostgreSQL runtime tests cover role/session/assignment/database membership revocation, tenant isolation, forged scope, replay, persistence, concurrent writes/audit and release verification.
- Populated two-tenant upgrade tests preserve records and audit history; an injected second activation failure rolls back both scopes and a retry succeeds.
- Native Next output tracing includes CUE source and the selected release while excluding historical releases.
- Child-process tests exclude installer authority even when application environment input attempts to reintroduce it.
- Builder tests cover original-request recovery, durable file revisions, historical app baseline projection, scoped installation observations, isolated installer transfer and cleanup, and operator handoff checklists.
- Arrusted commit/push hooks validate application structure, tooling ownership, deployment policy, formatting, lint and affected types. CI evidence remains separate from these local checks.

These tests validate shared capabilities. They do not establish that Builder independently delivered either acceptance application.

## Public evaluation observations

### Inventory Counts: failed recovery; application acceptance unassessed

The complete product brief was submitted through `autograph_start` using request ID `1360be49-6d09-42da-a46f-cdc49e5ecc19`. An uncertain response recovered the same session, `wrun_01M3QJPZ2CCNCADMM47F945EBS`. Builder attempted its design/prototype workflow; a nonpublic theme import was rejected. No authenticated application receipt, installed app release or authored application PR was observed.

A development restart interrupted this session. Subsequent public read returned `waiting`, but a public continuation failed with “The session is no longer active.” This is a public recovery defect, not successful completion. The local adapter correction preserves buffered progress, removes stale approval controls and returns `session_recovery_unavailable` instead of advertising a usable waiting session. Focused service/MCP tests, types and formatting pass. A public readback attempt after integration was blocked because the watched development runtime exited while observing temporary Git merge conflict markers; this is not runtime proof of the correction. A fresh stable public run is still required.

### Spend Review: blocked at source authority; application acceptance unassessed

The revision brief names the agreed demo PR #1500 head `d186c659629430e1d6c8dce9575cdc30bdc20087` as the app baseline and the shared runtime branch as the platform source. Builder asked the repository question through the public workflow and received the ordinary answer. Session `wrun_01M3QK1VA6SZAEYGNNGXTP1P2J` reported that hosted GitHub session authority was invalid before establishing either source. No baseline, application edits or manual comparison input was accessed. This local diagnostic does not qualify as a Builder-authored revision.

Sanitized public transcripts are retained in [Inventory Counts](evals/evidence/2026-09-29-persistent-apps/inventory-counts.public.jsonl) and [Spend Review](evals/evidence/2026-09-29-persistent-apps/spend-review.public.jsonl). Owner-only raw transcripts and local reports are under `/private/tmp/builder-inventory-counts-public-v2` and `/private/tmp/builder-spend-review-public`. No evaluator prepared an application database, supplied Auth fixtures or edited an acceptance app.

### Preview sign-in: emulated only

The native Builder Preview public sign-in was tested after explicit approval for the emulated profile/email consent. This establishes the Preview UI sign-in path only. It does not establish real provider authorization, an authenticated acceptance app or production readiness.

### Current hosted Spend Review start: blocked at public recovery

Read-only provider inspection verified the current Builder deployment at
`2131deb0dd1aef3d6481ab77a505ac9fe81183fd`, including Eve 0.68 support. The older
occupied Spend Review session's draft-only source rejection is historical;
current source selection accepts open PRs and ordinary branches.

A fresh qualifying revision brief used request ID
`8b48c82f-e9f7-4e31-b3d5-573e0b5a947d`. Public start, recovery with that ID, and
an identical exact retry returned `submission_unknown` with no usable session.
The original request is retained in the
[hosted recovery transcript](evals/evidence/2026-09-29-persistent-apps/spend-review-hosted-recovery.public.jsonl).
Native runs observed near that time lack request correlation and cannot be
attributed to this brief. No replacement request or manual application repair
satisfies this acceptance attempt. Inventory Counts qualification remains
unassessed.

### Persistent Sandbox reattachment: focused checks passed

The current Eve provider creates a persistent named Sandbox and resumes its
saved name with the supported SDK API. PR #576 fixes a concrete stale-handle
defect: Preview resume now updates the owning handle used for commands, files,
and cleanup. Cleanup coordinates pending resume, protects newer registrations,
and preserves explicit deletion after stop. Twenty-seven focused provider tests, types,
and scoped lint passed with the checked Eve 0.68 / Sandbox SDK 3.3 dependency
graph. The SDK boundary was mocked. Live hosted reattachment and complete-loss
recovery remain unassessed; the external private workspace-store proposal is a
separate planned milestone.

The combined Builder head also contains sanitized hosted start diagnostics. Server events hash request/operation/session identifiers and expose fixed failure phases and allowlisted database error categories, without prompts, SQL, credentials or raw errors. They preserve public errors and caller isolation. A later recovery and exact retry with the same original request ID remained `submission_unknown`; the retained transcript includes both.

Combined CI at `1136731` passed the Auth, Eve, provider proof, navigation, product-quality and package lanes, but repository CI exposed a Preview lease timer versus wall-clock cleanup boundary. The repair honors the separate lease-expiry signal and has a deterministic regression; all 22 Preview runtime tests, types and scoped lint pass. The final combined head requires fresh exact-head CI.

## Hosted path blockers

See [Hosted app runtime](hosted-app-runtime.md) for source-backed provider constraints and recovery options. The native Neon/Vercel connection has no wired owner-scoped restricted credential issuer. Native database variables are deployment-managed, and shared Services project environment access does not establish installer credential isolation from application processes. The adapter fails explicitly when the required branch authority is absent. Changing the connection model requires a reviewed provider contract and separate approval; no provider migration or activation was performed.

## Remaining acceptance

Both applications still require independently Builder-authored changes and PR provenance, real authenticated Preview writes/readback after reload/restart/new deployment, full role and tenant enforcement, idempotency/concurrency/paginated audit, populated upgrade and failed-upgrade recovery, correct packaging, app/database/deployment checks and green applicable exact-head CI. Spend Review also requires self-approval denial and concurrent decision evidence. Production preparation, business access grants and activation remain separate approvals.

## Private preparation checkpoint compatibility

`app:runtime plan` is read-only. Before hosted database mutation, Builder now
runs `app:runtime prepare <app> preview -- --checkpoint-only` in the separate
installer Sandbox. That phase allocates private resource identities and
credentials without installing databases. Builder encrypts and journals those
files before rechecking owner access and running full preparation. Replacement
control Sandboxes restore the same identities and passwords. The existing
journal step and approvals remain unchanged.

Twelve focused hosted service and Sandbox tests, types and scoped lint passed.
The Arrusted test exercised the same command through real mise and verified
private file permissions, secret-free output, no cluster creation and cleanup.
Builder exact-head CI passed at `f84a48ad63875b6ee98bba7f7273554b371745cb`
([run](https://github.com/withAutograph/autograph-app-builder/actions/runs/36664922905));
the compatible consumer revision requires fresh exact-head CI.
