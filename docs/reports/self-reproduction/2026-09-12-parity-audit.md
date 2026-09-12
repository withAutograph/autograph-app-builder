# Self-reproduction parity source audit

Reference revision: `65f9ed06edb0313207541a1afe7e92d16dd9a85f`.
This is a source assessment, not a paired runtime acceptance result. No generated
baseline is exported in this worktree. No providers were changed, live generation
rerun, candidate code repaired, or runtime started for this assessment.

The handwritten reference fails the requested narrow-client-boundary criterion:
both anonymous and authenticated clients own whole page shells. Other reference
criteria remain unassessed pending runtime evidence. Candidate assessment is
blocked because the reviewed generated source/runtime has not been exported;
this does not excuse any missing functionality once the export is available.

## Documentation authority

This worktree has no installed dependencies. Installed Next `16.3.4` and
`@next/playwright` `16.3.4` were verified in the existing `40a4` App Builder
worktree. Relevant guides were read from its `node_modules/next/dist/docs`.
The canonical saved checkout's installed Next was `16.3.3`; it was not used as
the final version authority. No dependency installation was needed.

Guides under that docs root:

- `01-app/01-getting-started/05-server-and-client-components.md`
- `01-app/02-guides/server-and-client-boundary.md`
- `01-app/02-guides/authentication-with-cache-components.md`
- `01-app/02-guides/migrating-to-cache-components.md`
- `01-app/02-guides/adopting-partial-prefetching.md`
- `01-app/02-guides/instant-navigation.md`
- `01-app/03-api-reference/03-file-conventions/02-route-segment-config/instant.md`

## Framework findings

| Requirement                 | Reference  | Candidate | Source evidence and remaining assertion                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-first rendering      | unassessed | blocked   | `app/(product)/page.tsx:46-170` resolves identity, flags, drafts and integrations on the server; `:175-183` provides a shell. Useful server-rendered output has not been observed in this assessment.                                                                                                                                                  |
| Narrow client boundaries    | failed     | blocked   | `app/ui/anonymous-builder.tsx:1,42-92` owns the entire main/header in a client component. `app/ui/app-builder.tsx:832,1599-1788` owns the full authenticated main/form in a large client root. Server data ownership does not make these interactive leaves.                                                                                           |
| Durable server writes       | unassessed | blocked   | `app/actions/builder-drafts.ts:14-36` reauthorizes writes; `lib/db/builder-drafts.ts:15-27,53-145,178-197` provides durable scoped reads/CAS. Need current acknowledged write and fresh-context readback, including failure preservation.                                                                                                              |
| Auth/cache isolation        | unassessed | blocked   | `next.config.ts:7-17` defines auth no-store headers; sign-up uses browser-only private caching at `app/(product)/auth/sign-up/page.tsx:19-29`; draft predicates include issuer/audience/workspace/user; `components/auth/sign-out.tsx:22-34` reloads after sign-out. Need two-user cached navigation/readback and revocation evidence.                 |
| Suspense                    | unassessed | blocked   | `app/(product)/layout.tsx:16-38,69-92`, `app/(product)/page.tsx:175-183`, and `app/ui/builder-loading-shell.tsx:9-45` define useful labelled fallbacks. Need direct-load and below-shared-layout navigation observations.                                                                                                                              |
| Cache Components            | unassessed | blocked   | `next.config.ts:7` is configuration only; sign-up private cache is source evidence. No retained static-shell/revalidation behavior. A private cache cannot itself prove static-shell inclusion.                                                                                                                                                        |
| Partial prefetching         | unassessed | blocked   | `next.config.ts:30` enables it; `app/ui/create-another-app-link.tsx:5` uses prefetch. Need App Shell request behavior and URL-dependent content correctness in a runtime that actually prefetches.                                                                                                                                                     |
| Instant navigation          | unassessed | blocked   | `e2e/auth/instant-navigation.spec.ts:6-67` uses the official helper with baseURL for direct loads and destination waits for link navigation. Builder direct-load and provider-back cases omit resolved Builder assertions after releasing the pause. Existing test definitions are not current execution results.                                      |
| Navigation continuity       | unassessed | blocked   | `e2e/providers/provider-installations.spec.ts:144-188` defines return/reload/focus behavior. Back/forward and shared-layout draft/focus continuity have no retained coverage here.                                                                                                                                                                     |
| Pending/optimistic behavior | unassessed | blocked   | `app/ui/app-builder.tsx:1558-1630` and `app/ui/authenticated-builder.tsx:69-97,147-164` implement pending, duplicate-submit guard and failure retention/retry. Need held-operation duplicate attempts, failure rollback/retention, and successful reconciliation. An optimistic hook is not mandatory when confirmation-first behavior is appropriate. |
| Arrusted semantic tokens    | unassessed | blocked   | No generated tree or rendered declaration provenance is available. Preserve semantic tokens and palette; styling source/visual scores alone do not establish provenance.                                                                                                                                                                               |

## Workflow and capture coverage

Every workflow in `workflowMatrix` is **unassessed** on reference and **blocked**
on candidate for this source-only baseline. Existing repository tests provide
starting fixtures, not transferable passes:

- `anonymous-entry`, `authentication`: onboarding and passkey E2E fixtures.
- `durable-draft`: server store and draft-interaction fixtures.
- `provider-return-success`, `provider-return-error`: provider callback fixtures.
- `app-creation`, `preview-access`, `cancellation`, `retry`, `session-recovery`,
  `independent-child`: require actual per-side workflow/runtime evidence. An Eve
  terminal state or handoff screen is not an independent replica execution.
- `documentation`: requires actual public docs navigation and return.

All 15 capture rows on reference are **unassessed**; all 15 on candidate are
**blocked**. The exact rows are the Cartesian product of `desktop`,
`desktop-wide`, `desktop-window` with `panel-resize`, `keyboard`, `loading`,
`empty`, `error`. `captureParity()` now implements paired orchestration, separate
contexts, transient PNG capture and execution receipts. Concrete adapters and
running apps are still required. No PNG is fabricated as acceptance evidence.

## Assessment integration

Use `evals/self-reproduction/parity-contract.md` as the integration contract and
the exported Zod/JSON schemas as machine authority. The legacy evaluator's
configuration/regex verdicts must not remain the parity verdicts after reporting
integration. Its candidate-authored workflow status file is not trusted proof.
The new matrix returns all 76 side-specific rows without an aggregate threshold.
The checked-in `2026-09-12-parity-evidence.json` reproduces the accompanying
`2026-09-12-parity-assessment.json`: one reference failure, 37 reference rows
unassessed, and 38 candidate rows blocked. These counts describe coverage only.

Remaining execution blockers: generated baseline export, paired fixture
runtimes and per-side adapters, server egress coverage for independence,
retained navigation/write/isolation results, and production-style prefetch
traffic evidence. This change does not authorize any provider mutation or
expensive generation to remove those blockers.
