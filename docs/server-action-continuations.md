# Server Action continuations

App Builder keeps durable provider and handoff mutations on the server. A client component may initiate a continuation and render its progress, but it does not sequence provider mutations, authorize a tenant, or invent terminal workflow state.

## Continuation contract

Put a continuation in a dedicated `"use server"` module. Its public boundary accepts only serializable data and returns a compact discriminated result:

```ts
type ContinuationState =
  | {
      status: "ready";
      provisioning: BuilderProvisionResponse;
      handoff: Handoff;
    }
  | { status: "error" };

export async function continueBuilderHandoff(
  previous: ContinuationState | undefined,
  input: unknown
): Promise<ContinuationState> {
  // validate, authorize, run durable operations, return a safe result
}
```

`previous` is required when the action is consumed through React `useActionState`. Do not make a client wrapper that reconstructs the same provider sequence with `fetch`, several Server Actions, or local timers.

At the server boundary:

1. Parse the complete untrusted input with a strict schema before calling a deployment or provider service.
2. Derive authentication and tenant authority from the request on the server; never accept a user, workspace, installation authority, or credential from the client as proof.
3. Reuse the durable provisioning and handoff services used by route handlers. Provider work remains idempotent through request IDs, journals, and leases.
4. Preserve ordering. GitHub reservation/provisioning completes before a linked Vercel continuation; create the opaque handoff only after the durable provider outcome is known.
5. Return only UI-safe, serializable state. Do not return raw provider payloads, cookies, tokens, authorization headers, or database records.
6. Represent expected validation, provider, and handoff failures as a typed terminal state. Reserve thrown exceptions for unexpected faults and map them to a safe terminal result at the action boundary.

The action may invoke a deployment handler directly to preserve the existing Better Auth and provider boundary, but it must not make a loopback browser request or rely on client-provided authorization.

## React ownership of action state

Use `useActionState` in the narrow client leaf that needs the result. For an object payload rather than a native form submission, dispatch in a transition:

```tsx
const [continuation, dispatchContinuation, pending] = useActionState(
  continueBuilderHandoff,
  undefined
);

startTransition(() =>
  dispatchContinuation({
    version: 1,
    requestId,
    creationRequestId,
    provisioningEnabled,
    form,
  })
);
```

Use `pending` to disable duplicate controls and show progress. React owns the dispatch/result lifecycle; do not wrap the dispatch in a promise or treat a locally predicted value as the server result. When `status === "ready"`, use the returned handoff and provisioning snapshot as the authoritative state. When it is `error`, keep the retry affordance local but dispatch the same action again with a fresh continuation request ID where needed.

The initial handoff and a selected-provider retry both use `continueBuilderHandoff`. Retrying must not call a separate client-side provisioning function and then create a handoff in a second mutation.

## Browser boundaries

Client leaves remain appropriate for rendering SSE snapshots, clipboard access, custom-protocol launch, popup/window behavior, and route navigation after a successful result. SSE reports durable journal state; it is never a background job runner. A same-origin `keepalive` route is permitted only for page-hide draft recovery, because Server Actions cannot provide keepalive transport.

## Verification

Cover the action's strict schema rejection, tenant authority, ordered GitHub/Vercel work, idempotent retry, and safe error result in unit tests. Component tests should assert `useActionState` pending/error/ready behavior. Browser coverage should prove provider retry does not duplicate provisioning or handoffs, and that recovery can reload a durable handoff.
