---
name: create-app
description: Guide complete creation of a route-owned Next.js app in a supported Autograph repository, from product design through an approved AppSpec, canonical proposal, reviewed change set, and separately approved publication. Use as the primary entry point when a user asks to create, build, or start a new app. Route explicitly bare/local-only Next.js workspace requests to $scaffold-app-workspace.
---

# Create App

Create one validated local app without crossing provider or deployment authority.
Keep product acceptance separate from approval to mutate source and topology.

Use only discovered builder-owned tools. If the required identity, planning,
prototype, apply, review, or publication operation is unavailable, stop at the
last completed receipt and report that implementation gap. Never replace a
missing operation with a raw shell command or generic file write.

## Workflow

1. If the user explicitly requests only a bare Next.js workspace, follow
   [$scaffold-app-workspace](../scaffold-app-workspace/SKILL.md) and stop this
   route-owned flow. Do not interpret a generic “create an app” request as bare
   scaffolding.
2. Collect one lowercase kebab-case app id. Use the builder-owned identity
   operation declared by the selected adapter; never construct or guess a
   repository script path.

3. Inspect the isolated target workspace, existing workspace identities, current topology,
   and `prototype/<app-id>/app-spec.md`. Preserve unrelated changes.
4. If the conventional AppSpec is absent or lacks an explicitly accepted,
   build-ready handoff, follow [$design-app](../design-app/SKILL.md) in this same
   task. Resume only after the user explicitly accepts the AppSpec. AppSpec
   acceptance does not authorize source or topology mutation.
5. Follow [$plan-app-creation](../plan-app-creation/SKILL.md) to produce the
   canonical proposal. Return blockers without workarounds.
6. Present the complete proposal and request a distinct, explicit approval for
   the builder-owned apply operation. Do not apply on AppSpec acceptance alone,
   and never invoke the target command through generic shell access.
7. Use only the discovered `apply_app_creation` tool. It must rerun readiness,
   bind the exact proposal and earlier receipts, and write only its fresh
   builder-owned overlay. If it records partial failure, stop in
   recovery-required state without automatic retry.
8. Return the structured apply receipt. Stop until builder-owned validation and
   reviewed-change-set tools exist. After those tools land, request a separate
   publication approval before creating
   a commit, branch, draft pull request, or other named publication outcome.
   State exactly that the command created and route-configured unvalidated state
   in the fresh apply overlay; it did not publish, provision providers, deploy
   the app, activate releases, or prove Production readiness.

## Boundaries

- Never infer product decisions, silently repair the AppSpec, or mutate before
  the separate source/topology approval.
- Never use `$scaffold-app-workspace` as the apply step for a planned route-owned
  app; the complete command owns contract, workspace, and topology composition.
- Never create schema contents merely because the proposal derives a kernel
  schema path.
- Never publish without the separate publication approval. Never reconcile providers, mutate `amp.yaml`, create secrets or environment
  configuration, deploy, or claim admission or Production readiness.
- If the complete command reports stale, conflicting, or ambiguous recovery
  state, stop and report it precisely. Do not delete or overwrite user-modified
  state.
