# Self-reproduction eval handoff

This handoff preserves the current self-reproduction baseline and defines the next acceptance run. It does not claim results for other evals and does not authorize manual candidate repair, evaluator feedback during generation, a better reroll, deployment, or publication.

The supported public commands and response schemas remain authoritative in [self-reproduction.md](self-reproduction.md). Separate cross-eval regression evidence is recorded in [cross-eval-regression-2026-09-14.md](cross-eval-regression-2026-09-14.md); do not infer those results from this candidate baseline.

## Immutable baseline

- Product brief generation used the normal public entrypoint at source revision `04dbe04823b95c975d5483b635c8d8ed44010908`.
- Public session: `wrun_01M2F1SPPJ8ND6ZK7K7Z0FTBZY`.
- Session start: `2026-09-14T04:11:25.865Z`.
- Private working-preview verification: `2026-09-14T04:27:39.014Z`.
- Post-run known-path source retrieval: `2026-09-14T05:27:50.850Z` to `2026-09-14T05:28:06.507Z`.
- The frozen result remains a failed replica: the preview was reachable, but all three candidate captures showed only the title and no usable app-entry workflow.

The resumed source retrieval read 33 known paths, found 6 missing, and encountered 0 blocked reads. The retained `app/page.tsx` renders only the title. Retained `app/actions.ts` stores drafts in a process-local `Map` and returns status objects for creation, cancellation, retry, and recovery. Retained `scripts/test.mjs` prints seven success marks from a loop without assertions or app operations. These exact files confirm failures for the visible workflow, restart durability, independent child orchestration, and meaningful behavioral validation.

The retrieval resumed an existing stopped Sandbox after generation. It was a fixed known-path inventory, not a complete filesystem export, an observation of the original active runtime, a new app launch, or a new browser test. It does not assess global authentication, tenant isolation, restart behavior, full framework behavior, or files outside the inventory. Local evidence under `/private/tmp/self-reproduction-public-ws-20260914` is machine-local diagnostic material and must not be treated as portable evidence. Owner-only preview authority, private URLs, credentials, and private transcript content must stay out of checked-in reports.

## Landed shared repairs

PR #440 merged as `64b09286663a348f73c42e7e9a88b39eeae1a196`:

- preserves approved implementation files across partial apply retries;
- permits repair writes after validation or review;
- adds verifier-owned JSON POST/GET readback evidence with explicit partial coverage;
- invalidates stale behavior evidence and preview eligibility before implementation writes; and
- translates authenticated Next HMR origin only on the internal HMR path while retaining public origin and authentication checks.

Its exact-head CI passed at `d06042978452f388bdac3ceaadd991ce418ee623`; post-merge main CI `34807550364` passed.

PR #441 merged as `32dddc257beb1cd2e10cc95ce020f4ef0f286cee` and marks validation pending before repair writes, preventing prior technical success from surviving a failed repair. Its exact-head CI passed at `6202121b5a690bda784a241f71915fecfcfc8cf0`; post-merge main CI `34808709258` passed.

These repairs are framework evidence, not proof of a successful self-reproduction. No new generation was run after they landed.

## Remaining gaps

