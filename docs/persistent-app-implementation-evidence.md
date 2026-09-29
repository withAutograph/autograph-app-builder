# Complete persistent app implementation evidence

Observed 2026-09-29. These changes enable the delivery path; the two qualifying application builds have not passed acceptance.

## Reviewable changes

- Arrusted shared runtime: https://github.com/withAutograph/arrusted-development/pull/1516
- Builder consumers and public workflow: https://github.com/withAutograph/autograph-app-builder/pull/566

Arrusted supplies source-derived app descriptions, authenticated context, selected-release Next packaging and provider-neutral runtime lifecycle tasks. The runtime installs releases under isolated database scope, provisions real Better Auth identities and restricted runtime principals, verifies installation identity, and cleans up owned resources. Builder consumes those contracts, authors and deletes application files durably, discovers existing schemas, prepares private authenticated validation and journals approved hosted preparation. Its handoff distinguishes Preview observations from Production approvals.

## Passed local validation

- Seven real Auth/PostgreSQL runtime tests cover role/session/assignment/database membership revocation, tenant isolation, forged scope, replay, persistence, concurrent writes/audit and release verification.
- Populated two-tenant upgrade tests preserve records and audit history; an injected second activation failure rolls back both scopes and a retry succeeds.
- Native Next output tracing includes CUE source and the selected release while excluding historical releases.
- Child-process tests exclude installer authority even when application environment input attempts to reintroduce it.
- Builder tests cover original-request recovery, durable file revisions, historical app baseline projection, scoped installation observations, isolated installer transfer and cleanup, and operator handoff checklists.
- Arrusted commit/push hooks validate application structure, tooling ownership, deployment policy, formatting, lint and affected types. CI evidence remains separate from these local checks.

These tests validate shared capabilities. They do not establish that Builder independently delivered either acceptance application.

## Public evaluation observations

### Inventory Counts: failed recovery; application acceptance unassessed

The complete product brief was submitted through `autograph_start` using request ID `1360be49-6d09-42da-a46f-cdc49e5ecc19`. An uncertain response recovered the same session, `wrun_01M3QJPZ2CCNCADMM47F945EBS`. Builder attempted its design/prototype workflow; a nonpublic theme import was rejected. No authenticated application receipt, installed app release or authored application PR was observed.

A development restart interrupted this session. Subsequent public read returned `waiting`, but a public continuation failed with “The session is no longer active.” This is a public recovery defect, not successful completion. Its correction and verification must precede another qualifying run.

### Spend Review: blocked at source authority; application acceptance unassessed

The revision brief names the agreed demo PR #1500 head `d186c659629430e1d6c8dce9575cdc30bdc20087` as the app baseline and the shared runtime branch as the platform source. Builder asked the repository question through the public workflow and received the ordinary answer. Session `wrun_01M3QK1VA6SZAEYGNNGXTP1P2J` reported that hosted GitHub session authority was invalid before establishing either source. No baseline, application edits or manual comparison input was accessed. This local diagnostic does not qualify as a Builder-authored revision.

Sanitized public transcripts are retained in [Inventory Counts](evals/evidence/2026-09-29-persistent-apps/inventory-counts.public.jsonl) and [Spend Review](evals/evidence/2026-09-29-persistent-apps/spend-review.public.jsonl). Owner-only raw transcripts and local reports are under `/private/tmp/builder-inventory-counts-public-v2` and `/private/tmp/builder-spend-review-public`. No evaluator prepared an application database, supplied Auth fixtures or edited an acceptance app.

### Preview sign-in: emulated only

The native Builder Preview public sign-in was tested after explicit approval for the emulated profile/email consent. This establishes the Preview UI sign-in path only. It does not establish real provider authorization, an authenticated acceptance app or production readiness.

## Hosted path blockers

See [Hosted app runtime](hosted-app-runtime.md) for source-backed provider constraints and recovery options. The native Neon/Vercel connection has no wired owner-scoped restricted credential issuer. Native database variables are deployment-managed, and shared Services project environment access does not establish installer credential isolation from application processes. The adapter fails explicitly when the required branch authority is absent. Changing the connection model requires a reviewed provider contract and separate approval; no provider migration or activation was performed.

## Remaining acceptance

Both applications still require independently Builder-authored changes and PR provenance, real authenticated Preview writes/readback after reload/restart/new deployment, full role and tenant enforcement, idempotency/concurrency/paginated audit, populated upgrade and failed-upgrade recovery, correct packaging, app/database/deployment checks and green applicable exact-head CI. Spend Review also requires self-approval denial and concurrent decision evidence. Production preparation, business access grants and activation remain separate approvals.
