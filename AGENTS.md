<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Local development policy

- Follow [`docs/local-development-lifecycle.md`](docs/local-development-lifecycle.md).
  `mise run dev` is the sole supported local entrypoint. Develop against live
  checkout bytes, keep Next.js HMR running, and restart only the Eve, MCP, agent,
  or package cycle affected by a change.
- Use Vercel Sandbox as the only real execution backend and project-scoped
  Vercel OIDC as its credential boundary. Reuse the development sandbox and its
  builder-owned mutable overlay. Do not introduce or fall back to Microsandbox,
  OCI, Docker, GHCR, static provider keys, or a host-shell execution path.
- Treat repository content as live, writable, moving planning input. Keep
  dependencies, caches, generated planning files, and execution overlays
  outside the source tree so runtime setup never redefines source content.
  Ordinary App Builder or Arrusted source edits create a new inexpensive
  planning input; they do not rebuild the sandbox or dependency closure and
  are never a drift error by themselves.
- Assert only facts that protect a concrete boundary: tenant authority, path
  containment, dependency identity, reviewed content, or an outward effect.
  Do not promote source observations, package-manager layout, process
  restarts, timestamps, cache metadata, or normal source edits into authority
  gates. Re-observe cheap mutable facts and refresh planning input instead of
  rejecting harmless development changes.

## Iteration and validation

- Optimize the edit loop for feedback speed. Do not automatically run tests,
  broad checks, fresh installs, full walkthroughs, artifact builds, release
  proofs, or publication after each edit or restart.
- During implementation, run only a focused check needed to diagnose or verify
  a concrete repair. Once the local behavior is ready, run one final local
  acceptance pass. Let exact-head CI provide broad deterministic verification
  unless paths conflict or CI reports a specific defect.
- Fresh Codex installation and exact-five discovery are milestone or acceptance
  checks, not normal edit-loop steps. Use direct local tools and the fast create
  and existing-app fixtures while iterating.

## Delegation and integration

- Keep one coordinator responsible for integration, publication, merge, and
  provider mutations. Once a change is designed and its file ownership is
  bounded, delegate independent implementation slices to faster, smaller agents
  in isolated worktrees when capacity is available.
- Avoid duplicate writers and speculative verification lanes. Delegated work
  returns task-scoped commits or precise blockers to the coordinator. Reassign a
  completed slot only to the next executable, collision-free prerequisite.
- Integrate first, resolve only real conflicts, and defer the broad suite to the
  final local acceptance or exact-head CI. Do not create micro-PRs solely for
  process ceremony.
