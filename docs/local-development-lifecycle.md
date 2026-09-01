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
- Local App Builder development MUST use live HMR. An Arrusted working-tree
  snapshot is transient input to one targeted Eve cycle; it MUST NOT be a
  prerequisite for rebasing, freezing, or advancing `main`.
- Local prototypes and planning results MAY become stale. They MUST be treated
  as cheap, retryable local work, never as merge or release authority.
- Dependency-cache identity MUST contain only dependency inputs plus the
  platform, toolchain, and bootstrap identity. It MUST NOT contain a source
  SHA, source tree, source-receipt version, planning receipt, or draft PR.
- Browser previews MUST use loopback URLs in the integrated Browser. An MCP App
  preview MUST NOT be used.
- Publication and all outward effects MUST remain disabled in local development.

## Fast loop

- Development MUST keep one long-lived Next.js HMR process. Eve, MCP, or agent
  processes MUST restart only when the relevant change requires it.
- UI work MUST NOT reinstall the development plugin. Ordinary edits MUST NOT
  rebuild the sandbox or dependency closure.
- The builder MUST reuse its Vercel Sandbox and mutable overlay, synchronizing
  only changed tracked, nonignored files. A per-planning source snapshot is a
  separate input to that reusable sandbox and dependency state; a source change
  MUST create a new input, not an error.
- Local tool and eval debugging MUST be direct. Fresh Codex discovery is for a
  milestone or acceptance check, not ordinary iteration.
- Maintain one fast new-app fixture and one fast existing-app fixture. Run each
  complete walkthrough once at local acceptance.
- The hot loop MUST NOT build artifacts or packages, deploy, publish, or run a
  broad suite. CI/CD begins after local acceptance.
- Local telemetry MUST concisely record HMR/restart time, sandbox reuse,
  snapshot delta, and dependency-cache hit or miss.

## Decision table

| Stage           | Trigger                 | Required action                                                         | Prohibited scope                      |
| --------------- | ----------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| Per-edit        | A live-code change      | HMR or targeted restart; retry affected behavior                        | Rebuilds, broad suites, publication   |
| Focused-fix     | A concrete behavior fix | Run the smallest relevant focused test                                  | Treating it as full regression proof  |
| Local-exit-gate | Before first push       | Run one complete create and one existing-repository iterate walkthrough | Deploying or publishing               |
| PR CI           | A pushed PR             | Follow the separate CI plan and its gates                               | Folding CI work into `mise run dev`   |
| Main CD         | An approved main change | Follow the separate CD/release plan                                     | Using the local loop as release proof |

The PR CI and main CD rows describe later stages only; they are not additional
local-development commands or permissions.

## Drafts, reconciliation, and promotion

A draft pull request is provisional. It MUST be based on provider-read current
base information, MAY later conflict, and MUST NOT claim merge readiness.

Reconciliation occurs at merge time. The coordinator MUST re-read the current
default branch, rebase or regenerate the draft, rerun relevant validation,
show the actual reconciled diff, and request final effect-based merge approval.
It MUST merge only when that reconciled result is clean against the current
base. Tenant, provider, path, approval, and default-branch safety checks remain
required throughout this process.

Release-candidate byte immutability is a separate build/publish-promotion rule.
It MUST NOT be imposed on live local development, transient snapshots, local
prototypes, or draft planning.
