---
name: autograph-app-builder
description: Create apps or continue app sessions through Autograph App Builder.
---

# Autograph App Builder orchestration

## Connection

Use the five public App Builder tools. If they are missing or the connection
fails, follow [connection recovery](references/connection-recovery.md) before
asking the user to troubleshoot: discover the tools, verify with a read-only
`autograph_get`, and use the host's supported connect/reconnect action when
available. Let the host handle sign-in and consent; after recovery, verify access
and continue the same saved Builder session. If the host needs a user click or a
fresh chat, give one concrete next action and preserve the continuation context.
Never substitute a shell-based app implementation or direct filesystem edits
for Builder's public workflow. Host connection-management commands are allowed
under the recovery guidance; they do not authorize app or provider effects.

## Workflow

1. When continuing prior work, inspect an exact session already established in
   the conversation with `autograph_get({ sessionId, cursor })`, using its saved
   cursor when available. If the session is unknown or ambiguous, call
   `autograph_get` without a `sessionId` and offer relevant recent sessions for
   selection. For checkpoint recovery, resume the established or selected session
   with `autograph_start({ resumeSessionId, clientRequestId })`; for an explicit
   continuation after Stop, use the same-session SEND below. Start genuinely new
   work with `autograph_start({ prompt, clientRequestId })`. When the web App
   Builder supplies an opaque handoff ID, redeem it with
   `autograph_start({ handoffId, clientRequestId })`; never decode it or ask the
   user to paste the underlying brief, provider IDs, or repository authority.
2. Preserve the returned `sessionId` and the largest `cursor` observed for that
   same session. A healthy active resume keeps
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
5. For ordinary new product feedback, a genuinely new `autograph_send` may be
   queued on a supported hosted public session while it is `working`, or sent as a
   follow-up while it is `waiting`, only when no approval batch or user input is
   outstanding. Use a fresh stable `clientRequestId` for each new SEND and include
   the largest saved `observationCursor` for that same session. An accepted
   acknowledgement proves durable acceptance only; it does not prove native turn
   start or effect completion. Poll the same session; do not issue a new SEND to
   repeat acknowledged feedback. Stop, terminal state, pending approval/input, or a
   replaced adapter takes precedence. If the user explicitly wants to resume after
   Stop, use a same-session
   SEND; only confirmed native delivery may advance the cancelled session. Ordinary
   reads never resume Stop.
6. Treat cancellation as cooperative and poll for the resulting state. If a SEND
   returns `submission_unknown`, retry the exact same call with the same
   `clientRequestId`, session and message, including its saved `observationCursor`
   to read current progress after delivery settles. Do not send a new message or create a
   child to bypass the unknown outcome. A later Stop wins. If a SEND returns `busy`
   or another definite error, preserve that result and inspect the same session; do
   not bypass it with a new request ID, resume, or child.
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

## App Builder web implementation

For App Builder web-workflow changes, keep authenticated mutations server-first. Use a strict, typed Server Action with `useActionState` for provider continuation, durable draft acknowledgement, and handoff creation. The action, not client code, owns validation, tenant authority, provider ordering, idempotency, and the terminal result. Client leaves may only render that result and perform browser-only effects such as SSE display, clipboard, custom protocol launch, popup behavior, and post-success navigation.

Read [Server Action continuations](references/server-action-continuations.md) before changing these flows. Preserve Better Auth and opaque handoff boundaries; never substitute browser loopback requests or client-supplied authority for an authenticated Server Action.
