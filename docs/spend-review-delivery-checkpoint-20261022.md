> **Historical checkpoint, superseded October 23:** the fresh Requests app now supports authenticated entry and one approved save/readback/hard reload. The delivery session stopped after that proof. Read the [October 23 closeout](spend-review-core-closeout-20261023.md); the invitation, source and failure snapshots below are not current instructions or blockers.

> Coordinator addendum, captured after this delivery checkpoint: PR #1018 exact-head CI run 39876316245 completed SUCCESS. All ten substantive jobs and aggregate check passed; two configured jobs skipped. Independently read via GitHub workflow and job APIs. The pending-CI wording retained below is historical.

# Spend Review Requests — delivery checkpoint

Captured 2026-10-23 00:18 UTC. Implementation and mutation loop stopped for the requested fresh-session handoff. The saved public build remains live; it was not cancelled, restarted or replaced.

## Current public build

- Session: `ses_226b88efa565fbd2a754a277ee5819c96cc229145d946610bed1111db8083407`.
- Largest observed cursor: **119**, status **working**, turn **47**. Last GET at 00:17:41 UTC returned no new events.
- Active normal identity invitation: `call_iKrHD8XeELQ8dEUslbNggwSA`, expires **2026-10-23T00:26:37.125Z**. Its private URL is retained only in `/private/tmp/spend-review-auth-invitation-current-20261023.json`; never print it or reuse after expiry.
- Ordinary continuation CID `578922e8-08f5-4e14-aa5b-b95c71cdb093` accepted and produced the new recovery plan.
- Complete preparation approval batch: request `aitxt-sVLHOlwi2vjrZ7JiViLMmxIR`, response CID `54a77ad7-66e9-47c8-bb8c-b9767c76f8ef`; accepted, resulting public status working.
- Approval covers existing Preview app/Auth databases and restricted roles, Auth schema check without migration/recreation/rotation, existing service connections, Gateway/Auth refresh, existing owner usage billing, retain shared Auth; expiry 2026-10-23 23:59 UTC. No Production/app-user grants/test writes. It used the user's standing approval for these same effects. Exact internal operation/plan identifiers were not independently read; do not invent them.
- Related observed-failure feedback CID `92812ebc-c902-4b2f-b7ce-ea1715ee30f2`, observation119, accepted while working119/no events. Its canonical consumption has not been proved. Do not issue a new CID on unknown outcome; reconcile the exact original call if required.
- Stop revision and resumed revision were independently proved **1 == 1** before turn46. No new Stop or resume is pending.

## Current delivered source

- Builder `new.autograph.so`: READY `dpl_5RJDPGaUiob5BzYhb1HGsKMjdrsa`, fresh alias readback **ccf2fc7481efe3ac7599ff47965a0303fbd25531** (PR1018 merge).
- Operator protected existing alias: READY `dpl_6fLimkfLA8apAQWKasQRxFuPJSsw`, fresh alias match **b27077acec67a28b1a07612aad898a0a3b5643e2** (PR1017 merge). No operator refresh for test-only1018.
- Gateway stable `autograph-gateway-preview.vercel.app`: READY `dpl_6sF5GBMEkuKar4VDdC8RBxES5pQs`, fresh alias match **4a0f74bf4f4d747f85bb7f991d2009691f796a46**, recorded app-owned review branch. The NORMAL approved Builder operation created and selected it; no evaluator alias/source mutation.
- Fresh Requests app has no newly proved delivery after that Gateway refresh. Last known deployment `dpl_EMkpvFjRXghZXtPYu2w36ch7rwEt` was4a; current app alias was not independently re-read at checkpoint.

## Actual browser observations and unresolved failures

