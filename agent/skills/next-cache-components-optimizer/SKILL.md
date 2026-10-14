---
name: next-cache-components-optimizer
description: >
  Drive a Next.js route to instant navigation by setting up an agentic loop,
  under Cache Components / PPR, on initial load (hard navigation) and
  client-side navigation (soft navigation). Use focused behavior checks and an
  existing @next/playwright instant() test when available. Use when asked to make
  a route's navigation instant (its static shell commits immediately), fix a
  route whose static shell isn't prerendered/served/prefetched, grow a route's
  static shell or fix its slow first paint, diagnose which Suspense boundary
  keeps a route out of its static shell, or write the instant() e2e guard for
  one. The examples use Next.js 16.3+ with Cache Components when available.
---

# next-cache-components-optimizer

Use focused evidence to improve a requested route's initial or client-side
navigation. An existing `@next/playwright` `instant()` test can be a useful
regression check, but adding a test rig or reaching a staged RED/GREEN sequence
is optional. Reuse current tests and runtime observations; don't block source
edits on optional infrastructure or per-route builds. The phases below are
diagnostic examples, not mandatory gates. Fix recipes live in two lazily-read
references — `reference/patterns.md` (before→after for each blocker type) and
`reference/real-app-patterns.md` (parallel routes, auth gates, the empty-shell
and responsive-skeleton failure modes). Read one only when its phase points
there.

## project policy and scope

Use this skill only for a requested navigation optimization or diagnosis. The
repository's local-development and focused-validation policy takes precedence:
no incidental source shape, app layout, framework version, cache state,
receipt, or exact tool shape gates unrelated work. CI should check relevant
functionality and security properties rather than implementation shapes. Do
not install tools, upgrade Next.js, create a rig, or run a build just to satisfy
this optional workflow. If the project's supported behavior cannot be checked
with available tools, continue independent source work and report the evidence
limit. Preserve auth and authorization behavior, tenant isolation, credentials,
and approval boundaries.

## What is invariant, and what is yours

One thing here is fixed. The rest is yours. Read this before treating any
command, platform, or env var below as a requirement.

- **Goal: verify the changed experience.** Confirm that the intended shared
  content appears promptly and deferred content still resolves correctly. Use
  the project's relevant tests or a focused runtime observation when available.
  `instant()` under a dynamic-data lock is one strong automated signal; do not
  add a rig solely to obtain it or treat it as a prerequisite for source edits.
- **One optional mechanism: `@next/playwright` `instant()`.** This skill uses
  [`instant()`](https://nextjs.org/docs/app/guides/instant-navigation#prevent-regressions-with-e2e-tests)
  as a ruler, not a stopwatch (phase A). It comes from
  `@next/playwright` (installed alongside `@playwright/test`, on the same
  release line as `next`), so it isn't tied to any host. Reuse it when
  available. A focused runtime observation is still useful when the test
  helper or rig is unavailable.
- **Optional rig.** How you build, deploy, authenticate, configure
  Playwright, and loop belongs to your stack, not to this skill. A local
  `next build && next start`, a CI/staging container, and a per-push preview
  deploy are equally valid rigs; report which environment was observed. Read every platform
  name, env-var spelling, and command below as an example to translate, not a
  requirement.

## Two navigations, two loading states

A route reaches the user two ways, and both must be instant:

- **Initial load (hard navigation)** commits the route's prerendered static
  shell; deferred parts stream in behind their loading skeletons (Suspense
  fallbacks, `loading.tsx`).
- **Client-side navigation (soft navigation)** commits the destination's
  prefetched App Shell — the `<Link>` default under Partial Prefetching —
  re-rendering only the segments that change.

The fix patterns are identical for both; the test differs only in how the
navigation is driven ("Driving the navigation in tests" below). The two shells
can differ; guard the one you ship, both when both matter
(`reference/real-app-patterns.md`).

## Intended behavior

The goal is for meaningful shared content to commit promptly while genuinely
per-request data streams afterward. A passing `instant()` assertion alone can
accept a blank shell, so inspect the actual user-visible result when the
available runtime allows it.

When an existing `instant()` rig is used, it checks shell availability rather
than elapsed time. Production behavior differs from `next dev`; distinguish
which environment was observed and avoid claiming production prefetch behavior
from development-only evidence.

Use the checks that fit the changed behavior and report their scope.

## Reporting to the user

Work on the navigation the user named. Use the available evidence without
installing optional infrastructure or pausing for each internal phase. Report
the observed behavior and any limits plainly.

- **Speak their language.** Describe the gap and the result in terms of what the
  user sees: "navigating to the dashboard waited on the charts query before
  anything painted; now the layout and skeletons paint instantly and the charts
  stream in" — not RED/GREEN, the lock, or the phase letters.
- **Show, don't tell.** When you report a route, drive the browser (or attach
  before/after screenshots) so the user watches the shell commit immediately and
  the data stream in, rather than reading a claim. Identical before and after
  means the fix did nothing — roll it back.
