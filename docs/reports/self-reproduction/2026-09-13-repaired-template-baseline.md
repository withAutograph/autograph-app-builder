# Self-reproduction after template setup repairs

The distinct live generation at
`/private/tmp/self-reproduction-prototype-gate-repair-generation-20260913`
used Builder `7ddd624eadaf83876b3af78e5625653d69ebb8b7` and the clean Arrusted
checkout at `3ca48f32307b39a5f1959ce089916c963fd00f55`. It preserves the original
brief, answers, transcript, revisions, and unchanged 30-file candidate. Earlier
runs, including r12 and the failed prototype-gate run, remain separate evidence.

## Setup and generation result

The Terra generation completed in 610,028 ms. Normal Builder validation passed
and exported a reviewed change set. The evaluator independently installed the
workspace in Vercel Sandbox, built the candidate with Next 16.3.4, started its
declared production server, received HTTP 200, and captured three desktop sizes.
No import-resolution failure occurred in this generation or runtime build.

The canonical template repairs cover TypeScript aliases in Vitest, consistent
Next/Vite/type dependency versions, app-owned PostCSS configuration, and the
canonical Arrusted theme import. Separate fresh-starter installation, typecheck,
test, build, startup, and browser style readbacks passed. These establish the
new starter's setup; they do not rewrite the historical r12 failure.

## Product result

Technical validation accepted a frontend simulation. The accepted AppSpec still
required authenticated durable drafts, provider callbacks, real child creation,
cancellation, retry, recovery, and tenant isolation. Those obligations were lost
during implementation, rather than omitted from the brief or accepted design.

The following findings are confirmed by source review of the preserved candidate;
they are not substituted for browser or backend execution:

| Priority | Expected outcome                                           | Observed implementation                                                                                           | Evidence in candidate                                          | Responsible layer                                                   |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| P1       | A draft survives reload and fresh authenticated access     | Draft fields and provider flags exist only in React state; the UI always says “Draft saved / Just now”            | `app/builder-client.tsx:21`, `:68`                             | Generated implementation; completion validation missed it           |
| P1       | Authentication and tenant-authorized data access           | No authentication, server actions, route handlers, storage, or session implementation in the exported application | Complete export; settings prose at `app/builder-client.tsx:73` | Generated implementation                                            |
| P1       | The replica independently generates and runs one child app | Approval and completion only change local stage; “Finish preview” marks the UI ready                              | `app/builder-client.tsx:264`                                   | Generated implementation; no independent orchestration              |
| P1       | Provider connections complete callbacks and persist        | Connect buttons toggle booleans                                                                                   | `app/builder-client.tsx:138`, `:143`                           | Generated implementation                                            |
| P1       | Cancellation, retry, and recovery act on durable jobs      | Controls only call `setStage()`                                                                                   | `app/builder-client.tsx`                                       | Generated implementation                                            |
| P2       | Server-first rendering with narrow interactive boundaries  | The route delegates all product behavior to one client component                                                  | `app/page.tsx:4`, `app/builder-client.tsx:1`                   | Generated architecture                                              |
| P2       | Tests exercise the actual product contract                 | Workflow tests compare constant arrays with themselves and import no product code                                 | `app/__tests__/builder-state.test.ts:5`                        | Generated tests; technical checks are insufficient product evidence |

The visible app uses supported Arrusted components and the canonical theme. It
presents a form and status cards with Build, Activity, Settings, and Docs tabs.
This is a recognizable builder concept, but visual resemblance cannot establish
the missing backend. No similarity percentage or aggregate pass threshold is
claimed.

## Evaluator and reference coverage

The same run passed five reference browser workflows: authentication, durable
drafts, successful provider return, denied/replayed provider return, and public
documentation. The separate controlled reference service diagnostic passed six
lifecycle assertions. That diagnostic is not live model generation or browser
parity evidence.

The first report from this run still had substantial assessment gaps. Its
candidate documentation failure came from probing `/docs`, although the
candidate exposes Docs as a local view control. That route-specific probe does
not establish missing documentation. Subsequent evaluator checks must activate
the actual control and retain their own receipts. The candidate source remains
unchanged during those checks.

Reference screenshots were unavailable in the original report; candidate route
captures were retained but not embedded. Evaluator fixes retain capture errors,
support the isolated reference fixture's self-signed TLS, and display diagnostic
pairs explicitly without claiming equivalent seeded states.

## Remaining work

1. Exercise candidate persistence, provider controls, independent child output,
   cancellation, recovery, and documentation through evaluator-owned assertions.
2. Bind production navigation evidence and reviewed framework observations;
   flags and file names alone remain unassessed.
3. Preserve the accepted product obligations through ordinary planning and
   completion, and add actual behavioral execution before claiming product
   completion. Reporting an obligation is not its implementation.
4. Finish equivalent authenticated creation/preview lifecycle fixtures and paired
   loading, empty, error, keyboard, and resizing captures. Keep unsupported
   fixtures unassessed and infrastructure failures blocked.

Anonymous entry remains outside the requested cleanup priority. Hosted
publication and provider provisioning remain unverified by design.
