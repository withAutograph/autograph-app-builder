---
name: arrusted-next-app-like-experience
description: Apply Vercel's Next.js 16.4 app-like navigation and mutation patterns to a native Arrusted Next App Router zone. Use when creating or evolving that zone; do not use for Vite, Gateway, or cross-zone routes.
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
- Use `next-partial-prefetching-optimizer` for a chosen navigation that should
  reuse prefetched or previously visited content. Define the user-visible
  target first; tune richer prefetches for fixed links versus hover/focus/touch
  intent in long lists.
- Use `next-dev-loop` for a native target app's running-app verification.

## Product constraints

- Enable `cacheComponents` and `partialPrefetching` for supported new Next
  templates. Keep request-specific reads below narrow Suspense boundaries and
  use shared caches only for data safe to share. Personalized server-rendered
  DTOs can use `use cache: private` with an explicit product-specific browser
  freshness window; session authority and command checks stay request-scoped.
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

## Cache Components and navigation in 16.4

Keep persistent navigation in layouts and request-dependent reads below narrow
Suspense boundaries. Resolve route promises there, and preserve the surrounding
heading and stable geometry as sections stream. Server Components read minimal
DTOs through the app's server-only DAL; Server Actions validate browser input,
authorize the mutation again, and invalidate affected tags/paths after persistence.
Generated apps keep that single data boundary under `app/data/`; no separate
backend service, generic operations getter, or self-HTTP read is needed.

Choose cache lifetime and identity with the actual feature. Plain `use cache`
and remote caches may share results; private caches retain personalized output
in browser memory. Never put submission tokens or connection-specific work in
a cache. Test tenant/account switching and refresh cached views on session
changes. Use `updateTag` for read-your-writes actions; `revalidatePath` refreshes
affected paths. Other users' browser views can remain stale within the chosen
window, so cached UI must never authorize a command.

Default Link prefetching prepares the reusable shell. Use `prefetch={true}` for
a small fixed set of useful URL-specific destinations; for large lists, start
richer prefetching on hover, focus, or touch. `navigation()` from `next/cache`
can defer expensive secondary content until navigation while a nearby fallback
is prefetched. Call it outside cached functions, above the deferred read; it
is not a replacement for authentication or a blanket route opt-out.

React 19.3's stable ViewTransition can animate a meaningful content replacement
or reveal. Keep persistent chrome and urgent form feedback outside the boundary,
use short motion, honor reduced motion, and preserve ordinary navigation in
unsupported browsers. Keep interaction leaves small; the pages remain server-rendered.

The optional `ensureStatic` route setting and `instant()` testing helper are
feature-specific tools, not mandatory gates for every generated route. The
starter remains a skeleton without a sample workflow, schema receipt, or
preselected caching policy. Improve the completed app through Builder.

References:

- [App-like experiences with 16.3](https://nextjs.org/blog/building-app-like-experiences-with-nextjs-16-3)
- [16.4 navigation improvements](https://nextjs.org/blog/improving-navigation-experience-in-v0-with-nextjs-16-4)
- [Next.js 16.4](https://nextjs.org/blog/next-16-4)
- [Private caches](https://nextjs.org/docs/app/api-reference/directives/use-cache-private)
- [navigation](https://nextjs.org/docs/app/api-reference/functions/navigation)
