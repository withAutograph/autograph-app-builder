---
name: scaffold-app-workspace
description: Scaffold one new local Autograph Next.js app workspace. Use when asked to create a new app workspace, scaffold an app, or add a bare Next.js app under `apps/`. This skill creates local code only; it does not admit a route-owned app to topology or providers.
---

# Scaffold App Workspace

Create one bare local Next.js app workspace through the repository's canonical
Turbo generator. Treat its output as local code only.

Scaffolding requires the discovered builder-owned scaffold tool and its
approval. If it is absent, report that the operation is not implemented; never
execute the adapter command through a generic shell.

## Input

Require exactly one app id. It must match `^[a-z][a-z0-9-]*$` and be one path
segment. Reject any id containing whitespace, `/`, `@autograph/`, `apps/`, or
characters outside that pattern; do not normalize it.

Before mutating, inspect the working tree and verify that neither
`apps/<app-id>` nor `@autograph/<app-id>` already exists. Preserve unrelated
working-tree changes.

## Workflow

1. Use the builder-owned scaffold operation declared by the selected adapter.
   Never construct or guess a repository command.

2. Verify the generated workspace contains:

   - `apps/<app-id>/package.json` named `@autograph/<app-id>`;
   - `apps/<app-id>/next.config.ts`; and
   - `apps/<app-id>/turbo.json` extending `"//"`;
   - `apps/<app-id>/playwright.config.ts` with a passing `test:e2e` smoke test;
   - generated README, ignore rules, Vitest setup, and generic icon/social-image
     assets;
   - App Router `loading`, `error`, `global-error`, and `not-found` boundaries.

   The default Playwright command builds and starts the production app. Use
   `test:e2e:dev` when iterating against the development server.

3. Inspect the post-generation worktree. Confirm the generator created only
   the expected `apps/<app-id>` workspace and did not alter topology, provider,
   or registry files.

4. Report the created path and state clearly that it is **local code only**.
   Direct the user to
   `docs/guides/adopting-a-route-owned-app.md` in the prepared target workspace
   for the separate reviewed route-owned application admission procedure.

## Boundaries

Do not create schemas, health/read/write slices, provider resources,
independent-app specifications, registry entries, public routes, Vercel
Services configuration, or Vercel/Neon credentials. The Turbo generator may
create its standard app-local hk fragment; do not add or alter it separately.

Do not edit `microfrontends.json`, `.config/independent-apps/**`, or Vercel/Neon
state. Do not claim that the generated app is validated, deployed, routed,
admitted, or ready for production.
