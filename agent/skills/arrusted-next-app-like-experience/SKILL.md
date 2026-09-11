---
name: arrusted-next-app-like-experience
description: Apply Vercel's Next.js 16.3 app-like navigation and mutation patterns to a native Arrusted Next App Router zone. Use when creating or evolving that zone; do not use for Vite, Gateway, or cross-zone routes.
---

# Arrusted Next app-like experiences

Use this adapter for an Arrusted application's native Next App Router zone only.
Keep Gateway and Vite routes as their own boundaries; a cross-zone navigation is
a document navigation, not an App Router transition to optimize.

## Choose the published workflow

- Use `next-cache-components-adoption` first when turning on or completing a
  Cache Components migration. This product adopts it directly: fix the route
  instead of leaving `export const instant = false` as a broad escape hatch.
- Use `next-partial-prefetching-adoption` after Cache Components works to
  preserve the shared shell and audit the small set of links that genuinely
  need URL-specific prefetching.
- Use `next-cache-components-optimizer` only for a selected navigation whose
  instant shell is a product requirement; do not fabricate `instant()` tests
  or blanket `prefetch={true}` props.
- Use `next-dev-loop` for a native target app's running-app verification.

## Product constraints

- Enable `cacheComponents` and `partialPrefetching` for supported new Next
  templates. Keep request-specific reads below narrow Suspense boundaries and
  cache only data safe to share; session and user data stay request-scoped.
- Match a completed mutation to its cache invalidation. Use optimistic UI only
  where the user has made a real mutation and rollback semantics are clear.
- Prefer server-rendered initial state. Add browser data fetching only for an
  ongoing browser-side synchronization need.
- Use View Transitions only when the interaction benefits visually and it
  remains accessible, including reduced-motion behavior.
- Do not enable or ship `useOffline` in production.

## App Builder execution boundary

In the App Builder runtime, these upstream skills are design and verification
guidance, not permission to run their shell, browser, or package-install steps.
Keep work inside the Builder's typed plan, apply, and validation operations.
In a native Arrusted repository session, use its documented `mise` entrypoints
and test conventions.
