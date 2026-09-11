# Server Action continuations

When implementing or changing the App Builder web workflow, use this contract for provider setup, durable drafts, handoffs, and other authenticated writes.

- Put the mutation in a dedicated `"use server"` module. Validate the complete serializable input with a strict schema at the action boundary.
- Authenticate and resolve tenant authority on the server. Client input may name an opaque resource but never proves user, workspace, provider, or credential authority.
- Return a compact discriminated, serializable result such as `{ status: "ready", ... } | { status: "error" }`. Do not return credentials, cookies, raw provider responses, or database records.
- Use `useActionState` in a narrow client leaf. The action receives the prior state first; dispatch object payloads inside `startTransition` and use the hook's pending/result values instead of wrapping dispatch in a promise.
- Keep an ordered workflow in one action. App Builder's provider continuation reserves and provisions GitHub before Vercel, then creates the durable opaque handoff. A selected-provider retry dispatches that same continuation action; never coordinate multiple provider mutations in client code.
- Reuse durable services and their idempotency keys, journals, and leases. Calling an in-process deployment handler is acceptable when it preserves Better Auth and provider boundaries; browser loopback `fetch` is not.
- Client code is limited to browser-only effects: SSE display, clipboard, custom-protocol launch, popup/window behavior, and navigation after a typed successful result. SSE observes persisted state; it does not run work.

See the repository's `docs/server-action-continuations.md` for the complete contract and verification matrix when working in the App Builder repository.
