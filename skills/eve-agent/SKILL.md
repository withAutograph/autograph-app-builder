---
name: eve-agent
description: Design, plan, create, and validate supported apps exclusively through the five durable Eve tools.
---

# Eve agent orchestration

## Required preflight

Before doing any app-building work, verify that all five tools are callable:
`eve_start`, `eve_get`, `eve_send`, `eve_respond`, and `eve_cancel`.

If any tool is unavailable, stop and report that the Autograph App Builder MCP
runtime is not connected. Do not invoke another app-building skill, use a shell
or filesystem fallback, scaffold an app, or edit the target repository directly.

## Workflow

1. Start every new app-building objective with `eve_start`.
2. Preserve the returned `sessionId` and `cursor`.
3. Use `eve_get` to obtain evidence; accepted work is not completed work.
4. Call `eve_respond` once for the complete non-empty `inputRequests` batch,
   preserving every unique `requestId`. Never split one Eve batch across calls.
5. Send unrelated follow-ups with `eve_send` only while the session is `waiting` and no input is unresolved.
6. Treat cancellation as cooperative. Poll until events prove the resulting state.
7. Open the session UI when visual progress or input controls help.
8. After a successful Eve call, fall back to its text or `structuredContent`
   response only for rendering when MCP Apps UI is unavailable.
9. Never state that a side effect succeeded until a public event proves it.

Read [session semantics](references/session-semantics.md) for cursor and status rules.
