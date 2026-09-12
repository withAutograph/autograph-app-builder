# Reference versus candidate parity contract (v1)

The authoritative implementation is `evals/support/self-reproduction-parity.ts`.
`parityEvidenceSchema` and `parityAssessmentSchema` are executable Zod schemas;
the assessment CLI exports both as JSON Schema. `workflowMatrix`,
`frameworkMatrix`, `desktopViewports`, and `captureStates` define the complete
row set. Version is `self-reproduction-parity/v1`, fixture version is `1`.
There is no aggregate pass, score cutoff, pixel similarity requirement, or
permission to alter Arrusted tokens. Report each row for each side even when
its counterpart fails. Visual quality scoring remains advisory.

## Ownership and integration

The exporter owns generation receipts, sanitized transcripts, source export,
inventory, source revisions, input exposure, and overall HTML/Markdown/JSON
assembly. This assessment owns fixture semantics and parity decisions. Do not
read `self-reproduction.workflow-results.json` from the candidate as evaluator
proof. A `producer: evaluator` literal is a format declaration, not a security
credential: the reporting process must obtain this file from its own trusted
runner, outside generator-writable output, and never let a candidate supply it.

Integrate in this order:

1. Export generated files without changing them or publishing. Map a completed
   run that produced no app to `output: missing` (failed). An inaccessible
   sandbox/export service is `output: infrastructure-unavailable` (blocked).
   A candidate tree with missing functionality is still `output: available`;
   mark individual rows `missing-functionality`. Do not call it infrastructure.
2. Write evaluator-owned `<evidence>/parity-evidence.json`. It contains
   `schemaVersion`, `runId`, `producer: evaluator`, `fixtureVersion: 1`, and
   `reference`/`candidate`. Each side has `output`, `reason`, `sourceRevision`,
   and `observations`. Omitted observations are unassessed. Record unknown
   revisions explicitly; a revision is provenance, not a runtime gate.
3. For each observation provide `requirementId`, `disposition`, `reason`,
   `method`, `artifacts`, and `assertions`. Dispositions are `observed`,
   `missing-functionality`, `infrastructure-unavailable`, and `not-run`.
   Each assertion has its matrix `id`, `passed` boolean, factual `detail`, and
   at least one relative artifact path. Failed assertions outrank infrastructure
   claims. Duplicate observations/assertions and unknown requirements are invalid.
4. Run `mise exec -- node --import tsx scripts/assess-self-reproduction.mts
--evidence /external/run/parity-evidence.json --output-dir /external/run`.
   This command only reads evidence and writes assessment files; it cannot
   generate an app, start a server, or call providers. Use `--schema-only` with
   `--output-dir` to export schemas and the matrix without runtime evidence.
5. Import `assessParity()` directly if preferred. Its artifact callback must
   verify nonempty files within the evidence root after resolving symlinks;
   the CLI implements this. Replace the legacy evaluator's `buildRequirements`
   and `frameworkRequirements` verdicts with `report.rows`. Legacy regex audits
   can remain diagnostic annotations but must not award parity passes.
6. Embed all rows from `parity-assessment.json` in the existing HTML/Markdown
   report, pairing by `requirementId`. Include candidate and reference reasons
   independently, artifact links, and advisory visuals. A valid report command
   exiting zero means assessment completed, not that the replica passed.
   Preserve partial artifacts on generation, capture, or assessment failure.

Artifacts relative to `<evidence>`:

| Artifact                                         | Producer / meaning                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `parity-evidence.json`                           | Trusted fixture/audit runner input                                     |
| `parity-evidence.schema.json`                    | CLI export of input schema                                             |
| `parity-assessment.schema.json`                  | CLI export of output schema                                            |
| `parity-matrix.json`                             | CLI export of all required assertions and desktop sizes                |
| `parity-assessment.json`                         | Assessor; 38 rows per side, all four statuses preserved                |
| `parity/captures/<viewport>/<state>/<side>.png`  | Browser runner; actual transient state                                 |
| `parity/captures/<viewport>/<state>/<side>.json` | Browser runner; sanitized execution receipt                            |
| `parity/workflows/<id>/<side>.json`              | Side adapter; action, observed transition, durable readback            |
| `parity/framework/<id>/<side>.json`              | Evaluator; source lines, doc references, runtime assertions            |
| `parity/independence/candidate.json`             | Evaluator; generator exposure, browser/server origins, child inventory |

