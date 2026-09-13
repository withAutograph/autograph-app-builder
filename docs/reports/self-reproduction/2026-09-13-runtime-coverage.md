# Runtime coverage acceptance

The canonical Arrusted clone, installation, Next 16.3.4 build, and Sandbox startup passed. Infrastructure access was exercised with a real model request and a child Sandbox sentinel, including cleanup. This establishes available infrastructure, not generated application functionality.

The unchanged exported candidate has 30 files whose hashes match its original generation receipt. No generation was repeated and no candidate implementation was patched for this comparison.

## Evidence

- Candidate and infrastructure run: `/private/tmp/self-reproduction-runtime-coverage-acceptance-20260913` (Builder source `5992b869`).
- Repaired reference-only replay: `/private/tmp/self-reproduction-reference-replay-20260913` (Builder source `90946ac7adf4bf35dfa24fe7ac0550791ad17475`).
- Combined local HTML, Markdown, JSON and screenshots: `/private/tmp/self-reproduction-navigation-reassembled-20260913-v2`.
- Harness changes: https://github.com/withAutograph/autograph-app-builder/pull/428.

The reference authenticated through actual provider emulators, persisted matching synthetic drafts with owner-scoped PostgreSQL readbacks at all three desktop viewports, and passed all 11 production-navigation checks. All six paired images loaded in browser QA. The combined report lists no missing evidence artifacts. Prior failed attempts remain separate diagnostic evidence.

| Application | Passed | Failed | Unassessed |
| ----------- | -----: | -----: | ---------: |
| Candidate   |      7 |     18 |         13 |
| Reference   |      6 |      0 |         32 |

These are requirement counts, not a similarity score. Matching visible inputs do not establish candidate authentication or persistence. The candidate implements saving, provider connections, creation, and recovery as local state transitions. Infrastructure repair does not supply these missing product implementations.

## Remaining work

1. Repair generated browser-history continuity. A separate retained candidate-only probe (`/private/tmp/self-reproduction-candidate-navigation-acceptance-20260913`) found Back did not restore the draft and Forward did not restore Docs. Custom Back buttons had previously passed. Its initial report assembly failed on missing assertion artifact links; the fixed mapper and offline replay retain the real browser result without repeating execution. Shared-layout state remains unassessed.
2. Exercise generic route loading/error boundaries. The candidate has real Next fallback files; absent creation orchestration does not establish failure of these generic capture requirements. All six rows remain unassessed until a real fallback/recovery fixture is exercised.
3. Add actual product acceptance to normal Builder validation. Compiler/build/unit-test success currently leaves product obligations unassessed. A fixture that writes directly to storage would not prove the product workflow.
4. Implement hosted orchestration for GitHub live execution. The user confirmed no existing self-hosted runner. The current workflow is therefore not runnable; passing ordinary CI is separate from live eval acceptance. Project OIDC, private Arrusted access, isolated reference PostgreSQL, and artifact retrieval all need supported hosted execution paths.

Anonymous entry is excluded from cleanup priority. Hosted publication and provisioning remain unverified. Reference framework and creation-lifecycle coverage is incomplete.
