# App Builder reset: current state and core closeout

> **Historical handoff, superseded October 23:** authenticated entry, script loading, and exactly one saved request with independent readback and hard reload are now proved. Read the [October 23 closeout](spend-review-core-closeout-20261023.md) for the current result, source evidence and deferred work. The failures and instructions below describe the original checkpoint; they are not current blockers or authority to resume the stopped delivery session.

Captured October 22, 2026, approximately 8:22 p.m. Eastern (October 23 UTC). This is a handoff, not a completion report.

Publication addendum: the user authorized committing these documents to main and starting a fresh execution session. The old delivery goal is confirmed paused. The fresh session takes sole delivery ownership under the fixed plan; the old sessions remain at their checkpoints. All runtime details below remain timestamped snapshots and require an ordinary current-state read before resumption.

## 1. Recommendation

Use a fresh **Codex coordination session**, with a fixed plan, to finish the **already-built Spend Review Requests app**. Reuse the saved public Builder session and its reviewed source, resources and approvals. A new app build is not the next missing step.

The shortest remaining path is to explain and repair two observed failure surfaces, deliver the necessary changes through Builder, and demonstrate one authenticated save and reload. Diagnose both failures before deciding the patch set: they could share a deployment or identity-context cause.

Do not expand this closeout into general product improvement. The separate [fixed execution plan](app-builder-core-closeout-plan-20261022.md) defines the work and change-control boundary.

## 2. What is actually working

| Area                             | Evidence                                                                                                                                                                                                                                  | Boundary                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A previous usable app            | On October 21, the older Spend Review app accepted one approved $1 synthetic request, showed its details/activity, and preserved it through a hard reload.                                                                                | Historical proof on the older app and deployments. Present reachability was not rechecked for this handoff. |
| Fresh app generation/publication | The fresh Spend Review Requests source was built and published on its owned review branch at `4a0f74bf4f4d747f85bb7f991d2009691f796a46`; its native app deployment reached READY.                                                         | Generation and delivery metadata do not prove authenticated use.                                            |
| Saved Builder recovery           | The original lineage was recovered. Stop/resume admission was actually proved, preserving the same logical session and approvals.                                                                                                         | Recovery does not establish app access.                                                                     |
| Current planning                 | After PR #1017, the actual saved public build produced a valid normal Preview preparation approval. The former missing-delivery planning failure was cleared in live use.                                                                 | The new approval is not proof every effect completed.                                                       |
| Gateway startup/source delivery  | The normal approved Builder operation created and activated Gateway deployment `dpl_6sF5GBMEkuKar4VDdC8RBxES5pQs` from the fresh app's recorded source. The stable alias was independently read back by the delivery session.             | The app route still fails.                                                                                  |
| Existing-account sign-in         | The Gateway's normal `/auth/sign-in` visibly reports “You're signed in” and renders the real app picker for the existing intended account.                                                                                                | Saved-build account linking and fresh app authorization remain unproved.                                    |
| Final platform CI                | PR #1018 exact-head CI run **39876316245 completed successfully**, independently read by the coordinator. All ten substantive lanes and the aggregate check passed; deployment-proof/package-publication jobs were skipped as configured. | CI qualifies the source, not hosted behavior.                                                               |

### The earlier successful app is real

- App: older **Spend Review**, route `/spend-review`.
- Exactly one approved submit on October 21 at `10:51:15.671Z`.
- Title: **Preview persistence check — no purchase (Oct 21)**; amount **$1.00**; status **pending_review**.
- Record: `e5265de2-a6b3-5207-a183-25a1e37a0345`.
- Details/activity and hard-reload persistence were observed; own-request review was denied. No purchase or decision was performed.
- App deployment: `dpl_2x3fbMqwDSZjn2MgiBsncRCtyf9z`, source `c8b291e9f30dc69c772deef2f99d7baa04d90e21`.
- Gateway then: `dpl_7rmNBFiT6ghm75waxFPAj8cewVWr`, source `d8be4e86244f7539f61facc959a6649b6d2fbb08`.
- [Historical screenshot](/Users/jasonmorganson/.codex/visualizations/2026/10/05/01a10d7d-66c1-7d00-9960-c5f5c9587426/spend-review-approved-request-persisted-20261021.png).

This is a useful reference for the minimum behavior. It must not be counted as success for the fresh Requests app, or made into another mandatory revalidation project.

## 3. The two remaining failure surfaces

### A. Connecting the existing account to the saved build returns 401

**Observed:** A fresh invitation from the current saved build reaches the correctly deployed Gateway. With the existing account signed in, the page performs GET and automatic POST. The POST returns **401** and JSON `auth_identity_required`.

