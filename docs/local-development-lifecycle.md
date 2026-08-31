# Local-development lifecycle

This document is the normative, lightweight loop for ordinary App Builder
development. CI/CD is intentionally deferred to the separate
[Local-First App Builder CI/CD plan](plans/2026-08-31-local-first-ci-cd.md) and
MUST NOT leak into this loop.

## Contract

- `mise run dev` MUST be the sole developer entrypoint.
- Normal iteration MUST be: edit live code -> let Next HMR, or a targeted Eve
  or package restart, take effect -> retry only the affected behavior.
- Developers MUST NOT build immutable artifacts, OCI images, Microsandbox
  images, GHCR assets, release packages, deployments, marketplace updates, or
  production proofs during ordinary development.
- Real execution MUST use Vercel Sandbox as the sole backend, with
  project-scoped OIDC. Static keys and silent fallback MUST NOT be used.
- Dependency preparation MUST NOT run per edit or restart. Planning MAY do one
  cheap cache lookup when a walkthrough reaches implementation planning;
  expensive preparation MUST happen once per lockfile/platform/toolchain/
  bootstrap key.
- App or agent code changes MUST NOT invalidate dependency caches. Per-run Eve
  state MUST be fresh and separate from reusable dependency caches.
- Broad regression suites MUST NOT run on every iteration. Run the focused test
  for the concrete fix. Before the first push, the single local exit gate MUST
  be exactly two complete walkthroughs: one new-app create walkthrough and one
  existing-repository iterate walkthrough.
- Dirty App Builder and Arrusted working-tree code MAY be used only through the
  explicit local-development binding. Hosted and release modes MUST reject it.
- Browser previews MUST use loopback URLs in the integrated Browser. An MCP App
  preview MUST NOT be used.
- Publication and all outward effects MUST remain disabled in local development.

## Decision table

| Stage           | Trigger                 | Required action                                    | Prohibited scope                      |
| --------------- | ----------------------- | -------------------------------------------------- | ------------------------------------- |
| Per-edit        | A live-code change      | HMR or targeted restart; retry affected behavior   | Rebuilds, broad suites, publication   |
| Focused-fix     | A concrete behavior fix | Run the smallest relevant focused test             | Treating it as full regression proof  |
| Local-exit-gate | Before first push      | Run one complete create and one existing-repository iterate walkthrough     | Deploying or publishing               |
| PR CI           | A pushed PR             | Follow the separate CI plan and its gates          | Folding CI work into `mise run dev`   |
| Main CD         | An approved main change | Follow the separate CD/release plan                | Using the local loop as release proof |

The PR CI and main CD rows describe later stages only; they are not additional
local-development commands or permissions.