| Priority | Gap                            | Required evidence or repair                                                                                                                                                                                                                                                    |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0       | Complete usable replica        | A fresh public run must deliver the brief/configuration workflow, durable drafts, provider-return handling, creation progress, preview access, cancellation, retry, recovery, account settings, and documentation without evaluator implementation assistance.                 |
| P0       | Durable authenticated data     | Generated code must bind writes and reads to a synthetic authenticated tenant and survive reload and a controlled restart. A process-local Map cannot pass.                                                                                                                    |
| P0       | Independent child creation     | The replica must create one small independent child through its own backend and expose real progress, cancellation, retry, and recovery outcomes. Status-only stubs fail. Stop recursion after that child.                                                                     |
| P0       | Honest validation and recovery | Technical command success must not establish product completion. Retain real action/readback evidence and prove that a failed repair leaves validation pending.                                                                                                                |
| P1       | Complete final-source evidence | The supported delivery boundary must retain a complete final manifest or artifact with hashes. A known-path recovery is useful but cannot establish absence elsewhere.                                                                                                         |
| P1       | Private preview transport      | Verify the landed HMR fix through the normal authenticated preview. Record browser, console, page, script, and WebSocket outcomes without exposing launch authority.                                                                                                           |
| P1       | Paired functional comparison   | Exercise equivalent synthetic users, data, settings, and states in reference and candidate for authentication, reload persistence, provider callback return, creation, preview, cancellation, retry, and recovery.                                                             |
| P1       | Paired visual comparison       | Capture matching desktop viewports and states, including resizing, keyboard use, loading, empty, and error states. Keep visual findings advisory and separate from functional status.                                                                                          |
| P1       | Next.js behavior assessment    | Inspect the complete final source and exercise server-first rendering, client boundaries, durable server writes, auth/cache isolation, Suspense, Cache Components, partial prefetching, navigation continuity, and pending/optimistic behavior. Flags alone receive no credit. |
| P2       | Portable evidence bundle       | Produce sanitized Markdown, JSON, and HTML plus screenshots, hashes, revisions, workflow outcomes, and coverage statuses outside candidate source, then retain an approved portable artifact rather than relying on `/private/tmp`.                                            |

Actual hosted publication and provisioning remain unassessed. Reference-app shortcomings must be listed separately when paired assessment occurs.

## Next acceptance run

1. Start from current green `main` and record its immutable revision, model/settings, bundled skills, product brief hash, answer-sheet hash, and public session ID.
2. Start the ordinary stack with `mise run dev`, then invoke the public Streamable HTTP MCP driver once with `mise run eval:self-reproduction -- --endpoint http://127.0.0.1:64613/mcp --output-dir /absolute/external/evidence/public-baseline`. Use a new external output directory, the checked-in brief, the normal App Builder workflow, real model, project-scoped OIDC, Vercel Sandbox, and allow-all networking. A reachable GitHub acceptance endpoint may replace the local endpoint.
3. Answer product questions only from the fixed answer sheet and record each response. Resume structured approval/question cards with `--resume --responses-file /absolute/external/evidence/product-responses.json`; use the documented structured responses such as `{ "kind": "approve" }`. Resume an ordinary chat question with `--resume --message-file /absolute/external/evidence/recovery-reply.txt`. Allow ordinary model self-correction. Do not provide evaluator findings, patch candidate files, redirect the candidate to the reference source, or select a reroll.
4. Use ordinary private approval cards for requested build effects. Do not approve publication or live provider effects; use supported emulators for callback and publication scenarios.
5. Preserve partial evidence immediately: prompt, sanitized public transcript, model settings, timings, usage if available, source revisions, validation transitions, and a complete final-source manifest/artifact. Never copy bearer URLs or credentials into reports.
6. Before the receipt expires, open the delivered existing working preview with `mise run eval:self-reproduction-observe -- --state-file /absolute/external/evidence/public-baseline/state.json --output-dir /absolute/external/evidence/browser-observation`. This observation command must not install, host, repair, or launch the candidate; the App Builder product owns the candidate lifecycle. Capture matching desktop viewports and browser failures; use `--brief-file` only for the optional known brief-field assertion and only when its exact supported label and Continue control exist.
7. Exercise the required functional matrix with equivalent synthetic identities and data. Restart only through the supported product flow, then verify draft and session recovery. Test one independent child creation and stop recursion.
8. Observe whether the shared App Builder invokes its limited JSON action/readback verifier on its own for an exact accepted walkthrough outcome and current same-Sandbox preview. Do not direct internal tools or stages from the evaluator. If present, retain its `action-readback-only` result and keep authentication, browser behavior, restart durability, provider behavior, and overall product completion unassessed by that result.
9. Compare reference and candidate using passed, failed, blocked, or unassessed for each requirement. Missing candidate behavior is failed; unavailable infrastructure is blocked. Preserve incomplete results and keep visual scores advisory, without an aggregate pass threshold.
10. Publish no external effects. Review the sanitized evidence bundle, prioritize gaps by user impact and responsible layer, and keep confirmed causes separate from hypotheses.

The acceptance is informative when it can show exactly what ran and what did not. A reachable preview, a successful build command, or a model claim never substitutes for observed product behavior.
