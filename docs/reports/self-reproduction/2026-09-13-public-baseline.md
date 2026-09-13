# Public-entrypoint baseline: failed delivery

One real session, `wrun_01M2DTBRT44GXGANVH26SHNBS1`, began at 2026-09-13T16:42:14Z through the normal local development `/mcp` endpoint. Product source revision: `c3e03771db2dcab55554896f654093d23b9d12c6`. The public client submitted the checked-in brief, one ordinary chat build approval, two public creation approval cards, and a question asking where to open the result. No internal stages were directed and no candidate files were repaired.

The public preview loaded with HTTP 200 and was explicitly classified as fixtures-only. The Builder then claimed the app was ready locally, including durable drafts, server actions, emulated callbacks, and recovery. Asked where to open it, it supplied `http://localhost:<your-dev-port>/autograph-app-builder`. That route returned HTTP 404 on the actual configured service port, 64613. The configured destination `/private/tmp/app-builder-public-dev-output` contained zero files.

This is **failed delivery at the observed user-accessible locations**, not proof that implementation exists nowhere. Independent child creation, authentication, persistence, recovery, framework behavior, and paired visual similarity remain unassessed. Automatic remote cloning is also unassessed: the supported development service was configured with an existing Arrusted checkout. Hosted publication/provisioning was excluded.

## Repair priorities

1. **P0: Working delivery.** Shared Builder output handoff must return a concrete reachable app and accessible output, verified before announcing readiness.
2. **P1: Ground completion claims.** Require implementation and behavioral evidence before claiming durable backend capabilities. The internal cause is not established by this public trace.
3. **P2: Approval clarity.** Explain renewed approval requests and describe effects in product language instead of exposing `apply_app_creation`.

Original evidence remains at `/private/tmp/self-reproduction-public-baseline-20260913`: `transcript.jsonl`, `assessment.{json,md,html}`, preview/delivery screenshots and receipts, output inventory, and the comparison-only report. These local artifacts are not durable CI attachments. Reproduce using the public driver documented in `docs/evals/self-reproduction.md`; do not reroll or reclassify this baseline as successful.
