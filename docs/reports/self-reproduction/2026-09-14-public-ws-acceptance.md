# Public self-reproduction acceptance — 2026-09-14

The delivered preview is reachable but is not a usable replica. Out-of-box self-reproduction is not proven.

| Requirement                                           | Status     | Evidence summary                                                                                                                                                                        |
| ----------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public entrypoint and private approval                | passed     | One public session, unchanged brief, two ordinary build approvals; no evaluator implementation instructions.                                                                            |
| Reachable private preview                             | passed     | Delivered at 04:27:39 UTC; three browser captures completed.                                                                                                                            |
| Usable app-entry workflow                             | failed     | All three captures show only the app title. Required brief and workflow controls are absent.                                                                                            |
| Meaningful behavioral validation                      | failed     | Exact retained `scripts/test.mjs` prints seven checkmarks from a loop without assertions or app operations; technical validation nevertheless passed.                                   |
| Durable server storage in final known-path source     | failed     | Exact retained `app/actions.ts` uses a process-local Map. No restart durability is implemented.                                                                                         |
| Independent child creation in final known-path source | failed     | Exact retained creation, cancellation, retry, and recovery actions return status objects without independent generation or durable orchestration.                                       |
| WebSocket preview transport                           | failed     | Browser observed handshake502 despite new WS code present in active local runtime bundle. Exact remote cause unresolved.                                                                |
| Authentication and tenant isolation                   | unassessed | Global guards and final wiring were not inventoried.                                                                                                                                    |
| Paired visual and framework behavior                  | unassessed | Candidate-only captures; no usable workflow to compare. No score or behavioral navigation credit.                                                                                       |
| Hosted publication and provisioning                   | unassessed | Excluded from private baseline; not performed.                                                                                                                                          |
| Final known-path source and blank-page cause          | failed     | A post-run retrieval read 33 known paths, found 6 missing, and had 0 blocked reads. Exact retained `app/page.tsx` renders only the title; richer workspace/component paths are missing. |

Evidence retained outside the source tree: `browser-observation/report.json`, paired with its three candidate screenshots; `final-source/resumed-retrieval.json` and its 33 retained files; `source-review/source-review.md` and indexed historical submissions; `transcript.jsonl`. These are candidate-only observations, not paired reference captures. The final-source read resumed the existing stopped Sandbox after generation and inspected only known paths. It was not a complete filesystem export, a capture of the original active runtime, a new app launch, or a new browser test.

The retained files confirm the delivered source contained the title-only page, process-local storage, status-only orchestration, and an assertion-free test script. The prior retry trace confirms implementation-file loss, but the exact historical sequence from the richer first submission to these retained final bytes remains a diagnosis rather than an observation of the original active runtime.

Local retained evidence: `/private/tmp/self-reproduction-public-ws-20260914`. This path is machine-local diagnostic evidence, not portable checked-in proof. Generation source revision `04dbe04823b95c975d5483b635c8d8ed44010908`; public session `wrun_01M2F1SPPJ8ND6ZK7K7Z0FTBZY`; generation began `2026-09-14T04:11:25.865Z`; preview delivery was recorded at `2026-09-14T04:27:39.014Z`; known-path retrieval ran from `2026-09-14T05:27:50.850Z` through `2026-09-14T05:28:06.507Z`. Raw preview authority remains owner-only and is not reproduced here.

Sanitized retained-source excerpts:

```tsx
export default function AutographAppBuilderPage() {
  return (
    <main>
      <h1>Autograph App Builder</h1>
    </main>
  );
}
```

```ts
const memory = new Map<string, DraftWrite>();
export async function approveCreation(draftId: string) {
  const draft = memory.get(draftId);
  if (!draft) throw new Error("Draft not found.");
  return { ok: true as const, jobId: `job-${draftId}`, status: "queued" as const };
}
```

```js
for (const outcome of outcomes) console.log(`✓ ${outcome}`);
```

These excerpts establish only the stated source findings. They do not establish full filesystem coverage, runtime behavior, authentication, tenant isolation, restart recovery, or framework behavior.

## Landed shared repairs

- PR #440 merged as `64b09286663a348f73c42e7e9a88b39eeae1a196`. It preserves implementation files across partial retries, permits repair writes after validation/review, adds limited verifier-owned JSON action/readback evidence, invalidates stale evidence and preview eligibility before writes, and repairs authenticated Next HMR origin translation. Exact-head CI passed at `d06042978452f388bdac3ceaadd991ce418ee623`; post-merge main CI `34807550364` passed.
- PR #441 merged as `32dddc257beb1cd2e10cc95ce020f4ef0f286cee`. It marks validation pending before repair writes so prior technical success cannot survive a failed repair. Exact-head CI passed at `6202121b5a690bda784a241f71915fecfcfc8cf0`; post-merge main CI `34808709258` passed.

These shared repairs do not change the frozen baseline result. No candidate code was manually repaired, and no replacement generation was selected.

See the [durable handoff](../../evals/self-reproduction-handoff.md) for the next public acceptance procedure and the [cross-eval regression audit](../../evals/cross-eval-regression-2026-09-14.md) for separate regression evidence. This report does not infer results for other evals.

## Remaining repairs and proof

| Priority | Expected / observed                                                                                                   | Responsible layer and next repair                                                                                                                                                                                                                                         | Cause confidence                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P0       | A repaired build retains the submitted UI; the successful retry supplied only a small subset of the first submission. | Landed in PR #440. Re-run one ordinary public-entrypoint acceptance to prove the repair in a new generation; do not patch or reroll the candidate.                                                                                                                        | Retry data loss confirmed; retained final bytes confirm the title-only result.                     |
| P0       | Repairs take effect after technical validation; the later config repair was silently ignored.                         | Landed across PRs #440 and #441. Re-run one public acceptance and retain validation state transitions plus final source.                                                                                                                                                  | Confirmed from tool input and reused response.                                                     |
| P0       | Requested durable records and child generation work; retained actions use an in-memory Map and return status objects. | Generated implementation and shared behavioral validation: verify real app-owned storage, authenticated reads, restart recovery, actual child execution, cancellation, and retry. SQLite/files remain allowed; no outward provisioning is required for local persistence. | Retained implementation deficiencies confirmed; full filesystem and global auth remain unassessed. |
| P1       | Tests exercise app behavior; the replacement test script prints checkmarks.                                           | Shared validation: retain independent action/readback evidence. A successful command cannot establish product completion. The new JSON readback capability covers only one subset; authenticated/browser/restart and child-generation evidence remains required.          | Confirmed.                                                                                         |
| P1       | Private preview HMR works; browser handshakes returned 502 in the frozen run.                                         | HMR translation repair landed in PR #440. Verify it through the next ordinary authenticated preview; preserve exact-origin and cookie checks.                                                                                                                             | Frozen browser failure confirmed; repair not yet proven by a new generation.                       |
| P1       | Comparison can inspect the delivered source; the post-run artifact covers known paths only.                           | Shared private delivery: provide a complete final source manifest/artifact through the supported product boundary, then audit it without feeding evaluator findings back into generation.                                                                                 | Known-path source findings confirmed; complete filesystem coverage remains absent.                 |
| P2       | Paired states and framework behavior can be compared.                                                                 | Evaluator observation: once candidate functionality works, exercise equivalent reference/candidate states and retain actual navigation, persistence, loading, and recovery evidence.                                                                                      | Currently unassessed, with no visual score or parity claim.                                        |

Reference-app shortcomings were not reassessed in this candidate-only run. Actual hosted publication and provisioning remain unverified and outside this private baseline.
