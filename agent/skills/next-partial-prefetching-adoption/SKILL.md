---
name: next-partial-prefetching-adoption
description: >
  Turn on Partial Prefetching in a Next.js app and work through the
  insights it surfaces. Use when the user wants to enable or adopt
  Partial Prefetching, flip the `partialPrefetching` flag, opt routes
  in with `export const prefetch = 'partial'`, audit
  `Link prefetch={true}` behavior, preserve existing prefetched UI
  with `instant()` tests, or resolve the
  instant-link-prefetch-partial and instant-shell-url-data insights.
---

# next-partial-prefetching-adoption

## project policy and scope

Use this skill only when the user asks to adopt or debug Partial Prefetching.
The repository's local-development and focused-validation policy takes
precedence for unrelated edits: this feature's route inventory, optional test
rig, framework versions, build artifacts, cache state, receipts, and exact
source shapes are not general work or CI gates. Reuse existing evidence and
check changed user-visible behavior with the most focused available method.
An absent optional browser, rig, or baseline does not block source edits; report
what could not be verified. Preserve authentication, tenant isolation,
credential handling, and approval boundaries.

Enable Partial Prefetching and walk the app until every link reuses a shared App Shell. This skill sequences the work; per-insight recipes live in the dev overlay fix cards and their docs pages. The [Adopting Partial Prefetching guide](https://nextjs.org/docs/app/guides/adopting-partial-prefetching) is the canonical reference for the concepts this skill applies.

The development insights and the preservation tests are two different paths. Insights surface only in `next dev`, in the dev overlay's Insights tab. Test-backed preservation runs against a production-like build with `instant()` and does not need a development server. After the flag is enabled, the separate URL-data insight sweep still uses `next dev`.

## preservation evidence

An existing flag-off `instant()` suite is useful evidence of the legacy behavior.
Reuse it when practical, but do not make building a rig, installing test
dependencies, or getting a new baseline to pass a prerequisite for source edits.
If no suitable suite exists, inspect the existing implementation and use a
focused before/after browser observation or the project's established check
when available. State what the evidence covers and what remains uncertain.

Talk to the user in terms of what they'll see — PRs, features, and how the app behaves after — never the insight slugs or step labels. Before you start, tell them briefly what Partial Prefetching changes: links to a route prefetch one shared App Shell, and `prefetch={true}` can also resolve cached URL-specific content. The audit determines which UI from the legacy full prefetch to preserve.

## requires

- **Cache Components support.** The `partialPrefetching` flag and route-level `prefetch` export require Cache Components. If the project has not enabled it, use the migration guidance as needed for the requested change. A passing full build is not a prerequisite for unrelated source edits; report any concrete feature incompatibility.

- **Feature support depends on the installed Next.js version.** The flag,
  route segment config, and insights described here are available in 16.3 and
  later. Check version-matched docs for an explicit adoption request. If the
  project lacks a needed capability, report that feature-specific limitation;
  do not upgrade or stop unrelated work to satisfy this skill.

- **Available browser diagnostics.** Use the integrated Browser or existing
  Playwright setup for focused observations when available. The development
  insight path can use [`next-dev-loop`](https://github.com/vercel/next.js/tree/canary/skills/next-dev-loop), but do not install it or change bundler settings solely to enable that optional diagnostic. If no browser is available, continue with source and existing checks and label the limitation.

- **A runnable app helps with runtime observation.** Automatic prefetching behavior can be observed in production, while insights are available in development. Use an available environment that fits the check; if the app cannot start, continue independent source work and report the missing runtime evidence.

### notes

- **Offline docs.** Guide links have offline copies under `node_modules/next/dist/docs/` (bundled since Next.js 16.2), with the directory layout numbered for ordering (e.g. `node_modules/next/dist/docs/01-app/02-guides/adopting-partial-prefetching.md`). If you can't predict the numbered prefix, `find node_modules/next/dist/docs -name '<slug>.md'` resolves it. The `/docs/messages/*` error pages are not bundled.

- **Older versions without bundled docs.** Use the available version-matched online documentation. The `agents-md` codemod is optional; do not download it or edit `AGENTS.md` / `CLAUDE.md` solely to use this skill.

## background

Adopting Partial Prefetching means every route preserves the prefetched UI that matters, now split between the shared App Shell and any extra per-link data a link explicitly asks for. The [guide](https://nextjs.org/docs/app/guides/adopting-partial-prefetching) is the canonical reference for what a prefetch contains and how to decide each case; this skill sequences that work against a running app.

The catch that decides most of the sweep: a default link warms only the shared App Shell. A route keyed by `params` or `searchParams` can prefetch more only after it has adopted Partial Prefetching and a specific link uses [`<Link prefetch={true}>`](https://nextjs.org/docs/app/api-reference/components/link#prefetch); then Next.js resolves the URL data and any cached content behind it before the click (the guide's [URL data](https://nextjs.org/docs/app/guides/adopting-partial-prefetching#url-data) section).

## working surfaces

- **An applicable production-mode suite — one possible preservation signal.** Reuse an existing suite and rig when practical. A new rig may help on an explicitly requested migration, but is optional; it is not the only way to assess whether the selected UI remains available.
- **The dev server terminal — the primary record for the insight path.** Each validated route's insights are logged as `Error: Route "...": Next.js encountered ...` lines with the `https://nextjs.org/docs/messages/<slug>` link. Tail the dev log during the sweep; it's the greppable record of what fired where, and it works the same on Turbopack and webpack.
- **The dev overlay Insights tab.** Insights are the amber, non-blocking tab. It appears only once an insight has fired, so a route that surfaces nothing shows no tab at all — that's the clean state, not a missing feature. Don't hunt for the tab on a quiet route; confirm clean from the dev log above, which is the reliable signal. The precondition is no blocking-prerender errors — those replace the insight on their route (see requires). An unrelated Issue (a hydration error, a console error) doesn't block the sweep; don't stall on it. When the tab is present, the overlay pill shows the count and each insight has fix cards linking its docs page. The overlay renders inside a shadow root (`nextjs-portal`), so accessibility-tree snapshots don't see it — evaluate into `shadowRoot` when you need to read or click it programmatically.
- **`next-dev-loop`** to drive navigations and read the overlay. Prefer it over hand-rolled browser automation for the same reasons as in the Cache Components skill (webpack apps: see requires). When browsing its `/_next/mcp` tools, the prefetch insights surface through `get_errors` and the overlay, not the similarly-named `get_request_insights`. That one is the span and performance recorder (gated behind `experimental.requestInsights`) and reports nothing about prefetching.

Every insight has a docs page — open it. Fetch the linked page for every distinct insight you encounter; the inline message is a summary, the page is the recipe.

## step 1: audit `<Link prefetch={true}>` navigations (before enabling)

Keep the global flag **off** while examining existing link behavior where practical. If the flag is already on in unshipped work, use available pre-flag evidence. Choose a reviewable grouping that fits the requested change; do not pause source work to select a PR strategy:

- **One branch** — the whole audit in one change, with the flag enabled and the codemod run at the end (step 4).
- **Route by route** — each adopted destination ships as its own PR. The insight still fires for the destinations you haven't reached, a live worklist, and step 4 comes after the last one.

The work can be grouped in one branch or in focused changes according to the request. Continue without user input on commit boundaries unless the user asked to decide them.

Enumerate explicit prefetch and manual prefetch sites across the whole source tree, not only `app/` — they often live in `src/components` or shared UI packages. Start from `next/link` imports and re-exports, then follow custom wrappers to their consumers. Use `rg -n '\bprefetch\b|router\.prefetch' -g '*.tsx' -g '*.jsx' .` as a candidate list, not as the complete audit; inspect conditional props and forwarded `LinkProps` to determine the effective production value. Include every audited navigation whose effective production Link value is `prefetch={true}`: explicit `true`, a bare `prefetch` prop, and expressions that resolve to `true`. Exclude the default value, `prefetch="auto"`, and `prefetch={false}` from the preservation suite because they do not request the legacy full prefetch. Audit existing [`router.prefetch()`](https://nextjs.org/docs/app/api-reference/functions/use-router#userouter) calls separately because they have no Link insight. For new manual prefetching, follow the [Prefetching guide](https://nextjs.org/docs/app/guides/prefetching#manual-prefetch). If no Link resolves to `prefetch={true}`, say so and move on to [step 4](#step-4-enable-the-flag).

### Choose what to preserve and how to verify it

Use the guide's [migration guidance](https://nextjs.org/docs/app/guides/adopting-partial-prefetching#migrate-existing-full-prefetches) to identify the UI worth preserving. When it helps resolve a product decision, summarize it in a concise table:

| Navigation | Proposed result |
| ---------- | --------------- |

Group equivalent navigations. Summarize what will be ready immediately and what will stream. When a proposal is ambiguous, show the navigation in the running app and ask the user to confirm it. If they are unavailable, follow the guide and record the assumption.

After the target UI is settled, inspect the existing test setup. The `instant()` helper comes from the separate [`@next/playwright`](https://nextjs.org/docs/app/guides/instant-navigation#prevent-regressions-with-e2e-tests) package, not `next/experimental/testmode/playwright`.

- **Applicable production-mode suite:** reuse relevant existing tests when practical. The guide's [prefetched UI test workflow](https://nextjs.org/docs/app/guides/adopting-partial-prefetching#verify-prefetched-ui-with-tests) can compare behavior with the flag off and on.
- **No applicable production-mode suite:** use the focused manual observation or existing project check described above. A new production-mode rig is optional.
- **No usable rig or suite:** use a focused manual observation or existing project check when possible. Record the evidence and its limits without blocking source edits or creating infrastructure solely for this workflow.

Reuse existing test evidence without pausing for process choices. Ask when the
target UI or freshness behavior is a product decision; otherwise follow the
guide's safe default and record assumptions. Treat new prefetched UI as step 7
work, and verify deliberate removals with an available task-relevant check.

This workflow is specific to a clicked `<Link>`. A direct call such as `router.prefetch('/dashboard')` is a manual prefetch, not a Link prefetch; keep it in the source audit and verify it separately in step 6.

## step 2: optionally capture the legacy behavior

When observing legacy behavior, use the flag-off configuration if available. If
no baseline evidence or environment is available, proceed with focused source
work and report that limitation; do not create test configuration as a gate.

When an applicable existing `instant()` suite is available, use it to observe
the flag-off behavior and preserve its relevant assertions. Do not create a
suite or hold source edits until a new baseline passes. If a baseline is
unavailable, note the gap and use the best focused evidence available.

Use the before/target inventory to keep edits aligned with the user's intended
experience. It can be built incrementally; a missing rig does not block edits.

## step 3: adopt destinations and restore the target

Adopt every audited destination with the temporary route config. The route export is enough for the unchanged tests to exercise Partial Prefetching on that destination while the global flag remains off:

```tsx
// See: https://nextjs.org/docs/app/guides/adopting-partial-prefetching
export const prefetch = "partial";
```

If other URL-specific UI might be worth prefetching but was not part of the legacy contract, keep `prefetch={true}` on its links and mark the route for step 7:

```tsx
// TODO(per-link-prefetch): assess with the user whether URL data should resolve before click.
// See: https://nextjs.org/docs/app/guides/optimizing-prefetching
export const prefetch = "partial";
```

Use that exact prefix so step 7 can grep them back. Do not select new target UI now; restore only the target chosen from the legacy behavior.

When relevant existing tests cover a changed destination, use focused results to
diagnose regressions; a complete-suite pass is not a prerequisite for each
edit or for continuing the migration. Compare available browser behavior with
the selected target and report gaps. Apply the guide's preservation pattern for
caching and Link-prop changes, and ask before making an unclear freshness or
caching decision. New URL-data candidates marked above wait for step 7.

When restoring the target changes caching or invalidation, follow the project's existing verification approach. Reuse or extend an applicable suite for the affected lifecycle, such as freshness after mutations, cache scope, or generated values. If the project doesn't test this type of behavior, do not introduce new test infrastructure during adoption; verify it manually in production and record the expected and observed results. A green `instant()` test proves readiness, not cache correctness. Ask the user only when the intended behavior is unclear.

> **If you add `use cache`, verify under `next start`, not only the build.** A `cookies()`/`headers()`/session read anywhere in the cached call tree throws at request time while `next build` passes clean. See [`use cache`](https://nextjs.org/docs/app/api-reference/directives/use-cache).

## step 4: enable the flag

When enabling the flag for the requested scope, finish in two moves.

1. **Enable the flag globally.** Set `partialPrefetching: true` in `next.config.ts` (alongside `cacheComponents: true`). Every route is adopted now, so every link is good.
2. **Strip the redundant `prefetch = 'partial'` exports.** Run the first-party `remove-partial-prefetch` codemod rather than a text find-and-replace. It removes every `export const prefetch = 'partial'`, including exports below a `TODO(per-link-prefetch)` marker, and removes its generated Partial Prefetching guide comment. The TODO marker and its Optimizing prefetching guide link stay for step 7. Other values such as `prefetch = 'force-disabled'` stay in place.

   ```bash
   npx @next/codemod@canary remove-partial-prefetch ./app
   ```

   Use `./src/app` in a `src/` project. The codemod may refuse a dirty working tree; do not commit or stash unrelated work just to run it. Use its supported force option or make the focused edit directly. If the codemod isn't available, remove only the generated `prefetch = 'partial'` exports and guide comments in the selected scope, preserving other values and TODO markers.

After enabling the flag, use the most focused available check to confirm the
changed navigation behavior. Reuse the existing suite or a production
comparison where available; report when neither was run.

## step 5: sweep for URL-data insights (after enabling)

This optional dev-only pass can help diagnose the requested routes after step 4. The shell check runs with the flag on and fires at navigation time. Build a route queue only for the scope the user asked to change.

If using the sweep, work feature by feature. A feature is a single product surface — `app/settings/**`, `app/posts/[slug]/**` — not a whole top-level area. Resolve insights relevant to the requested change. This is diagnostic guidance, not a full-app walkthrough requirement.

If the environment cannot complete a live check, continue any independent source work and report which routes were observed and which behavior remains unverified. Use type-checking or other existing focused checks where useful; do not expand scope solely to finish a sweep.

Watch the Insights tab and the dev log for `Next.js encountered … data` lines. The signal this step adds is [`URL data`](https://nextjs.org/docs/messages/instant-shell-url-data): a `params` or `searchParams` read too high in the suspended subtree ties the shared shell to one URL. This insight is narrow; it most reliably appears on a `generateStaticParams` route where `params` is already under `<Suspense>`, but still awaited before the URL-specific leaf boundary. If a `blocking-prerender-*` error fires instead, apply the same structural fix.

Loading a route with the flag on prerenders its App Shell, which validates more of the route than the Cache Components build did. So a route that built cleanly under Cache Components (every route `◐`, no errors) can still surface a `blocking-prerender-*` error here the first time its shell is prerendered — [`runtime data`](https://nextjs.org/docs/messages/blocking-prerender-runtime) (`cookies()`/`headers()`), [`uncached data`](https://nextjs.org/docs/messages/blocking-prerender-dynamic) (an uncached `fetch`/DB call), or sync IO like `Date.now()`/`new Date()`. This doesn't mean the Cache Components adoption was incomplete; it's new validation reaching a path the build never exercised. These aren't Partial Prefetching insights — fix each one the same way you would any blocking-prerender error.

These fixes rarely involve the user — each insight names the offending read and its docs page has the fix, so apply it and keep sweeping. Collect the rare exceptions for one batched question at the end: a page that is entirely one URL-dependent region (wrapping it all leaves an empty shell), or a route that should arguably stay opted out. Don't narrate the refactor with comments — the `<Suspense>` boundaries speak for themselves.

## step 6: verify

Use these checks when they fit the requested change; report evidence and limits:

- **An empty sweep is expected when Cache Components adoption finished cleanly.** A quiet log is success, not a missing signal. If you deliberately probe the validation path, use a `generateStaticParams` route with `params` read inside `<Suspense>` but before the URL-specific leaf boundary; other shapes may surface `blocking-prerender-*` instead.
- For routes you changed, check that the intended shared content appears and fallbacks resolve when an appropriate runtime observation is available. Avoid treating an empty shell or stuck fallback as success.
- The insights validate shell _structure_, not that a prefetch actually happened. If production prefetch behavior is part of the requested change and a suitable environment is available, confirm it there; development-only evidence does not establish production behavior.
- Reuse applicable tests or manual observations and note any behavior they do not cover.
- Any caching or invalidation changed to preserve the target is verified through an applicable existing test suite or a recorded manual check when the project has no such coverage.
- **If the changed behavior uses imperative prefetch**, the insight sweep does not cover it. Use a production observation when available to assess that behavior; otherwise report the limit.
- **When an auth or access behavior changes, preserve its guarantees.** Compare flag-off behavior when practical; never move or weaken a security gate without establishing the effect on authorization.
- Run the repository's final local acceptance pass when ready; do not run a build for every route.

Then check in with the user. Speak their language — no insight slugs or step labels.

- What you did: which links you audited, which destinations you adopted, and what each link now prefetches.
- What changed: dropped props, `use cache` boundaries added, and which routes carry a `TODO(per-link-prefetch)` marker for later.
- If production prefetch behavior was checked, identify that environment. Development-only evidence does not establish production prefetch behavior; a production demo is optional.
- If a production browser is already available, a live demonstration may help explain the result.
- Summarize the changed routes and what was observed. Ask only if the intended URL-specific content or freshness behavior is unclear.

## step 7: per-link prefetching (optional)

The audit marked candidates beyond the already-preserved legacy contract instead of deciding them. Grep for `TODO(per-link-prefetch)` and walk the list with the user in one conversation. The question per route is whether they want the additional URL-dependent content prefetched ahead of the click, or streaming in after navigation is fine. A per-link prefetch costs a server invocation per prefetchable link — the guide's [trade-offs](https://nextjs.org/docs/app/guides/optimizing-prefetching#trade-offs) section is the checklist. Don't make these calls alone.

Where the answer is no, delete the marker and leave the route on the App Shell default. Where the answer is yes, follow the [Optimizing prefetching guide](https://nextjs.org/docs/app/guides/optimizing-prefetching), confirm the opted-in link against a production run, and delete the marker when the selected result is verified.

No `TODO(per-link-prefetch)` marker survives the finished step. Per-link optimization remains a separate commit or PR from adoption.

Finally, show any effective `prefetch={false}` links in a concise `Navigation | Why it may no longer be needed` table. Explain that `false` disables all prefetching, while Partial Prefetching's default `auto` behavior prefetches only the shared App Shell, so opt-outs added to avoid legacy full-route prefetching may now be unnecessary. Invite the user to revisit them separately.

## further reading

- [Instant navigation](https://nextjs.org/docs/app/guides/instant-navigation) — the broader validation model and loading-state tooling.
- [Prevent regressions with e2e tests](https://nextjs.org/docs/app/guides/instant-navigation#prevent-regressions-with-e2e-tests) — use the `@next/playwright` `instant()` helper to build the flag-off baseline suite, then keep it as the CI regression guard.
- [`next-cache-components-optimizer`](https://github.com/vercel/next.js/tree/canary/skills/next-cache-components-optimizer) — grows each route's static shell so the App Shell carries more.
