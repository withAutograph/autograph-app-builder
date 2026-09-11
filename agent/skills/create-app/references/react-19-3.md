# React 19.3: optional app improvements

React 19.3 features improve an app only when they serve a specific product
interaction. Do not apply them globally, add motion for its own sake, or alter
an existing app merely to use a new API.

## View Transitions

Use `ViewTransition` only around a product-owned state or navigation change
where continuity helps people understand what changed: a detail panel opening,
a drawer replacing a list, a step change, or a route-level content swap.

- Prefer a Server Component boundary for App Router route content. Route
  navigation already activates the transition, so no client state wrapper is
  necessary. With `Suspense`, put `ViewTransition` around the resolved content
  and leave the loading fallback outside it.
- For a local client state update, mark only that non-urgent update with
  `startTransition`.

- Keep the boundary narrow: transition the changed content, not the application
  shell, urgent feedback, form validation, or a long-running operation.
- Honor `prefers-reduced-motion: reduce` by rendering the same update
  immediately. Feature-detect browser support and use the existing instant
  rendering path when it is unavailable.
- With `Suspense`, show the fallback immediately and animate only its update to
  resolved content (`default="none" update="auto"`). Do not animate cached
  content that already appears instantly.
- Do not introduce global route animation, and do not wrap arbitrary generated
  components automatically.

## Server/client boundaries

`use(browser())` is for a client component that cannot produce meaningful
server HTML, such as one that must read browser-only state. Put it under a
meaningful `Suspense` fallback. Prefer passing a server-derived default when
one exists; do not use `browser()` as a general replacement for server
rendering.

Use a Fragment ref only when a multi-node component needs group focus,
visibility observation, measurement, or scrolling without adding a layout
wrapper. Render a client-exported Context directly from a Server Component only
when it replaces a provider whose sole job is passing a server value through.

## Trusted Types: disabled-by-default CSP recipe

React 19.3 preserves `TrustedHTML`, `TrustedScript`, and `TrustedScriptURL`
objects rather than coercing them to strings. This makes Trusted Types
compatible with React DOM; it does not make untrusted markup safe.

Do not enable `require-trusted-types-for 'script'` by default. An app may opt
in only after it defines an app-owned Trusted Types policy backed by a reviewed
sanitizer, applies a CSP that names that policy, and verifies every affected
DOM injection path. Keep using normal React rendering wherever possible; do
not introduce `dangerouslySetInnerHTML` to exercise this capability.
