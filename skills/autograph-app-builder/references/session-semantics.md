# Session semantics

- `sessionId` is the public durable session handle. Never expose a continuation credential.
- `autograph_get` without `sessionId` lists the caller's recent sessions. Use it
  before starting duplicate work when the user asks to continue or resume.
- User-facing handles do not expire because a compute lease elapsed. Active
  execution leases and start-admission windows remain bounded independently.
- Resume a selected session with `autograph_start` and `resumeSessionId`.
  Healthy active work keeps its handle. Terminal or interrupted work may resume
  as a child from its last durable checkpoint.
- `cursor` is the next unread absolute event index. Pass it back to `autograph_get`.
- `input_required` means the exact outstanding request must be answered before an unrelated follow-up.
- An `authorization` input remains parked until the provider callback settles;
  it is never answered with `autograph_respond`. Refresh the same session after
  the user returns, and rely only on the server's access re-read.
- `waiting` means the current turn settled and the session may accept a follow-up.
- `cancelled` proves a turn reached its cancellation boundary; a later `waiting` event makes the session resumable again.
- Only allowlisted public events are evidence. Internal reasoning, raw tool data, and traces are not user-visible proof.