- **Present a run as a list of results the user can click through** — one line
  per navigation: the route, what commits instantly, and what streams in — not a
  transcript of the loop.
- **Only surface a question for a genuine fork:** a fix that would change
  behavior, a security-sensitive read, or a route that's dynamic by design (a
  per-link-prefetch candidate, not a shell to grow). A clean instant fix is not
  a fork — keep going. With no one to ask (an unattended run), don't block: take
  the safe default and note the assumption — for a cache-freshness choice,
  defer the read behind `<Suspense>` (always fresh, still instant) rather than
  guess a `cacheLife`.

## The workflow

```
- [ ] Inspect the route and relevant existing tests or runtime evidence.
- [ ] Make the focused change; preserve data, loading, error, and auth behavior.
- [ ] Verify the affected behavior with an available focused check.
- [ ] Report the check used and any behavior that remains unverified.
```

The phase details below explain optional test techniques for projects that
already have a suitable production-like rig.

---

## Optional feature capabilities: Next.js with Cache Components

The workflow depends on framework capabilities that ship with current Next.js:

- **Next.js 16.3+ with `cacheComponents: true`** in `next.config.ts`. Without
  Cache Components there is no static shell to optimize.
- **`@next/playwright`** on the same release line as the project's `next`; it
  provides `instant()`. Verify with `npm ls next @next/playwright` (or the
  project's package manager) and align them if they differ. The matching
  testing API is in the `next` runtime, gated by the
  `experimental.exposeTestingApiInProductionBuild` config flag (phase A).

If an explicitly requested optimization needs capabilities the project does
not have, explain the feature-specific limitation. Ask before a dependency
upgrade; do not upgrade to run this optional skill, and continue unrelated
source work. For an authorized migration, version-matched upgrade guidance is
available via the link above.

```ts
export default { cacheComponents: true };
```

When the user requests enabling the flag, it surfaces the blocking routes to
resolve as part of that migration. The
[`next-cache-components-adoption`](https://github.com/vercel/next.js/tree/canary/skills/next-cache-components-adoption)
skill describes that migration. For a route optimization, use the feature only
if already supported; a missing capability is not a gate for other edits.

The test recipes below are specific to the framework versions they describe.

## Optional setup: reuse an existing test rig

If the repository already has an `instant()` rig or rig notes, reuse them. Do
not add a committed rig file as a prerequisite. The six example questions
(BUILD / EXPOSE / RUN / TEST USER / DRIFT / LOOP), the template, and filled
examples (local-only, generic CI + container, preview deploy) are in
**`rig-template.md`**.

If there is no suitable Playwright harness, use existing project checks or a
focused manual observation when available. Do not create new test
infrastructure just to continue the route edit.

## A. Optional `instant()` test setup

If an existing `instant()` rig is available, use it for this particular signal.
Its results are meaningful only when these details hold:

1. **Never measure on `next dev`.** It does not prefetch, and its lock is
   unreliable for blocking routes, so a dev `instant()` result is not a valid
   RED or GREEN.
2. **The measured build must expose the testing API.** Otherwise `instant()`
   silently no-ops and the test passes vacuously (see
   `reference/red-test-robustness.md`). The lock-engagement proof is the phase-C
   RED itself: the unfixed target route is the known-blocking route, and its
   RED under the lock shows the lock engages on this build; the
   self-validating variant in `test-template.md` is the in-band guarantee. Wire
   `experimental.exposeTestingApiInProductionBuild` to a condition that is
   true for every build you measure and never true in production:

   ```ts
   experimental: {
     // Use the condition your platform provides, and record it in the rig file:
     //   local:       an explicit opt-in, as below
     //   generic CI:  process.env.DEPLOY_ENV === 'staging'
     //   Vercel:      process.env.VERCEL_ENV === 'preview'
     exposeTestingApiInProductionBuild:
       process.env.EXPOSE_TESTING_API === '1',
   }
   ```

An existing rig may be any production-like build that exposes the testing API: a local
`next build && next start`, a CI/staging container, and a preview deploy are
all equally valid; the verdict comes from the build, not the platform. See
`rig-template.md` for filled examples.

For a deployed or remote build, use its available liveness evidence to establish
which artifact was observed. A local `next build && next start` needs no remote
probe. If the artifact identity is uncertain, report that limit rather than
using the result as proof.

## B. Optional unlocked comparison

If using an existing `instant()` rig, drive the real navigation with no lock and assert that the
destination's `SHELL_MARKER` renders **as the test user**: the account the
e2e suite authenticates as (in CI, the CI account; locally, your e2e login
fixture), with its flags, plan, role, and data. This establishes that the
marker is real and reachable: not flag-gated, not redirected away, not a
guessed selector. The suite runs as the test account, not the author's session;
that environment drift can make test results misleading. See
**`test-template.md`** for example scaffolding; do not add it just to continue
source work.

## C. Optional locked test

When the existing rig supports it, wrap the same navigation in `instant()` to
check whether the shell commits under the lock. A failing result can help
locate the gap; it is one verification option, not a prerequisite.

Prefer the self-validating variant when the route has deferred content. If the
route cannot build while blocked, or a cookie/session read stays GREEN, use the
RED recipes in `reference/red-test-robustness.md`.

Treat a RED as a diagnostic: confirm it concerns the changed route and target
behavior before using it to guide a fix. If the rig is unavailable, continue
with other relevant evidence.

When a test result is ambiguous, compare the unlocked behavior for the same
test user and inspect the failure causes in
**`reference/red-test-robustness.md`**. Use this to improve confidence, not as a
stop condition for independent work.

---

## D. FIX: push each boundary down to the data it guards

**The anti-pattern: one coarse boundary.** A single `<Suspense>` high in the
tree with a page-level fallback has three costs:

- The layout UI stays out of the static shell: only a throwaway copy of it is
  prerendered.
- The entire subtree is replaced when the boundary resolves, which discards
  client state and shifts layout.
- The hand-built fallback drifts out of sync as the UI changes, because it
  duplicates structure that also exists in the resolved tree.

**The fix: hoist the static, push the Suspense down.** Render the layout UI
once, synchronously, in the shell, and wrap each await in a boundary scoped to
the single read it guards. Only that leaf streams; the stable ancestors are
reused as-is.

**Rule:** if an element renders in both the fallback and the resolved tree,
hoist it above the boundary.

### The most common blocker: a top-level `await` in a layout on a fallback route

```
app/[locale]/(app)/[tenant]/dashboard/...
       │ generateStaticParams ✅   │ no generateStaticParams → fallback route
```

When any dynamic segment in the route lacks `generateStaticParams`, the route
is a fallback route, and **all** params defer to request time, including the
enumerated ones. A top-level `await` in a layout (`await params`, a
request-time session read, an auth gate) then blocks the whole subtree out of
the static shell, even when it reads a statically known param. Minimal shape: a
dynamic-segment route with one segment lacking `generateStaticParams`, plus a
top-level `await` in the layout above it.

### The fix: defer the gate, render children

Render `children` unconditionally; move the top-level `await` into a
`<Suspense fallback={null}>`-wrapped child. Mechanism and before→after:
`reference/real-app-patterns.md`, "Deferring an auth gate".

**Fix the page below the shell too, not only the layout.** A page-level
top-level `await` (commonly `await params`) blocks the same way the layout's
does, so make the page sync and push its dynamic reads into a
`<Suspense>`-wrapped leaf as well. `fallback={null}` is correct only when a gate renders nothing on
success; for data, the fallback must be a real loading skeleton (see D1).

Every other blocker shape — `cookies()`/`headers()`, uncached fetch or database
reads, `searchParams`, metadata, viewport, non-deterministic values (`Date.now()`,
`Math.random()`, `crypto.randomUUID()`) — surfaces its own insight when you hit
it: the build prints a `https://nextjs.org/docs/messages/<slug>` link. The
default build output is often abbreviated and may carry no usable stack trace;
add `--debug-prerender` for the full failing frame and to report every blocker
past the first. Scope the build to the route you're on with
`next build --debug-build-paths "app/<route>/**"` rather than rebuilding the app.
Open that page and apply its recipe; don't improvise from the inline message.

The before→after recipe for each shape is in `reference/patterns.md`, which maps it to the insight
that explains it.

A few things those per-error pages don't stress for the instant-navigation goal:

- **A boundary in the root layout isn't enough for client navigations.** It
  passes a page-load check but leaves sibling client navigations blocking; put
  the boundary below the lowest layout the source and destination routes share.
- **Keep the LCP element** (usually the main heading) out of any boundary, so it
  paints in the shell instead of waiting on a stream.
- **A green check isn't always instant.** `export const instant = false` opts
  the segment out of validation while the navigation still blocks, and a
  `<Suspense>` above the document `<body>` prerenders an empty shell — neither
  makes the route instant.

### D1: reuse the route's existing loading UI; do not hand-build skeletons

Before writing any skeleton, search the repository for the loading UI that
already exists for this route, in order:

1. the route's `loading.tsx`;
2. an exported `*Skeleton` colocated with the component;
3. the fallback already inside the component's own `<Suspense>`.

The **divergence point** is the lowest layout shared by the source and
destination routes: a soft navigation re-renders only the segments below it,
while an initial load re-runs every layout from the root. (Also called the
shared boundary.) A `loading.tsx` above the divergence point fills only
the initial-load shell; it sits above the soft-nav re-render scope. A
`loading.tsx` at the destination segment is itself the in-tree boundary for a
soft navigation into that segment and serves both. Reuse whichever boundary
actually covers the navigation you are shipping; below the divergence point,
`loading.tsx` and colocated skeletons are interchangeable for that purpose.

If a component has no skeleton, extract its loading markup into a colocated
skeleton beside it. Do not author a fresh skeleton that mirrors the page
layout: it duplicates structure, drifts as the page changes, and pulls the
design back toward a single coarse boundary. Reusing the component's own
skeleton also keeps the prefetched shell consistent with the loaded UI.

See: [Streaming](https://nextjs.org/docs/app/guides/streaming#push-dynamic-access-down)
and [loading states](https://nextjs.org/docs/app/guides/instant-navigation#iterate-on-loading-states).

Exception: if the deferred component renders `null` for some users (for
example, a flag-gated control), `fallback={null}` is correct, since a skeleton
would flash and then collapse.

### D2: the shell should match the real render while resizing

A skeleton frozen to one breakpoint misaligns on the others. Fix it the same
way: one responsive component renders both the live UI and the shell (D1
skeleton in its data slots), so the breakpoint switch happens once. Where
useful, inspect it at two desktop window sizes (for example, 1280 and 900 pixels
wide) to confirm it remains usable while resizing. Do not add phone/tablet
acceptance or a separate viewport project. Detail:
`reference/real-app-patterns.md`.

If an existing locked test covers this behavior, use its result as one signal.
Otherwise, use an available focused runtime check and report its scope.

**When URL data can't be pushed down** (for example, the whole page depends on
`params`, `searchParams`, or the full URL), there may be no meaningful static
shell to grow. Don't force one. Per-link prefetching can make the soft
navigation instant, but it is outside this optimizer loop: it requires Partial
Prefetching, a `<Link prefetch={true}>`, and cached URL-dependent content. See
[Optimizing prefetching](https://nextjs.org/docs/app/guides/optimizing-prefetching)
and pattern 10 in `reference/patterns.md` for the requirements, cost trade-offs,
manual prefetch caveat, and `instant()` test gotchas.

## E. PARITY: the refactor changed only whether the route is instant

The push-down is a focused transform, not a redesign. Preserve the user's
expected content, data, ordering, empty and error states, redirects, and
interactions; structure may change as needed while keeping the experience and
authorization guarantees intact. Use these as behavior checks where relevant:

- **Same render output.** The moved `await`s compute and return the same
  values; after the stream, the route shows the same content as the base
  branch for the test user.
- **Side effects still fire.** A deferred `redirect()` or `notFound()` still
  happens, at request time rather than during prerender. Confirm an
  unauthorized user is still redirected and a missing record still returns 404.
- **Both viewports reach the real UI** after the stream (D2).
- **Client state survives.** Because the layout UI is hoisted into the stable
  shell rather than swapped on resolve, open menus, scroll position, focus,
  and input state persist across the stream.
- **Pre-existing failures stay separate.** If the route errors after the
  change, reproduce it on the base branch. The same failure there is an
  environment or data problem, not an optimizer regression.

If anything other than whether the route is instant changed, reduce the refactor.

## F. Optional differential check

When an existing rig makes this inexpensive, compare behavior before and after
the focused fix. A fresh revert-and-reapply test or deployed rig is not required
to continue or report the change. For remote results, identify the observed
artifact when that evidence is available.

## G. REVIEW (PR checklist)

Use these questions to review a requested optimization when they apply; they
are not source-shape or CI gates:

- [ ] **Behavior preserved**: same content, redirects, and state.
- [ ] **Loading UI considered**: reuse existing loading UI where suitable.
- [ ] **Resizing considered**: the desktop layout remains usable while resized.
- [ ] **Evidence described**: checks run and any limitations are stated.

Finish with the repository's normal focused validation and report any requested
behavior that could not be confirmed. Do not hold independent work for optional
test scaffolding or differential runs.

## Driving the navigation in tests

- **Soft navigation** → drive a real `<Link>` click. **Initial load** → use
  `page.goto()` inside `instant()` with the `baseURL` option. Do not substitute
  `goto` for a soft-nav verdict; the two shells can differ
  (`test-template.md`, `reference/real-app-patterns.md`).
- With parallel routes, only the slots that change re-render on a soft
  navigation; client-rendered navigation UI does not re-render at all. Do not
  chase a slot the navigation never touches
  (`reference/real-app-patterns.md`).

## Files

- `rig-template.md`: phase 0, the six-question rig discovery, the
  `instant-nav.rig.md` template, and filled examples (local-only, generic CI,
  preview deploy).
- `test-template.md`: example `instant()` specs for both navigation types and
  an optional baseline scaffold.
- `reference/red-test-robustness.md`: optional test diagnostics. The taxonomy of
  untrustworthy REDs, the checklist, the differential recipe, the vacuous-pass
  failure mode, and worked cases.
- `reference/real-app-patterns.md`: parallel routes, deferring an auth gate,
  initial-load vs soft-navigation shells, the empty-shell failure mode, the
  responsive-skeleton mismatch, edge cases.

## After optimization

Once the target routes are instant, check whether the app has already adopted
Partial Prefetching (`partialPrefetching: true`, or the relevant destination
still uses `prefetch = 'partial'` during an incremental rollout).

Make that check mechanically:

```bash
rg -n "partialPrefetching|prefetch\s*=\s*['\"]partial['\"]" --glob 'next.config.*' --glob 'app/**' --glob 'src/app/**'
```

If `partialPrefetching: true` is in config, the app is globally adopted. If only
`prefetch = 'partial'` matches, treat those destination segments as adopted
during an incremental rollout and keep checking any other target routes.

- **Already adopted:** for any URL-data route that stopped at the limitation
  above, consider a targeted `<Link prefetch={true}>` on the links where having
  that URL-specific content ready before the click is worth the per-link server
  work. Keep the default link behavior everywhere else so the shared App Shell
  remains the low-cost baseline.
- **Not adopted yet:** recommend
  [`next-partial-prefetching-adoption`](https://github.com/vercel/next.js/tree/canary/skills/next-partial-prefetching-adoption).
  That skill moves the app onto the better prefetching model: shared App Shell
  prefetches by default, fewer duplicated full-prefetch requests for visible
  links, a link audit for existing `<Link prefetch={true}>` usage, and optional
  per-link prefetching only where URL-specific content is worth the
  extra server work.