- Observed POST request: `bwf9b-1792714485935-b550feb015c3`, around `2026-10-23T00:14:45.935Z`.
- Normal account sign-in works. Another password reset, account, or manual sign-in-first procedure is not an established fix.
- The exact deployed `4a` invitation route and its current Arrusted-main counterpart are byte-identical. Updating to PR #1654 does not repair this route.
- Builder supplies the fields the Gateway expects. No sender/receiver protocol mismatch has been established.

**Source understanding:** An unauthenticated valid GET normally redirects to sign-in. An authenticated GET renders the automatic POST. The POST signs an identity proof and stages it through the private Builder callback. Signing, workload identity, transport, callback validation, and response handling can all collapse to the same outward 401.

**Existing decisive evidence to inspect next:** Does the corresponding Builder POST to `/api/hosted-operator/realm-identity` arrive, and what status and existing `realm_identity_callback_failure` stage/code does it report? Closed stages include sender, body, canonical pending state, origin, proof verification, current authority, artifact, sealing and response.

A callback **200 is staging only**. The subsequent Builder browser handoff must authenticate the original Builder owner, perform a fresh Auth readback, publish the proof and consume the saved nonce. Check consumption before retrying: an error page alone does not establish that no durable step occurred.

**Root cause:** Not yet established. No additional diagnostic code or source patch is justified by the evidence currently captured.

### B. Opening the fresh app returns 403

**Observed:** Gateway root renders its app picker. Clicking the real **Spend Review Requests** link returns **403 `TRUSTED_SOURCES_ENVIRONMENT_MISMATCH`**, including after the fresh correct-source Gateway was activated.

- Observed request: `cle1:iad1::vmncj-1792714449647-43372bd31f1a`, approximately `00:14Z`.
- This is a fresh provider rejection, not an inference from an older deployment or a missing app build.
- The two approved Preview service-trust rules were applied and read back previously, preserving unrelated callers. Their current effective context must be compared with the failing hop; do not broaden policy to make the error disappear.

