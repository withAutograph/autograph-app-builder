# Session semantics

- `sessionId` is the public durable session handle. Never expose a continuation credential.
- `cursor` is the next unread absolute event index. Pass it back to `autograph_get`.
- `input_required` means the exact outstanding request must be answered before an unrelated follow-up.
- `waiting` means the current turn settled and the session may accept a follow-up.
- `cancelled` proves a turn reached its cancellation boundary; a later `waiting` event makes the session resumable again.
- Only allowlisted public events are evidence. Internal reasoning, raw tool data, and traces are not user-visible proof.