1. Gateway startup is repaired: normal root renders the real app picker. Its normal `/auth/sign-in` works with the existing intended app account; visible alert **You're signed in** and app picker prove normal sign-in, not saved-build capture/app authorization.
2. The current fresh account-connection invitation returns JSON `auth_identity_required` both before and AFTER successful normal sign-in. The signed-in navigation automatically performed GET then POST; it did not require another user confirmation click. Exact POST `bwf9b-1792714485935-b550feb015c3` at 00:14:45.935 UTC returned **401**, independently read from Vercel CLI request logs. No further invitation retries occurred.
3. Clicking the real picker link **Spend Review Requests** returns **403 TRUSTED_SOURCES_ENVIRONMENT_MISMATCH**. Request `cle1:iad1::vmncj-1792714449647-43372bd31f1a`, about00:14 UTC. This fresh failure is separate from account capture.
4. Source diagnosis owned by coordinator: exact4a/currentmain operator-link route and identity helper byte-identical;1654 does not repair invitation. Existing Builder `realm_identity_callback_failure` stage diagnostic can discriminate POST/receiver failure. Do not add a speculative diagnostic patch. Current account link/capture remains unproved at119.
5. Arrusted1654 is merged5dacc875… and CIpassed; its internal proxy-header cleanup is a candidate for fresh document403. Adopt through normal Builder-owned same app PR/source reconciliation only if source diagnosis supports it; never direct app edits, blanket version gates, manual aliases or private workflow phases.

## CI/source state

- PR1017 merged b270 and live. Its exact-head CI39874441785 failed ONLY existing lifecycle fixture launch with ETXTBSY; runtime/auth/recovery/other lanes passed.
- PR1018 merged ccf2 at00:09:12 UTC, head af450382e91694ced615c5c4d695de2339b631c5, exact-head CI39876316245 pending at latest Main read; coordinator tracks final outcome.
  -1018 changes only existing isolation fixture launch to `/bin/sh` with the exact generated wrapper; all credential isolation assertions/env/input preserved, no retry or error suppression. Actual repository configured/type-aware lint passed with empty output. No local tests/build/install.
- Publication evidence: `/private/tmp/builder-lifecycle-fixture-publication-20261022/integration.json` and prior1017 publication ledger.
- No in-flight Main shell, mutation or tool execution handles remain. Native public turn47 remains working at its invitation wait. All new implementation/provider/browser actions are stopped for handoff.

## Last true historical working app proof — preserve its boundary

Older **Spend Review** at `/spend-review` (not fresh Requests) had one approved $1 pending fixture, title 'Preview persistence check — no purchase (Oct 21)', record `e5265de2-a6b3-5207-a183-25a1e37a0345`. One submit, detail/activity and hard reload persistence, self-review denial, no purchase/decision. Gateway then `dpl_7rmNBFiT6ghm75waxFPAj8cewVWr`, app `dpl_2x3fbMqwDSZjn2MgiBsncRCtyf9z`. Screenshot `/Users/jasonmorganson/.codex/visualizations/2026/10/05/01a10d7d-66c1-7d00-9960-c5f5c9587426/spend-review-approved-request-persisted-20261021.png`. This is historical proof; present reachability and fresh Requests proof are not established.

## Fixed first-use target for the next session

Resume observation of the SAME saved public build. Resolve only the source-proven account callback401 and protected document403 through shared source repairs and normal Builder-owned delivery. Then connect the existing account, enter `/spend-review-requests`, and submit exactly ONE already-approved $1 pending synthetic request through UI, verify details/activity plus reload and narrow independent database read. **ZERO fresh Requests records exist today.** Do not create a replacement app/account or repeat a save with unknown outcome. Defer reviewer QA, export, restart, pagination/race tests, general upgrades and fresh-install work. No new broad audit or iterative test loop.

Exact approved new record: title 'Preview persistence check — no purchase (Oct 22)'; vendor 'Internal verification fixture'; USD1.00; needed2026-10-22; reason 'Verify Spend Review Requests submission, confirmation, details, activity, and reload persistence. Synthetic test only; no purchase is authorized.' No approval/rejection decision.

Full state ledger: `/private/tmp/spend-review-current-continuation-handoff-20261022.json`. Acceptance history: `/private/tmp/spend-review-authenticated-preview-acceptance-20261019.json` (older top-level booleans do not prove fresh Requests). Coordinator owns final fixed-scope plan and closure matrix.