**Existing candidate:** [Arrusted PR #1654](https://github.com/withAutograph/arrusted-development/pull/1654), merged at `5dacc8758b575b78a107e117ce5e5f1456c28aad`, changes:

- `packages/microfrontends/src/neutral/transport.ts`
- `packages/platform-microfrontends/src/policy/gateway.ts`

It replaces the outbound header map for eligible protected app document GETs, preventing unrelated inbound proxy/deployment headers from surviving the overlay while preserving trusted identity/transport headers. Fresh app source `4a` does not include it. This directly covers a plausible mechanism for the failing browser document hop.

It does **not** change Vercel trust policy or repair an incorrect token/environment mapping. The 403 by itself does not prove this patch is sufficient. If diagnosis supports adoption, Builder must reconcile the same owned app branch/PR to include the shared fix and deliver that recorded source. A merge in Arrusted main does not change an older pinned app/Gateway deployment.

**Root cause:** Not yet established. PR #1654 is a supported candidate, not a blanket latest-framework/version requirement.

### Check the common boundary before writing two fixes

Both failures involve the newly delivered Gateway and protected service identity. Incorrect effective workload/environment context could explain more than one failure. Header overlay could explain the document 403 without explaining the account callback. Callback artifact/sealing/response failure could explain the 401 without explaining the document 403. These are hypotheses to discriminate with existing observations, not reasons to start additional implementation lanes.

## 4. The fixed definition of core completion

The already-built fresh app must support:

1. Supported saved public Builder continuation with its original ownership and approvals.
2. Normal connection of the existing intended account.
3. Authenticated entry to the fresh app, with its ordinary queue/details/activity usable.
4. Exactly one approved synthetic request, confirmation and independent readback, preserved through hard reload.
5. Evidence binding the served app/Gateway source and resources to that behavior, plus final platform CI.

This is a narrow product demonstration, not certification of every possible generated app. Security, tenant isolation, credential isolation and real effect approvals remain part of the core. App-specific role counts, package layouts, source digests, fixed versions and arbitrary quotas are not new acceptance gates.

## 5. Work explicitly deferred

| Deferred                                                                        | Treatment                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Reviewer decisions, notes, assignments and expanded multi-actor journeys        | Retain in backlog; no extra business writes now.                                    |
| Customer-data export/download                                                   | Separate protected feature exercise; historical intent is not extraction proof.     |
| Restart, redeployment and upgrade fault drills                                  | Retain existing scoped evidence; browser reload does not prove process replacement. |
| Pagination, races, retries with business effects, large datasets                | Separate bounded exercises after basic use.                                         |
| Self-service signup, email/password recovery and additional identities          | Existing planning/features remain separate; use the existing account.               |
| IaC/Alchemy migration, storage redesign, provider redesign                      | Existing Drive-backed workflow remains; no migration is needed to prove this app.   |
| UI polish, message changes, broad cost/performance optimization, generic audits | Record follow-ups; do not expand the closeout.                                      |
| Fresh installation/self-reproduction milestones and additional app builds       | Separate milestones; do not rerun as routine prerequisites.                         |

Published guidance: [core priorities and deferred work](https://github.com/withAutograph/autograph-app-builder/blob/main/docs/core-builder-priorities-and-deferred-work-20261022.md). Its current body was read at this checkpoint. Some underlying historical ledger fields still describe the older successful app; use the fresh-scope audit, not those old completion booleans.

## 6. What changed recently and is already closed

| Work                                                                                                        | State                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native saved-session ownership/cancelled-call recovery and public metadata, through #1011                   | Merged; actual original lineage recovered; CI passed.                                                                                                           |
| #1013 closed-stage planning diagnosis                                                                       | Merged and serving; identified missing app delivery in an Auth-bootstrap restore path.                                                                          |
| #1014 expired identity-wait handling                                                                        | Merged; actual old call resolved and returned control to the model. A later model retry is a separate call.                                                     |
| #1015–1016 Stop/resume and atomic delivery settlement                                                       | Merged; current Stop/resumed revision equality actually proved; CI passed.                                                                                      |
| [#1017 Auth/bootstrap planning repair](https://github.com/withAutograph/autograph-app-builder/pull/1017)    | Merged `b27077acec67a28b1a07612aad898a0a3b5643e2`; actual normal plan and correct-source Gateway delivery proved.                                               |
| [#1018 existing CI fixture launch repair](https://github.com/withAutograph/autograph-app-builder/pull/1018) | Merged `ccf2fc7481efe3ac7599ff47965a0303fbd25531`; final exact-head CI **39876316245 SUCCESS**. All assertions retained; no test additions or local suite runs. |
| User-facing messaging inventory and improvements, #1005                                                     | Merged; not a remaining core lane.                                                                                                                              |

The #1017 CI failure was an existing isolation fixture failing to launch a freshly written shell wrapper with `ETXTBSY`. #1018 invokes that same script via its declared shell interpreter, retaining every credential/state isolation assertion. The final repository lane passed. This source qualification issue is closed.

## 7. Where the loop lost focus

These are process conclusions supported by the recorded history, not a claim that every earlier change caused a regression:

- App generation, source publication, provider setup, account linking and app use were repeatedly grouped into one “almost done” milestone. They are distinct boundaries with different evidence.
- The older working app's proof and the fresh app's unfinished work were mixed in some status flags. That made progress sound closer than the current fresh scope supported.
- Individual failures were repaired before the complete delivery path and downstream dependencies were captured. Recovery work then added more operational paths to understand.
- READY/CI/source checks were often available sooner than actual authenticated behavior, while the completion estimate treated the latter as routine.
- Additional feature and operational exercises competed with initial usable access. They are now deferred explicitly.
- The same estimate was repeated while root causes remained unknown. **Retire the prior completion windows.** A new deadline needs the two current boundaries explained and the patch set frozen first.

More parallel source writers are not the immediate answer. The useful parallelism is bounded diagnosis of these two failures, followed by separate implementation only where the files and causes are independent. One coordinator owns integration and outward effects.

## 8. Preserved live checkpoint and approvals

Captured public state is a snapshot. The native wait may expire or advance after this document is written. No Main shell/tool/provider mutation handle remained in flight at checkpoint. New coordinator implementation and outward actions were stopped; the saved native wait was deliberately preserved rather than cancelled or replaced.

### Public session identifiers

```text
Coordinator Codex thread: 01a1173e-c22e-7011-809a-a7d4c1b8db5c (local)
Main delivery Codex thread: 01a10d7d-66c1-7d00-9960-c5f5c9587426 (local)
Original authority session: ses_a1cd504f4060716f9b5717b606f5d7830d5e757024f3a8502b8b9cc9a2e14c78
Recovered public child: ses_226b88efa565fbd2a754a277ee5819c96cc229145d946610bed1111db8083407
Recovery request CID: 93ead27f-3328-41de-a46b-66a5bb79fe91
Logical native session: wrun_41M5F630CT0GZP9K4BNNXH1MZK
Recovered physical owner: wrun_41M5JSRYYD0GMK37ERPVVF5KWF
Last observed public state: cursor119, working, turn47 at 00:17:41Z
Post-repair continuation CID: 578922e8-08f5-4e14-aa5b-b95c71cdb093
Preparation batch request: aitxt-sVLHOlwi2vjrZ7JiViLMmxIR
Preparation response CID: 54a77ad7-66e9-47c8-bb8c-b9767c76f8ef
Queued observed-failure feedback CID: 92812ebc-c902-4b2f-b7ce-ea1715ee30f2
Current invitation call: call_iKrHD8XeELQ8dEUslbNggwSA
Invitation expires: 2026-10-23T00:26:37.125Z (8:26 p.m. Eastern October22)
Stop revision / resumed revision last proved: 1 / 1
```

The failure-feedback SEND was accepted while working at cursor119; its canonical consumption was not proved. Reconcile an unknown outcome with the exact original call rather than issuing another CID. Do not reuse an expired invitation or copy its private URL into chat. Internal provisioning operation/plan identifiers were not independently read at this checkpoint; a public request ID is not a substitute.

### Current served source

| Service                           | Checkpoint source and deployment                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder, `new.autograph.so`       | READY `dpl_5RJDPGaUiob5BzYhb1HGsKMjdrsa`, exact PR1018 merge `ccf2fc7481efe3ac7599ff47965a0303fbd25531`; fresh alias readback by Main.                            |
| Operator protected existing alias | READY `dpl_6fLimkfLA8apAQWKasQRxFuPJSsw`, exact PR1017 merge `b27077acec67a28b1a07612aad898a0a3b5643e2`; fresh alias readback by Main.                            |
| Gateway stable Preview alias      | READY `dpl_6sF5GBMEkuKar4VDdC8RBxES5pQs`, exact owned source `4a0f74bf4f4d747f85bb7f991d2009691f796a46`; normal public Builder delivery and fresh alias readback. |
| Fresh Requests app                | Last known READY `dpl_EMkpvFjRXghZXtPYu2w36ch7rwEt`, source `4a`; app alias not independently re-read at handoff.                                                 |

Owned app source branch: `app-builder/review-292934fadc6cdf9cd1c3`, [Arrusted PR #1647](https://github.com/withAutograph/arrusted-development/pull/1647). Preserve the saved publication association, not just the Git branch name.

### Effects already authorized

- Existing Preview app/Auth resources and restricted roles, non-destructive Auth schema observation/adoption, existing service connections, Gateway/Auth hosting refresh and retained shared Auth. Latest preparation approval expiry recorded as October23, 23:59 UTC. It does not authorize Production, Auth rotation/recreation or new app-user grants.
- The two exact Preview-only service-trust rules were explicitly confirmed, applied and read back, preserving existing callers. That is not permission to broaden their environments or subjects.
- One fresh synthetic request is approved: **Preview persistence check — no purchase (Oct 22)**; vendor **Internal verification fixture**; **USD1.00**; needed date **2026-10-22**; pending status. Reason: verify submission, confirmation, details, activity and reload; no purchase is authorized. **Zero fresh Requests records had been created at checkpoint.** No approval/rejection decision is authorized.
- Use canonical current approval state and the recorded fixture scope. Reuse authorization for the same effect; request a new concrete approval only for genuinely uncovered actors or effects.
- Existing credentials remain in task-private handoffs. Do not extract cookies, print passwords/tokens, reset the account, create another account, rotate shared Auth or put secrets in this document.

## 9. Workspace and evidence pointers

The shared local Builder checkout is **not current production source**. At handoff it was on `fix/publication-upstream-commits`, commit `3a87f4c14287eea1b10e1cc5a2782c327f112ff2`, with unrelated modifications and untracked worktrees/planning files. Preserve them. Use an isolated checkout of the actual current primary commit for any new shared-source edit; follow each repo's AGENTS.md. Do not reset, clean or repurpose the shared checkout.

- Full chronological coordinator ledger: [closure ledger](/Users/jasonmorganson/.codex/visualizations/2026/10/05/01a10d7d-66c1-7d00-9960-c5f5c9587426/spend-review-closure-plan-20261020.json).
- Delivery-session checkpoint copy: [delivery checkpoint](spend-review-delivery-checkpoint-20261022.md).
- Delivery runtime handoff: `/private/tmp/spend-review-current-continuation-handoff-20261022.json`; read its `handoffCheckpoint`, not stale older top-level fields.
- Historical acceptance detail: `/private/tmp/spend-review-authenticated-preview-acceptance-20261019.json`, `oneApprovedRequesterPersistenceProof20261021`.
- Current primary CI: [PR1018 run39876316245](https://github.com/withAutograph/autograph-app-builder/actions/runs/39876316245).
- Repo guidance: `docs/public-mcp-contract.md`, `docs/local-development-lifecycle.md`, `docs/evals/self-reproduction.md`, and `agent/skills/create-app/SKILL.md` on the current primary source.

Temporary paths are supporting evidence, not a dependency to reconstruct the state in this document. The private invitation file may contain a bearer-like nonce and must remain private. No secret is needed in a fresh-session prompt.

## 10. Handoff decision

Source changes and final CI are closed out. Fresh authenticated app behavior is **not** complete. Continue only under the separately written fixed plan: diagnose the two actual boundaries, freeze the minimum necessary patch set, deliver through the supported Builder flow, demonstrate one approved journey, and stop. Additional improvements require a separate backlog or explicit plan amendment.
