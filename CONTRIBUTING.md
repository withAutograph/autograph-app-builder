# How to develop App Builder locally

This guide takes you from a source checkout to a running local App Builder plugin. Use `mise run dev` for daily development. Use the release commands only when you intend to promote clean, reviewed commits.

## Check the prerequisites

Local development supports macOS and Linux on ARM64 or AMD64. Before you start, install or configure:

- Git and [mise](https://mise.jdx.dev/)
- Docker Desktop or Docker Engine with a running daemon
- A host that supports Microsandbox virtualization
- Codex with an active absolute `CODEX_HOME`
- A local `withAutograph/arrusted-development` checkout

Run commands from the App Builder repository root. The mise configuration supplies Node.js, pnpm, Docker CLI, Buildx, Microsandbox, Codex CLI, and Vercel CLI versions. Don't override those tools through `PATH` or ambient Node options.

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

The first run builds the reusable development toolchain and the dependency closure for your platform. Later runs reuse both unless their inputs change.

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

Open prototype URLs in the integrated Browser. Development mode doesn't register an MCP App preview.

## Work on App Builder and Arrusted

Edit App Builder in this checkout. Next.js reloads application changes while the development task runs.

Edit Arrusted in the checkout passed to `--arrusted-root`. The task detects tracked, dirty, and non-ignored untracked changes. It stops the current services, creates a new read-only snapshot, and restarts before accepting more work. The sandbox never mounts or writes the live Arrusted checkout.

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

### Docker or Buildx can't connect

Start Docker Desktop or Docker Engine, then verify the mise-owned client can reach it:

```sh
mise exec -- docker info
mise exec -- docker buildx version
```

Rerun `mise run dev` after both commands succeed.

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

### Arrusted keeps restarting

The task restarts whenever the Arrusted fingerprint changes. Save or stop tools that rewrite files repeatedly. A restart prevents one result from mixing source versions.

### A release command rejects the checkout

Release proof requires clean committed Builder and Arrusted checkouts. Check both repositories with `git status --short`. Development accepts dirty Arrusted changes; release proof doesn't.

## Run focused validation

Run the checks closest to local development changes:

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
