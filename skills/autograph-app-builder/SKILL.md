---
name: autograph-app-builder
description: Use Autograph App Builder to design, plan, create, and validate supported apps through its five durable tools.
---

# Autograph App Builder orchestration

## Connection

Use the five App Builder tools when they are available. If the connection is
missing, ask Codex to connect or install the plugin; never substitute a shell
or direct filesystem implementation.

## Workflow

1. When the user asks to continue, resume, or pick up prior work, call
   `autograph_get` without a `sessionId` first and offer the relevant recent
   product sessions. Resume the chosen session with
   `autograph_start({ resumeSessionId, clientRequestId })`. Start genuinely new
   work with `autograph_start({ prompt, clientRequestId })`. When the web App
   Builder supplies an opaque handoff ID, redeem it with
   `autograph_start({ handoffId, clientRequestId })`; never decode it or ask the
   user to paste the underlying brief, provider IDs, or repository authority.
2. Preserve the returned `sessionId` and `cursor`. A healthy active resume keeps
   the handle; recovery after a terminal or interrupted session may return a new
   child handle.
3. Use `autograph_get` to obtain the current product result and continue from it.
4. Call `autograph_respond` once for the complete non-empty `inputRequests` batch,
   preserving every unique `requestId`. Never split one App Builder batch across calls.
   Authorization requests are not response-batch questions. Let the MCP App's
   Store In control open the server-provided GitHub connection or access-update
   page, then continue polling the same session. Never ask the user to reply
   “Repository selected” or treat that reply as proof of repository access.
   A separate choice between already connected GitHub accounts is a normal
   product question: submit its exact option id in the full response batch.
   Repository scopes shown on an authorization card are read-only.
5. Send unrelated follow-ups with `autograph_send` only while the app build is `waiting` and no input is unresolved.
6. Treat cancellation as cooperative and poll for the resulting state.
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
