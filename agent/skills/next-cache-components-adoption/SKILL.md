---
name: next-cache-components-adoption
description: >
  Turn on Cache Components in a Next.js app and resolve the blocking routes it
  surfaces. Use when the user wants to enable, adopt, or migrate to Cache
  Components, flip the `cacheComponents` flag, work through a flood of
  blocking-prerender / instant validation errors, run the
  `cache-components-instant-false` codemod, or decide between opting routes out
  with `export const instant = false` and fixing them in place.
---

# next-cache-components-adoption

## project policy and scope

Use this skill only when the user asks to adopt or debug Cache Components.
The repository's local-development and focused-validation policy takes
precedence for unrelated edits: this migration's route inventory, optional
tools, framework versions, build artifacts, cache state, receipts, and exact
source shapes are not general work or CI gates. Reuse relevant evidence and
run focused checks for changed behavior; do not require a new rig, tool
installation, or per-route build before continuing source work. Report any
unverified migration behavior honestly. Preserve authentication, tenant
isolation, credential handling, and approval boundaries.

Enable Cache Components on an app and walk it to a passing build. This skill sequences the work; per-error recipes live in the dev overlay fix cards and the build's terminal output. The [migrating to Cache Components guide](https://nextjs.org/docs/app/guides/migrating-to-cache-components) is the canonical reference for the concepts and per-API recipes this skill applies — consult it whenever the skill steps reference a pattern (`"use cache"`, `cacheLife`, `<Suspense>` placement, etc.) and you want the full explanation.

## requires

- **App Router project.** Cache Components is an App Router feature; `cacheComponents: true` does nothing for `pages/` routes. If the project has a `pages/` or `src/pages/` tree but no `app/` or `src/app/` tree, stop and tell the user — Pages → App migration is its own project, not part of this skill. A hybrid app (both `pages/` and `app/`) is fine: the flag affects the `app/` routes; `pages/` routes are unaffected and don't need opt-outs.

- **A resolved app directory.** Locate `next.config.{js,ts,mjs,cjs}` first: that's the project root, and an agent invoked from a subdirectory would otherwise test for `app/` against the wrong `cwd` and find nothing. Look for `app/` and `src/app/` under it, and treat every command and glob in this skill as relative to whichever one exists. If both exist, Next.js builds `app/` and never looks at `src/app/`, so its routes are shadowed and unbuilt — tell the user that and ask which tree to migrate instead of picking one.

- **A runnable app helps with runtime observation.** If it reads a database or required env at import, use an available environment for the behavior being checked. If the app cannot start, continue independent source work and report that runtime evidence is unavailable.

- **Feature support depends on the installed Next.js version.** The commands
  described here assume 16.3 or later, which includes top-level
  `cacheComponents`, `export const instant`, the dev-overlay validation
  warnings, and the codemod. Check the installed version and version-matched
  docs when adopting this feature. If a requested migration needs a capability
  the project lacks, report that specific limitation; do not upgrade or stop
  unrelated work to satisfy this workflow.