## Deterministic state and workflow execution

Use `parity-fixtures.json` on both sides. Namespace its actor/workspace/record
IDs by run and side to avoid collisions. Freeze only the test clock where
supported; issue fresh auth/CSRF/state credentials through each application's
existing fixture mechanisms. Never copy reference cookies, database rows, source
code, handlers, or backend URLs into the candidate. Both sides use their own
real persistence layer. A UI stub or mocked successful write is not durability.
Run cases sequentially in independent browser contexts and reset only fixtures
owned by that run. A failed prerequisite blocks a dependent exercise; explicitly
missing functionality fails its own row. Existing test names are evidence
locators, not passing execution receipts.

| Seed                           | State to prepare                                         | Required transition                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anonymous-empty`              | No session or draft                                      | Enter brief; real continuation; public docs return                                                                                                       |
| `anonymous-draft`              | Fixed brief before sign-in                               | Authenticate, restore intent, sign out, deny unrelated actor                                                                                             |
| `owner-empty`                  | Owner session with empty server draft                    | Save every editable field; await server acknowledgement; read in fresh context with no copied local/session storage; compare durable revision and values |
| `owner-draft-provider-pending` | Saved draft and fresh bound callback state               | Success persists connection and draft; denial preserves draft and exposes recovery; replay must be rejected by the application handler                   |
| `owner-build-ready`            | Owner, required seeded connections, accepted fixed brief | Submit through this side's workflow; observe durable job and independently readable output                                                               |
| `owner-created-app`            | Test-owned created output and access capability          | Owner preview works; unrelated actor and expired capability fail                                                                                         |
| `owner-running-job`            | Operation paused at a test-owned deterministic latch     | Cancel, observe acknowledgement, release latch, reload; no late success                                                                                  |
| `owner-failed-job`             | One retryable operation failure                          | Retry once; repeated click creates no duplicate continuation; result survives reload                                                                     |
| `owner-interrupted-job`        | Durable pending job with detached browser                | Fresh context recovers same job; one continuation; persisted result                                                                                      |

Use existing repository fixture sources where applicable:
`e2e/onboarding/anonymous.spec.ts`, `e2e/auth/auth-emulated.spec.ts`,
`e2e/providers/provider-installations.spec.ts`,
`e2e/builder/builder-draft-store.spec.ts`, and
`e2e/builder/builder-handoff.spec.ts`. A handoff or visible polling test does not
prove that the replica independently created an app. Provider callbacks must
traverse the actual callback/state/persistence code with seeded local provider
responses. Do not use live provider changes to fill a test gap.

The independent child case creates exactly one child using the fixed stock
exceptions brief, verifies exported output and stops at depth one. It must not
ask that child to reproduce itself. Reuse the observed app-creation result for
the child inventory to avoid a second generation. Without an already authorized
local fixture or retained live run, leave child execution blocked/unassessed;
this contract does not authorize expensive live generation. A deterministic
model fixture can prove orchestration but cannot prove model generation quality;
state that scope in its receipt and retain the real model run separately.

`independenceAssertions()` compares both browser and server egress with all
reference backend origins and checks child inventory plus generator-input
provenance. No server egress coverage or exposure receipt means no independence
pass. This observes requests; it does not change Sandbox networking. Credentials,
callback query strings, cookies and raw tokens do not belong in receipts.

## Paired desktop captures

`captureParity()` accepts an already available Playwright browser and trusted
reference/candidate adapters. It creates a fresh context for every case, calls
`prepare(page, state)`, then `exercise(page, state, capture)`, writes the paired
PNG and JSON paths above, and closes contexts. No adapter means unassessed;
an adapter must explicitly distinguish missing controls from unavailable
infrastructure. Unexpected interaction exceptions fail. An adapter that forgets
to invoke `capture()` cannot pass. Prepare must seed the real app, not replace
it with fixture HTML or render a simulated candidate.

The viewport set matches `scripts/design-quality/browser.ts`: 1440×900,
1920×1080 and 1024×768. They are desktop samples, not minimum width policy.
Every side must implement these exact state assertions:

| State          | Exercise and capture                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `panel-resize` | Drag the real separator; measure panel width before/after; assert a changed width and reachable content, then capture               |
| `keyboard`     | Tab to a labelled control, assert visible focus; activate with Enter/Space; require an actual state transition, then capture        |
| `loading`      | Hold the operation at a fixture latch; assert useful loading content and retained pending state; capture before releasing the latch |
| `empty`        | Seed no app records; capture visible empty guidance; activate its next action and assert the expected transition                    |
| `error`        | Inject a real operation failure at the fixture boundary; capture the error; activate recovery and assert its transition             |

Screenshots alone do not pass interaction assertions. Inert controls fail even
if they look right. Use Arrusted semantic tokens verbatim; do not inject CSS,
change the palette or award/deny functional parity based on visual scores.

## Next.js assessment rules

Use the installed Next 16.3.4 docs, particularly
`01-app/01-getting-started/05-server-and-client-components.md`,
`01-app/02-guides/server-and-client-boundary.md`,
`01-app/02-guides/authentication-with-cache-components.md`,
`01-app/02-guides/migrating-to-cache-components.md`,
`01-app/02-guides/adopting-partial-prefetching.md`,
`01-app/02-guides/instant-navigation.md`, and
`01-app/03-api-reference/03-file-conventions/02-route-segment-config/instant.md`.
Reference and candidate receive the same framework matrix. Source reviews
record import graphs and concrete authorization/data paths, not regex counts.
Every framework pass requires source and behavior evidence; configuration flags
and an existing unexecuted test receive no credit.

`assertParityNavigation()` implements the installed guide's two distinct tests:
`instant(page, callback, { baseURL })` around direct `goto`, and `instant()`
around a real link click with a destination URL wait **inside** the callback.
It asserts useful shell UI inside each callback and resolved content after the
pause ends. Execute it in a Playwright test with app-specific selectors for both
sides. The caller retains test result and shell/resolved artifacts and supplies
all three `instant-navigation` assertions with method `@next/playwright/instant`.
Do not substitute elapsed-time thresholds, `instant` exports, flags, or a shell
test on the source page. Test a shared-layout route and provider-return route,
not just auth pages. The guide allows `next dev`; production acceptance needs
`exposeTestingApiInProductionBuild` in an isolated test build and warm-cache
behavior. Do not enable this testing API on a public deployment. Normal dev
does not exercise production prefetch traffic, so assess actual App Shell
prefetching separately in the appropriate available runtime. Separate browser
contexts avoid the documented testing-cookie collision on shared localhost.

For durable writes and auth/cache isolation, capture independent two-user
server readback after reload/sign-out, failed-write rollback and tenant scope.
For Cache Components and Suspense, retain meaningful static/fallback content
on direct load and below shared layouts during navigation, plus revalidation.
For partial prefetching, retain App Shell request behavior and correct differing
URL inputs; `prefetch={true}` now adds URL-specific cached content, not arbitrary
uncached dynamic data. For pending/optimistic behavior, hold a mutation, attempt
duplicate submission, fail it and observe rollback, then succeed and observe
confirmed reconciliation. Continue/back/forward must preserve draft and focus.

## Current limits

This worktree contains no exported generated baseline or running paired fixture
runtimes. The capture runner and navigation helper are executable integration
components; concrete candidate adapters and paired runtime evidence cannot be
invented from source. No parity or live generation pass is claimed. The separate
export/reporting task must supply candidate availability and evaluator receipts.
See `docs/reports/self-reproduction/2026-09-12-parity-audit.md` for the reference
source audit and remaining runtime coverage. No baseline app is repaired here.
