# Session semantics

- `sessionId` is the public durable session handle. Never expose a continuation credential.
- `autograph_get` with `sessionId` inspects that session. Use the exact handle
  already established in the conversation; discovery and selection are needed
  only when the session is unknown or ambiguous. Without `sessionId`, it lists
  the caller's recent sessions. Do not start duplicate work to continue a session.
- User-facing handles do not expire because a compute lease elapsed. Active
  execution leases and start-admission windows remain bounded independently.
- Resume a selected session with `autograph_start` and `resumeSessionId`.
  Healthy active work keeps its handle. Terminal or interrupted work may resume
  as a child from its last durable checkpoint. For an explicit continuation of
  stopped work, use `autograph_send` on the same session as described below.
- A web handoff begins with `autograph_start` and its opaque `handoffId`. The
  server binds the first successful redemption to one session, so retrying a
  lost response returns the same session rather than creating duplicate work.
- `cursor` is the next unread absolute event index. Pass it back to `autograph_get`.
- `input_required` means the exact outstanding request must be answered before an unrelated follow-up.
- An `authorization` input remains parked until the provider callback settles;
  it is never answered with `autograph_respond`. Refresh the same session after
  the user returns, and rely only on the server's access re-read.
- `waiting` means the current turn settled and the session may accept a follow-up.
- `cancelled` proves a turn reached its cancellation boundary. Ordinary
  `autograph_get` calls never resume Stop. When the user intends to resume,
  a new explicit `autograph_send` may continue the same session once the server
  proves its accepted native delivery. A later Stop takes precedence over that
  SEND; an earlier acknowledgement alone never gains resume authority.
- If SEND returns `submission_unknown`, preserve the session, message and
  `clientRequestId` and retry that exact call. The server reconciles its existing
  delivery without sending the message again. Do not use a new request ID or a
  child session to bypass the unknown outcome.
- Only allowlisted public events are evidence. Internal reasoning, raw tool data, and traces are not user-visible proof.
