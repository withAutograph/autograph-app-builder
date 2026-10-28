# Builder-managed Next.js upgrades

New app plans resolve the latest stable compatible Next.js, React/React DOM,
and React types once. The accepted proposal records concrete versions and
reuses them through apply, retry, and resume. Committed manifests use exact
catalog pins, never floating `latest` specifications. Ordinary existing-app
revisions preserve their framework versions.

For an explicitly requested upgrade, use the existing app-revision workflow
and pass `frameworkUpgrade: "latest"` to `accept_app_spec`. Inspect the current
app before proposing migrations. A dependency-only upgrade does not require
invented app source changes. A request to improve navigation includes real
app-owned changes and their intended user-visible behavior in the plan.

The repository adapter invokes Arrusted's `repository:upgrade-framework`
operation with the concrete proposal versions. That repository operation
updates the central catalog and lets Bun produce the lockfile. Builder keeps
those shared files in the same reviewed and published change set as app-owned
changes. In an Arrusted monorepo these pins affect all catalog consumers; the
review must make that scope visible. Do not submit arbitrary root file changes
through the app implementation-files interface or hand-author lockfile edits.

Use the existing build approval and publication controls. An upgrade is part
of that approved change, not another approval step. Inspect actual registry,
install, build, or behavior failures and repair them in the same workflow.
Do not silently fall back to older versions and describe the result as latest.
Missing capabilities in an older target repository are reported as such,
without regenerating the app or modifying it through a maintenance checkout.

## Preserve server rendering and improve navigation

Follow `arrusted-next-app-like-experience` and the exported official Next.js
skills matched to the selected release. Keep request-dependent reads inside
narrow Suspense boundaries while persistent layouts retain navigation and
static headings. Server Components call the server-only app DAL directly;
Server Actions validate inputs, authorize commands, persist, then invalidate
the affected data and views.

Cache Components and Partial Prefetching are the foundation, not a reason to
cache all app data. Choose private browser-cache lifetimes per feature, keep
session authority and form tokens request-specific, and check account/tenant
switches. Shared caches require genuinely shareable data. Use richer prefetches
for a useful fixed link set, or hover/focus/touch intent for long lists. Defer
expensive secondary content with `navigation()` outside the cached function
when it is intentionally unnecessary before a click.

Use stable React View Transitions for meaningful content continuity with
short animations, reduced-motion handling, and unsupported-browser fallback.
Keep pages server-rendered and client interaction leaves small. Templates
remain skeletons without demonstration reads, actions, or readiness receipts.

## Verify the upgraded app

Run focused existing checks and a production build against the selected
versions. Exercise direct entry, soft navigation, Back/Forward, loading and
error recovery, cache expiry, mutation invalidation, and authenticated scope.
Use `instant()` only for selected navigation outcomes that need prefetched UI.
Keep behavioral tests app-owned rather than copying a live app into platform
fixtures. Report installation, source checks, Builder preview behavior, and
hosted/publication results separately.

Spend Review adoption must use its saved public App Builder session and its
existing app/branch context. Do not hand-edit its product files or replace its
session with a freshly generated app. The agreed queue/detail browser-cache
window for that revision is 30 seconds; tokens and command authorization remain
fresh, and successful mutations invalidate the affected views immediately.

## References

- [App-like experiences with Next.js 16.3](https://nextjs.org/blog/building-app-like-experiences-with-nextjs-16-3)
- [Improving navigation in v0 with 16.4](https://nextjs.org/blog/improving-navigation-experience-in-v0-with-nextjs-16-4)
- [Next.js 16.4](https://nextjs.org/blog/next-16-4)
- [React 19.3](https://react.dev/blog/2026/09/09/react-19-3)

The upstream workflow lock identifies the official Next.js source revision.
Each bundled skill adds an App Builder execution-policy section; upstream
diagnostic commands do not expand the Builder tool or approval boundary.
