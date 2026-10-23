# Spend Review Requests: authenticated Preview closeout

**October 23, 2026.** The fixed usability milestone is complete: the existing intended account opened the fresh app, submitted exactly one approved synthetic request, and saw the same saved request after an independent database readback and hard reload. The delivery session stopped after this demonstration.

Open the [Spend Review Requests Preview](https://autograph-gateway-preview.vercel.app/spend-review-requests) using the existing account. This is Preview evidence, not Production business-use approval or certification of every generated app.

This report supersedes the active-blocker wording in the October 22 [priorities](core-builder-priorities-and-deferred-work-20261022.md), [reset handoff](app-builder-core-reset-handoff-20261022.md), [fixed plan](app-builder-core-closeout-plan-20261022.md), and [delivery checkpoint](spend-review-delivery-checkpoint-20261022.md). Those handoff records retain their original timestamps and provenance.

## Completed behavior

| Milestone                                  | Observed result                                                                                                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing-account connection and app access | The normal existing browser profile reached Account connected; the saved workflow recorded the connection. The intended account opened the protected fresh app and its request form.                                                          |
| Script/CSS delivery                        | A normal browser reload through the updated Gateway returned document 200, stylesheet 200, and nine JavaScript responses 200 instead of the former asset 403s.                                                                                |
| One approved save                          | One submit action saved the approved USD 1.00 no-purchase fixture as Pending review. No purchase or reviewer decision was performed.                                                                                                          |
| Confirmation, details and activity         | The app confirmed the exact submission, displayed its saved fields, and showed the submitted activity.                                                                                                                                        |
| Hard reload                                | A reload with the browser cache ignored retained the same request, Pending review status, USD 1.00 amount and submitted activity.                                                                                                             |
| Independent persistence evidence           | Narrow read-only database transactions matched the exact UI request, expected fields, submitted audit event, mainline change set, submission timestamp and actor consistency. No new role, grant or credential was created for this readback. |

The record was submitted at **21:26:13.257 UTC / 5:26:13 p.m. Eastern**. The hard-reload proof completed at **21:27:54.824 UTC / 5:27:54 p.m. Eastern**. Final closeout was recorded at 21:28:25.327 UTC. These are recorded observations, not a continuous availability claim.

## Synthetic record and served source

| Evidence                 | Value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| App                      | `spend-review-requests`                                     |
| Synthetic request        | `58756610-f3c6-4cd0-9db2-a48b7dc3b2f9`                      |
| Title                    | Preview persistence check — no purchase (Oct 22)            |
| Vendor / amount / status | Internal verification fixture / USD 1.00 / `pending_review` |
| Needed-by date           | October 22, 2026, retained from the approved fixture        |
| Submit count             | Exactly one                                                 |
| Served app source        | `b387a2f986430be0790f5063284e3883e101a75e`                  |
| Served app deployment    | `dpl_D1orerBiM67nVZcxxpiTKs4A2f6f`                          |
| Gateway at closeout      | `dpl_6fdQyLfBqWHSwkwdj5fmfgUQvXCh`                          |

The app remained on its existing Builder-owned draft, [Arrusted PR #1647](https://github.com/withAutograph/arrusted-development/pull/1647). Shared framework adoption and app delivery went through Builder. This demonstration did not merge that app draft or activate Production.

## Repairs and evidence boundaries

- **Account connection and protected document:** the original 401 and document-level 403 were superseded by successful account connection and authenticated document observations. Earlier hypotheses, including inferring the native environment from REST `target: staging` alone, are not established causal explanations.
- **Owned-draft recovery:** Builder [#1021](https://github.com/withAutograph/autograph-app-builder/pull/1021) cleared the older PR-snapshot inspection blocker; [#1023](https://github.com/withAutograph/autograph-app-builder/pull/1023) supplied the supported same-owned-draft reopen path. The saved workflow then reconciled and delivered the changed app source. This does not prove every recovery or restart scenario.
- **Asset 403:** bounded diagnostics established that Vercel consumed the `dpl` query parameter after the Gateway signed the target. [Arrusted #1657](https://github.com/withAutograph/arrusted-development/pull/1657), merged as `34f574e347f537088cd9d73435306395e328b474`, moves deployment selection to the supported header before signing and preserves exact downstream target verification. Live asset loading and the user journey proved the repaired path. PR CI run [40017369532](https://github.com/withAutograph/arrusted-development/actions/runs/40017369532) and main CI run [40020271039](https://github.com/withAutograph/arrusted-development/actions/runs/40020271039) passed.
- **Approval UI:** Builder [#1026](https://github.com/withAutograph/autograph-app-builder/pull/1026), merged as `fc5ce411769a320d7bc26750be7ad79d79d0f1bf`, recovers a stale response only when exact owner/session/request/choice receipts prove it was already settled. It reuses existing reads, includes recovered-session authority handling, and does not replay approvals or provider effects. Coverage is limited to hosted runtime preparation and cleanup approvals; see the [public MCP contract](public-mcp-contract.md). Other approval categories and uncertain/conflicting outcomes are not inferred successful.

### Approval UI publication snapshot

At **22:15 UTC / 6:15 p.m. Eastern**, Vercel reported successful publication for #1026's merge commit. A live duplicate-card walkthrough was not performed. Its initial exact-head CI run [40029016712](https://github.com/withAutograph/autograph-app-builder/actions/runs/40029016712) failed repository lint on four explicit `return undefined` statements in the new recovery method; the other nine substantive lanes passed. Follow-up [#1027](https://github.com/withAutograph/autograph-app-builder/pull/1027) carries this closeout and a behavior-preserving return-flow correction that satisfies both return-style lint rules. All receipt, owner, session and uncertainty checks remain in place. This report does not claim a green final CI result for that correction before one is observed.

The pre-correction hosted-service focused suites passed 155 tests. The local request-handler suite could not load with its incomplete dependency closure; local TypeScript reported dependency/type mismatches. Those local results are not full final-head qualification or hosted UI proof.

## Workflow status at the stopping point

The usability proof is complete. At final capture, the saved public Builder view still reported **working / Starting the app preview**, cursor 712, although resource preparation had completed and the served app passed the user journey. The delivery session stopped further app/database mutations as requested. No later terminal public-status observation is claimed here.

Do not reopen the app milestone, submit another fixture, restart the saved workflow, or add a new admission check merely to make that status label agree with the already-recorded behavior. A later concrete failure is separate work.

## Deferred work

These items are outside the completed first-use milestone. Listing them does not authorize implementation, extra business writes, access changes or tests.

| Deferred work                                                                            | Boundary                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer decisions, assignments, notes and multi-user authorization                      | One requester save does not establish approve/reject, revocation or cross-tenant behavior.                                                                                       |
| Customer-data export/download                                                            | Historical export intent is not fresh extraction or downloaded-byte proof.                                                                                                       |
| Duplicate-submit races, pagination and larger datasets                                   | One successful save/reload is not concurrency, load or traversal qualification.                                                                                                  |
| Process restart, upgrade, redeployment and fault-recovery exercises                      | Browser reload does not establish populated continuity across process replacement or a later deployment. Preserve earlier scoped receipts without relabeling them as this proof. |
| Self-service signup, password recovery and additional identities                         | Existing-account entry is complete; onboarding and recovery remain separate work.                                                                                                |
| Alchemy/IaC and infrastructure redesign                                                  | Keep as later proposals only if they simplify the supported resource flow. No migration or storage redesign is required for this closeout.                                       |
| Broader approval recovery, UI polish, general diagnostics, cost and latency optimization | #1026 covers only its retained receipt types. Other categories and general improvements remain separate.                                                                         |
| Fresh-install and self-reproduction milestones, additional app builds                    | This recovered existing build demonstrates its named user journey, not out-of-the-box reproduction or reliability for every brief.                                               |

The [priorities and deferred-work inventory](core-builder-priorities-and-deferred-work-20261022.md) retains the follow-up details. Preserve tenant/credential isolation and actual effect approvals. Necessary repairs within an already-authorized outcome do not require another chat confirmation per commit; genuinely new effects still require their applicable approval. No app-specific shape, role-count, version, layout or usage gate is introduced by this report.

## Evidence provenance

The coordinator read the delivery session's final result and the actual saved proof files on October 23. The key fields are reproduced above so this report is useful without access to one developer's filesystem. The private local evidence directory is:

`/Users/jasonmorganson/.codex/visualizations/2026/10/23/01a1663f-42ae-7b11-abd7-569718bc89f9/`

- `single-request-persistence-proof.json`: one submit, confirmation, served source, hard-reload result and narrow database proof summary.
- `spend-review-final-closeout.json`: app/Gateway source, saved workflow status and exact UI-record database result.
- `request-hard-reload-proof.txt`: retained browser observation.

Do not publish authentication state, credentials, invitation URLs/nonces or private database connection strings with these receipts. No new browser, database or provider acceptance run was performed to write this document.
