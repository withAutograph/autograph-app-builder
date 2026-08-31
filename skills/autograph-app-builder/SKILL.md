---
name: autograph-app-builder
description: Use Autograph App Builder to design, plan, create, and validate supported apps through its five durable tools.
---

# Autograph App Builder orchestration

## Required preflight

Before starting an app build, verify that all five App Builder tools are callable:
`autograph_start`, `autograph_get`, `autograph_send`, `autograph_respond`, and `autograph_cancel`.

If any tool is unavailable, stop and report that the Autograph App Builder MCP
runtime is not connected. Do not invoke another app-building skill, use a shell
or filesystem fallback, scaffold an app, or edit the target repository directly.

## Workflow

1. Start every new app build with `autograph_start`.
2. Preserve the returned `sessionId` and `cursor`.
3. Use `autograph_get` to obtain evidence; accepted work is not completed work.
4. Call `autograph_respond` once for the complete non-empty `inputRequests` batch,
   preserving every unique `requestId`. Never split one App Builder batch across calls.
5. Send unrelated follow-ups with `autograph_send` only while the app build is `waiting` and no input is unresolved.
6. Treat cancellation as cooperative. Poll until events prove the resulting state.
7. Treat the MCP App as an optional progress and input-control surface only. Never
   use it to display or embed the generated app preview.
8. When Autograph provides a preview URL, open it in the integrated ChatGPT or
   Codex Browser. Prefer the hosted HTTPS URL; use a loopback URL for local proof.
   If the integrated Browser is unavailable, provide the ordinary preview link.
9. After a successful App Builder call, use its text and `structuredContent` for
   status, evidence, and input handling—not for rendering prototype HTML.
10. Never state that a side effect succeeded until a public event proves it.

## Public conversation

Treat tool-only progress as silent. Do not tell the user that you are waiting
for or received internal receipts, digests, workspace preparation, validation,
retries, protocol operations, or setup mechanics. If polling yields no new
visible product outcome, continue without a user-facing progress message.

Describe only the product: concise inferred design choices, what is ready to
explore in the prototype, and what the implementation plan will deliver. For
example, say “I’m shaping the exception queue and detail workflow” or “The
prototype and implementation plan are ready to review,” never that prototype or
plan receipts are pending or complete.

Read [session semantics](references/session-semantics.md) for cursor and status rules.
