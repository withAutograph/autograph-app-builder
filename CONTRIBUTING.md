# How to develop App Builder locally

This guide takes you from a source checkout to a running local App Builder plugin. The [local-development lifecycle](docs/local-development-lifecycle.md) is the normative contract for daily work: read it before changing the development workflow. Use `mise run dev` for daily development. Use the release commands only when you intend to promote clean, reviewed commits.

## Check the prerequisites

Local development supports macOS and Linux on ARM64 or AMD64. Before you start, install or configure:

- Git and [mise](https://mise.jdx.dev/)
- Codex with an active absolute `CODEX_HOME`
- A local `withAutograph/arrusted-development` checkout

Run commands from the App Builder repository root. The mise configuration supplies Node.js, pnpm, Codex CLI, and Vercel CLI versions. Local execution uses Vercel Sandbox through project-scoped OIDC; do not override those tools through `PATH` or ambient Node options.

## Start App Builder for the first time

Install the pinned tools and repository dependencies:

```sh
mise trust
mise install
mise run dependencies:install
```

Start the non-release workflow with an absolute Arrusted path:

```sh
mise run dev -- --arrusted-root /absolute/path/to/arrusted-development
```

The first run may populate reusable caches, but dependency preparation is not part of each edit/retry cycle. Later runs reuse those caches unless their inputs change. Ordinary development does not build release artifacts, OCI/Microsandbox images, or publish anything.

Wait for this output:

```text
Autograph App Builder development is ready.
Open a fresh Codex task and select Autograph App Builder (Development).
Loopback endpoint: http://127.0.0.1:3000/mcp
```

Keep `mise run dev` running. Open a new Codex task, then select **Autograph App Builder (Development)**. The plugin connects to the loopback `/mcp` endpoint and exposes exactly these tools:

- `autograph_start`
- `autograph_get`
- `autograph_send`
- `autograph_respond`
- `autograph_cancel`

Open prototype URLs in the integrated Browser over loopback. Development mode doesn't register an MCP App preview.

## Work on App Builder and Arrusted

Edit App Builder in this checkout. Next.js reloads application changes while the development task runs.

Edit Arrusted in the checkout passed to `--arrusted-root`. Tracked, dirty, and non-ignored changes are normal local-development input. App Builder incrementally synchronizes them into its persistent Vercel Sandbox and plans from the updated bytes; it does not require a commit, stop the Next.js HMR loop, or rebuild dependencies for an application-code edit. The cloned checkout is writable, while dependencies and generated/apply work remain in builder-owned overlay paths.

Source-only Arrusted edits reuse the dependency closure. Changes to `bun.lock`, `Cargo.lock`, `.config/mise/config.toml`, `.config/mise/mise.lock`, the platform, or relevant tool versions create a new dependency closure.

Generated and applied work stays in `.artifacts/development/destination`. Owner-only snapshots, package state, and caches stay in `.artifacts/development/state`. Both paths are ignored by Git.

Press `Ctrl+C` to stop Eve, Next.js, and the development supervisor. Run the same `mise run dev` command to resume.

## Inspect command options

Each public command documents its arguments without starting work:

```sh
mise run dev -- --help
mise run release:prove -- --help
mise run release:publish -- --help
```

App Builder has two user-facing modes. Read [App Builder execution modes](docs/execution-modes.md) for the complete safety and promotion contract.

## Resolve local development failures

### `CODEX_HOME` is missing or relative

Run the task from the Codex profile you want to update. `CODEX_HOME` must already identify that profile with an absolute path. The task refuses to guess because installing into another profile would make the plugin invisible to your new task.

### Port 2000 or 3000 is already in use

Choose unprivileged loopback ports:

```sh
mise run dev -- \
  --arrusted-root /absolute/path/to/arrusted-development \
  --eve-port 22000 \
  --next-port 23000
```

The generated development plugin uses the selected Next.js port.

### Codex doesn't show the development plugin

Wait for the ready message before opening Codex. The task installs the plugin only after `/mcp` proves the exact five-tool contract. Open a new task because an existing task doesn't hot-load plugin changes.

Inspect the active profile if the plugin is still absent:

```sh
mise exec -- codex plugin list
```

The list must contain the enabled `app-builder@autograph-dev` plugin. Rerunning `mise run dev` replaces stale development package bytes.

### Arrusted changes are not visible

Keep `mise run dev` running and retry the affected planning step. The local
development binding incrementally synchronizes the changed working-tree bytes
to the reusable sandbox. Restart only the Eve/MCP/agent cycle when its own
code changed; keep Next.js running for UI HMR.

### A release command rejects the checkout

Release proof requires clean committed Builder and Arrusted checkouts. Check both repositories with `git status --short`. Development accepts dirty Arrusted changes; release proof doesn't.

## Run focused validation

Run the checks closest to local development changes. Before the first push, complete the lifecycle exit gate once: one new-app create walkthrough and one existing-repository iterate walkthrough. Do not turn this into a broad regression run for every edit.

```sh
mise run test:unit -- \
  lib/development/local-mode.test.ts \
  lib/development/dev-package.test.ts \
  lib/development/mcp-readiness.test.ts \
  lib/development/workflow-contract.test.ts \
  scripts/public-command-help.test.ts
mise run typecheck
mise run format-check
```

Use broader suites only when your change crosses those boundaries or a focused failure requires more evidence.

## Promote a release

Read [App Builder execution modes](docs/execution-modes.md#release-promotion) before promotion. The release flow is one-way:

```text
clean commits -> release:prove candidate -> release:publish same bytes
```

`release:prove` creates and validates the immutable candidate without publishing. `release:publish` requires separate authorization and uploads only the candidate bytes already proven locally.