- **No incompatible config keys.** `cacheComponents: true` errors on any file that still exports `dynamic`, `revalidate`, or `fetchCache`. **Translate, don't delete.** Each export encodes behavior the route needs to keep doing; migrate each one to its Cache Components equivalent via the [migration guide's per-key sections](https://nextjs.org/docs/app/guides/migrating-to-cache-components#enable-cache-components). The exception is `dynamic = 'force-dynamic'`: under Cache Components every route is already dynamic by default, so the migration guide removes it outright rather than translating it — don't overthink a batch of identical `force-dynamic` deletions. `revalidate` and `fetchCache` still need real translation. If a value can't be cleanly translated yet, leave a `// TODO: Cache Components adoption — restore revalidate = 3600` comment so the loop picks it up. The `cache-components-instant-false` codemod does not touch these.

- **`experimental.dynamicIO` is fatal.** It was renamed to top-level `cacheComponents` and the old key now aborts before any build can run — remove it (or replace with `cacheComponents: true`) first. `experimental.useCache` is still accepted as a deprecated alias; redundant once `cacheComponents: true` is set, so remove it for clarity.

### notes

- **No passing baseline before the flag.** If the app already uses `"use cache"`, the pre-flag build errors with `please enable the feature flag cacheComponents`. Enabling the flag is the first thing you do (in Incremental, before the codemod; in Direct, before fixing routes) — not a thing to do _after_ getting a passing build. Note this in your starting summary so it doesn't read as a regression.

- **Offline docs.** Guide links have offline copies under `node_modules/next/dist/docs/` (bundled since Next.js 16.2), with the directory layout numbered for ordering (e.g. `node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md`). If you can't predict the numbered prefix, `find node_modules/next/dist/docs -name '<slug>.md'` resolves it. The `/docs/messages/*` error pages are not bundled.

- **Older versions without bundled docs.** Use the available version-matched online documentation. The `agents-md` codemod is optional; do not download it or edit `AGENTS.md` / `CLAUDE.md` solely to use this skill.

## the shape of the work

There's one loop: walk the route tree top-down, one feature at a time, adopting each route against `next dev` + a browser. The build is a final check for each feature, not the working surface.

The two organizational options below describe a possible migration sequence. They are not prerequisites for beginning focused source work:

- **With a quiet pre-step (Incremental).** A codemod can opt routes out of validation before adopting them. Treat this as an organizational option; a standalone build or PR is not a prerequisite to continue.
- **Without (Direct).** Enable `cacheComponents` and use relevant build or dev diagnostics to identify blocking routes. Keep edits focused and use one final local acceptance pass when ready.

For the requested migration, use the live route behavior and the most focused
available build or runtime checks to confirm the affected experience. Reuse
existing evidence; do not run a separate build after every route. Once the
migration is ready, perform the repository's single local acceptance pass and
report any remaining uncertainty. The incremental and direct paths are
organizational options, not prerequisites for unrelated edits.

## background

`cacheComponents: true` requires every route to be prerenderable. A route that reads request-time data outside `<Suspense>` is "blocking" and fails the build. `export const instant = false` marks a route as allowed to block, which clears it in both dev and build; on a layout it covers the whole subtree during the build, but client navigations still validate each descendant segment on its own. Reads wrapped in a [`"use cache"`](https://nextjs.org/docs/app/api-reference/directives/use-cache) function count as cache boundaries, not blocking reads.

When a fix introduces `"use cache"`, follow the Caching guide for [choosing a data-level or UI-level boundary and setting its lifetime](https://nextjs.org/docs/app/getting-started/caching#usage). Use the [`use cache` cache-key reference](https://nextjs.org/docs/app/api-reference/directives/use-cache#cache-keys) when the result varies by arguments or captured values.

Three classes of blocker come up, usually in this order:

Whenever a fix introduces `<Suspense>`, follow the Streaming guide's [granular streaming pattern](https://nextjs.org/docs/app/guides/streaming#granular-streaming-with-suspense) and [guidance for preventing CLS](https://nextjs.org/docs/app/guides/streaming#cls-cumulative-layout-shift).

1. **Request-time reads** (`cookies()`, `headers()`, `await params`, `await searchParams`). All four block when awaited at the top of a page or layout. `params` and `searchParams` often get missed because they're not framed as "request data" the way cookies and headers are. The fix is to push the read into a `<Suspense>`-wrapped child — and for `params`/`searchParams`, forward the promise into the child and await it there; don't `await` at the page top.
2. **Sync-IO at module/render time** (`new Date()`, `Date.now()`, `Math.random()`, `crypto.randomUUID()`). These fail the build even with `instant = false` — the opt-out doesn't suppress them. If they're in a shared layout, they block every route under it. The codemod can't fix them; after running it, use each build error and its linked documentation to identify which reported calls to translate by hand (see the [incremental pre-step](#incremental)).
3. **`"use cache"` files that read request data.** A file with a top-level `"use cache"` directive can't export `instant`; combining the two errors with `Only async functions are allowed to be exported in a "use cache" file.`, which means the directive was wrong for that route. Remove it before running the codemod.

## working surfaces

### finding blocking routes

When available, prefer `next dev` for route-specific diagnostics while working.
The build and browser recipes below help explain this feature's behavior; they
are not mandatory per-route gates. Use existing project checks and focus on the
route or shared code changed.

- **`next dev`** — an available diagnostic surface. Visit a route to inspect blocking errors in the dev overlay and use linked docs to understand them. The route itself may still return HTTP 200, so inspect the overlay rather than status codes. Use this where it helps diagnose changed behavior; it is not a per-route acceptance gate.
- **`next build`** — an optional diagnostic and final acceptance check. Use it when it helps diagnose a concrete migration issue or for the repository's final local acceptance pass; do not run it after every route or treat a route-by-route build as the edit loop. `--debug-build-paths` and `--debug-prerender` can narrow or expand diagnostics when a concrete build failure needs investigation.

Every blocking error has a docs page — open it. Both the dev overlay and the build terminal print a `https://nextjs.org/docs/messages/<slug>` link with each error. That page is the canonical recipe for the fix; the inline message is a summary. Fetch the link for every distinct error you encounter, even if you think you know the pattern — the recipes evolve, and the same error class can have different correct fixes depending on what the route reads. Don't improvise from the inline message alone. (`/docs/messages/*` pages aren't bundled offline; if you have no network, fall back to the per-API guides under `node_modules/next/dist/docs/` and note the limitation when you report back.)

### verifying each fix at runtime

Build output or a cleared overlay alone does not prove streamed UI behavior.
For an explicitly requested Cache Components change, use a focused runtime
observation when available; otherwise report the available evidence and what
remains unverified. Do not hold unrelated edits for a browser or optional
diagnostic tool.

In preference order:

1. **[`next-dev-loop`](https://github.com/vercel/next.js/tree/canary/skills/next-dev-loop) — optional.** When already available, it cross-checks `/_next/mcp` against a live browser and can surface compile and runtime issues together.

   Check whether it is already available. Do not install it just to continue this skill; proceed with the integrated Browser, an existing Playwright setup, or focused app checks if not:

   ```bash
   npx skills add https://github.com/vercel/next.js/tree/canary/skills/next-dev-loop
   ```

   The skill states its required `agent-browser` version and walks you through it.

   This diagnostic uses Turbopack. If the app uses webpack, skip it and use the integrated Browser, project Playwright setup, or other focused checks without changing the bundler solely for this diagnostic.

   This optional verifier may require Turbopack and `agent-browser`; their absence is not a blocker. Do not install dependencies or change bundler settings solely to run it.

2. **An available browser.** Use the integrated Browser, project Playwright setup, or another available browser tool for a focused observation. Framework-side checks may be unavailable; label the evidence accordingly.

3. **Build-only.** If you can't run a dev server at all, the build is your only signal. `○ (Static)` routes with no `<Suspense>` are fully verified by the build (nothing streamed to test). `◐ (Partial Prerender)` routes are only shell-verified — flag them when you report back.

4. **No tooling at all.** Continue source work using available evidence and report that runtime behavior remains unverified. Ask the user to run the app only when that observation is needed to resolve the requested behavior.

## step 1: choose a strategy

Choose a focused migration sequence based on the requested work and existing source. Do not pause ordinary edits to select a PR strategy; group changes for review when they are ready.

When a choice matters to scope or user-visible behavior, ask; otherwise proceed with the focused path and report it.

- **Incremental** — a quiet pre-step can opt routes out of validation before adoption. It is an organizational option; do not require a passing build or separate PR before continuing.
- **Direct** — skip the pre-step. Enable `cacheComponents` and go straight to [step 2's loop](#step-2-the-inner-loop-remove-opt-outs-one-feature-at-a-time); the build's blocking routes are the work queue.

### incremental

Before invoking the codemod, fix the blocker that does not require build feedback.

1. **Incompatible segment configs.** Grep for `^export const (revalidate|dynamic|fetchCache)` across the app directory and translate per the `requires` note above. The codemod does not touch them; leaving them in place fails the build after the codemod.

The codemod may refuse a dirty working tree. Do not commit or stash unrelated work just to run it; use its supported force option or make the focused edit directly.

```bash
npx @next/codemod@latest cache-components-instant-false ./app
```

Pass the app directory you resolved in [requires](#requires). A wrong path is not an error: it reports `0 ok` and exits `0`, so read the file count and treat zero as a failed run, not an adopted app.

Inserts `export const instant = false` (with a `// TODO: Cache Components adoption` comment) into every `{page,layout,default}` file under that directory, skipping files that already declare `instant` and any module marked `"use client"` or `"use server"`. Then set `cacheComponents: true`. The TODO comments are the work queue for the loop.

If the codemod isn't available (older `@next/codemod`, sandboxed environment, offline run), reproduce it by hand: for every `{page,layout,default}.{js,jsx,ts,tsx}` in the app directory that isn't `"use client"` or `"use server"` and doesn't already declare `instant`, insert this after the imports:

```ts
// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;
```

The codemod opts every segment out, not only the root, on purpose. Resolution is top-down, first-explicit-config-wins: the highest `instant = false` decides the whole subtree. With an opt-out on every segment, removing one segment's opt-out validates only that segment; descendants keep their own opt-outs and stay passing. If only the root were opted out, removing it would re-arm validation for the entire app at once.

Because the highest opt-out wins, remove them top-down (root layout first, then descend). Removing a leaf's opt-out does nothing while an ancestor still holds one.

If a focused build is useful for diagnosing a blocker the codemod could not handle, a shared layout that calls `new Date()` / `Math.random()` directly can still surface even when a route is opted out (see [background](#background)). If a build reports a sync-IO error without locating the call, rerun only as useful with `next build --debug-prerender --debug-build-paths="app/path/to/page.tsx"`. For each sync-IO error it reports:

1. **Sync-IO at module/render time.** Use the route, originating file and line, and `/docs/messages/` link in the build output to locate the error. If needed, grep the whole repo for `new Date()`, `Date.now()`, `Math.random()`, and `crypto.randomUUID()` (not only `app/**/layout.{js,jsx,ts,tsx}` — the read might live in any component imported by a layout). Do not change unreported matches. Apply the appropriate option from the linked error page, then add this comment above a temporary boundary introduced only to unblock the build:

   ```tsx
   // TODO: Cache Components adoption. Added to unblock the build: remove this boundary to re-trigger the error and review the documented options.
   ```

   It shares the `TODO: Cache Components adoption` prefix with the comments the codemod writes, so the check-in grep finds both. Removing the boundary makes the error fire again with its fix cards — the same motion as removing an opt-out in the loop.

Use a focused check to diagnose a concrete blocker. Defer a broad build until the repository's final local acceptance pass; do not repeat it after each fix.

When using the codemod, ensure its intended behavior covers the root layout and relevant routes. Treat a text grep or marker inventory as debugging context, not a required source-shape check.

Synthetic routes like `/_not-found` have no user file — when they block, fix the root layout's opt-out, not the synthetic route. Client Components (`"use client"`) get no opt-out (it's a build error to export `instant` from them), but they are not a rare blocker. The high-frequency case is a client component in the root layout's nav or header calling `usePathname()`/`useSearchParams()`: it blocks _every_ dynamic route with `blocking-prerender-client-hook`, and static routes pass (the pathname is known at prerender), which masks it until you reach a dynamic segment. It's not an ancestor-data fix — follow the [error's docs page](https://nextjs.org/docs/messages/blocking-prerender-client-hook) for the `<Suspense>` recipe. Only when a client route blocks on _server_ data do you fix that data in its ancestor.

### optional migration checkpoint

If a separately reviewable pre-step helps the requested work, summarize the
scope and evidence. Do not stop source work or wait for a PR decision between
migration steps unless the user asks for that boundary.

### direct

Set `cacheComponents: true` and move to [step 2](#step-2-the-inner-loop-remove-opt-outs-one-feature-at-a-time). The build's blocking routes are the work queue.

## step 2: the inner loop, remove opt-outs one feature at a time

A "feature" is a single product surface — `app/settings/profile/**`, `app/posts/[slug]/**` — not a whole top-level app like `app/dashboard/**`. Finish one end-to-end before starting the next.

Within a feature, walk top-down (layouts before pages, root layout first). Removing a layout's opt-out before its descendants exposes the layout's own blocking reads. (Direct: there are no opt-outs to remove — fix each failing route; if a hand-written opt-out on an ancestor shadows it, remove that first.)

A passing build mid-walk doesn't mean the layout is clean. Removing a layout's opt-out while its descendant pages still have theirs keeps the build passing — each page shadows the inherited validation. The layout's actual blocking reads only surface once nothing below it shadows them. Don't call a feature done at the layout boundary.

Use an available browser observation when it helps verify changed user-visible behavior. The [`next-dev-loop`](#verifying-each-fix-at-runtime) describes optional diagnostics; its tools and version requirements are not prerequisites.

### the loop, with a browser (preferred)

Per route:

- Remove the opt-out (Incremental) or target the failing route (Direct).
- Reload in dev. Overlay clean? Skip to verify. Overlay still red? Fix.
- Fix — fetch the docs page linked from the error (`https://nextjs.org/docs/messages/<slug>`), apply the recipe from there. The inline overlay text is a summary; the docs page is the source of truth.
- Verify in the browser. Confirm the visible content on first paint is what you intended in the shell — not stuck on a fallback, not silently streaming everything out of an empty shell.
- Re-check siblings if the fix touched shared code (a layout, a sidebar component). A shared-shell change can fix the route you're on and break a sibling.

### the loop, build-only (fallback)

Use build-only diagnostics only when they help with a concrete issue and no browser check is available. Build output cannot show which content the user sees in the shell.

Per route:

- Remove the opt-out (Incremental) or target the failing route (Direct).
- If a concrete build failure needs investigation, consider `--debug-build-paths app/<route>/**` or `--debug-prerender` to inspect it.
- Fix — fetch the docs page linked from the error (`https://nextjs.org/docs/messages/<slug>`), apply the recipe from there.
- Re-check siblings if the fix touched shared code.
- When handing off, distinguish build evidence from browser-confirmed behavior; note what remains unverified.

### loop notes

- The [three blocker classes from background](#background) often get missed when fixing in place. Caching a downstream fetch (`getThing(id)`) doesn't clear an `await params` at the top of the page body — push the param promise into the `<Suspense>`-wrapped child.
- Ambiguous calls are user check-ins, not agent judgment. When you're not sure which fix fits, the blocking code looks security-sensitive, or the user might want to keep the route blocking on purpose — read [references/per-page-decisions.md](./references/per-page-decisions.md) before editing. Show the route while you ask: the `next-dev-loop` session runs the browser headed, so drive to the page and leave it on screen so the user is looking at the thing they're deciding about, with a screenshot as the fallback when a headed browser isn't possible. "Should this stay blocking?" is much easier to answer while looking at the page than at a file path.
- Don't narrate the refactor with comments. The only comment the codemod (or you) should leave is `// TODO: Cache Components adoption` on opt-outs, and the user's existing comments. Don't annotate every `<Suspense>` boundary or `"use cache"` call with what it does — the code says that. Drop a comment only when the _why_ isn't clear from the code (e.g. a deliberate Block with a reason).
- For many routes with the same mechanical fix, verify one representative route first. Then batch disjoint route groups using the same recipe, and run the shared build and browser checks together.

Keep track of the routes relevant to the requested feature. Use the inventory to focus checks; do not expand it into an unrelated source or layout gate.

## step 3: verify the feature

Checklist before checking in with the user:

- Use the repository's final local acceptance pass when ready. Report its result and any remaining behavior uncertainty.
- Review opt-outs, TODOs, and blocking reads as migration context; do not impose exact marker or file-shape requirements.
- Use an available browser to confirm changed shell and streaming behavior when possible. A screenshot or throttled demo is optional.
- If runtime verification fails, reproduce the same route on the pre-adoption branch or with its opt-out restored. A failure that already exists is an environment or data problem, not an adoption regression.

When reporting, speak about the feature and what the user will see; distinguish confirmed behavior from source-level or build-only evidence.

- What you did: which routes you touched, and the user-visible result per route (e.g. "the post page now streams the article body behind a skeleton while the layout stays static").
- What changed: opt-outs removed, fallbacks added, caching boundaries introduced.
- If useful and available, show the browser behavior; a live demo or screenshots are optional.
- Give them the click-through: a short table of the feature's routes — the URL to open and what to look for (what renders instantly, which fallbacks appear, what streams in) — so they can verify each one themselves.
- Continue with other requested work without a check-in between routes; pause only for an actual product or security decision.

**Trivial features can skip the check-in.** If adopting a feature only meant removing its `// TODO: Cache Components adoption` opt-out (no `<Suspense>` added, no `'use cache'` introduced, no render order change), the user sees nothing different. Move on to the next feature without stopping; mention it in passing the next time you do check in.

Finish the requested migration scope when the intended behavior is in place and the relevant available checks are complete. Report deferred routes, remaining opt-outs, and unverified behavior as context; do not use a TODO grep or source-marker inventory as a completion gate.

### route table glyphs

`ƒ` → `◐` is where adoption usually lands. `◐ (Partial Prerender)` means a static shell prerenders and the request-time content streams in — the goal state for any route that reads `cookies()`, `headers()`, `params`, or `searchParams`. Some routes legitimately stay `ƒ` when they do request-time work through a documented escape hatch (e.g. a layout that uses `await connection()`); the page is no longer _opted out_, it's genuinely dynamic. Don't remove the escape hatch only to chase a `◐`. The inverse holds: `instant = false` does not force a route to be `ƒ`. The glyph reflects what the route does at prerender time, not which validation knobs it exports.

`◐` tells you a shell exists, not what's in it. A `<Suspense>` boundary placed too high (e.g. wrapping the entire page body, or `<Suspense fallback={null}>` around the article content) pushes the visible content out of the static shell into the streamed payload; the build still reports `◐` because _some_ shell prerendered (often only `<html><body>` with framework markup). The route table can't tell you what's in the shell; a browser can. If the shell is empty and everything streams, pull the `<Suspense>` boundary down closer to the actual dynamic read.

## further reading

The work below is optional and lives in the docs — link the user to them and let them decide which to take on next. Don't walk these through inside this skill.

- [Sweep for more instant navigations](./references/dev-only-validations.md) — an optional follow-up once adoption is done, never required. A passing build is not the last word, because dev validates every route on each page load (simulating both page loads and client navigations) and catches what the build's first-error exit and descendant shadowing skipped. Offer it as the smaller path to instant navigation for a user who doesn't want to adopt Partial Prefetching. Adopting Partial Prefetching (below) runs the same kind of loop and meets these insights anyway, so recommend both and let the user pick which, or whether. The reference is the loop to execute.
- [`next-partial-prefetching-adoption`](https://github.com/vercel/next.js/tree/canary/skills/next-partial-prefetching-adoption) — the follow-up skill that adopts Partial Prefetching: it enables `partialPrefetching` and audits every `<Link prefetch={true}>` against a decision table (or adopts incrementally with the flag off, driven by the `instant-link-prefetch-partial` insight). It sequences this the same way this skill sequences Cache Components, but the insights are dev-only, so it's a browser click-through, not a build loop. Recommended after instant navigation, since those fixes feed directly into how much of each route the shell can prefetch. Concepts live in the [Adopting Partial Prefetching guide](https://nextjs.org/docs/app/guides/adopting-partial-prefetching).
- [Prevent regressions with e2e tests](https://nextjs.org/docs/app/guides/instant-navigation#prevent-regressions-with-e2e-tests) — the `@next/playwright` [`instant()`](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/instant#testing-instant-navigation) helper asserts on the UI that's available immediately on navigation, so regressions surface in CI. Recommend it once a route is instant: `next-dev-loop` confirms it _now_; an `instant()` test keeps it that way.
- [`next-cache-components-optimizer`](https://github.com/vercel/next.js/tree/canary/skills/next-cache-components-optimizer) — a separate skill that grows each route's static shell so more of the page prerenders and less streams in. Pure optimization, not part of adoption.
