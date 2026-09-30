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

## Request-time reads in new apps

Before implementing a request-dependent route, read the prepared repository's
native Next contract and the installed framework guides. Keep the page/layout
shell synchronous; render an async Server Component inside a narrow
`<Suspense fallback={...}>` and perform request-time reads inside that child.
This includes `await connection()`, authentication/session lookup, `cookies()`,
`headers()`, and uncached tenant/database reads. Pass unresolved `params` and
`searchParams` promises into the child and await them there. A read performed
before returning the boundary is still outside it; wrapping the returned JSX
or adding a descendant `loading.tsx` does not contain that earlier read.

Use a meaningful fallback that exposes no protected data. Keep authorization
before protected reads and mutations inside the request-scoped server boundary,
including after Server Actions and redirects. Do not cache session or tenant
state to suppress an error, disable Cache Components as a default workaround,
or move authorization into the browser.

Verify the initial request and client navigation render the actual heading and
form beyond the fallback, then exercise the mutation and its redirect destination
with independent persisted readback. Inspect runtime diagnostics as well as
visible results: a passing build, HTTP response or committed row does not prove
the destination rendered. Preserve failures and mark later unexercised outcomes
unassessed when the supported observation capability is unavailable.

## App Builder execution boundary

In the App Builder runtime, these upstream skills are design and verification
guidance, not permission to run their shell, browser, or package-install steps.
Keep work inside the Builder's typed plan, apply, and validation operations.
In a native Arrusted repository session, use its documented `mise` entrypoints
and test conventions.
