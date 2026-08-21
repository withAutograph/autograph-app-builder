# Autograph App Builder

Autograph App Builder is a durable [Eve](https://github.com/vercel/eve) agent
and portable Agent Plugin for designing and creating apps in explicitly
supported repositories. Codex is the first user-facing entrypoint.

The project is based on
[`jasonmorganson/eve-agent-plugin`](https://github.com/jasonmorganson/eve-agent-plugin)
without changing that source repository.

## Current supported workflow

The agent uses one workflow for a new-template source or an existing repository:

1. inspect the source with the versioned, non-executing V0 adapter;
2. obtain approval before creating an isolated workspace at the exact source SHA;
3. design and prototype the app, then obtain explicit AppSpec acceptance;
4. obtain separate source/topology approval before applying the canonical target command;
5. produce one reviewed change set; and
6. publish only after a separate destination-specific approval.

The initial adapter supports the known `withAutograph/arrusted-development`
repository family and fails closed on drift. It deliberately does not infer
workflows for arbitrary repositories and does not use a target-owned repository
template manifest.

## Included surfaces

- Eve `0.38.3` with durable sessions and human-in-the-loop approvals.
- The four app-creation skills: `create-app`, `design-app`,
  `plan-app-creation`, and `scaffold-app-workspace`.
- A purpose-built supported-template eligibility adapter.
- An approval-gated isolated Git worktree tool.
- Five public MCP operations: `eve_start`, `eve_get`, `eve_send`,
  `eve_respond`, and `eve_cancel`.
- A loopback-only local MCP-to-Eve adapter.
- Deterministic unit tests and an Eve eval that drives the real HTTP session
  surface with a fixture model.

## Run the Eve agent locally

Use Node.js 24 and pnpm 11.7.0:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:agent
pnpm exec eve dev
```

For a non-interactive smoke test through Eve itself:

```bash
APP_BUILDER_TEST_MODEL=1 pnpm exec eve invoke \
  "What are your app builder capabilities?"
```

For local repository access, set `REPOSITORY_LOCAL_ROOTS` to a
platform-delimited allowlist of absolute roots. `REPOSITORY_WORKSPACE_ROOT` may
name the directory that owns isolated worktrees; otherwise the operating-system
temporary directory is used.

## Use the local MCP façade

Run Eve and the Next.js host on separate loopback ports. Set
`APP_BUILDER_LOCAL_ADAPTER=1` and `EVE_AGENT_HOST` on the Next.js host so its
five MCP operations call the local Eve channel. The adapter rejects non-loopback
hosts and is never enabled implicitly.

The portable manifest keeps a placeholder HTTPS endpoint until a separately
approved deployment exists:

```bash
pnpm configure --origin https://your-approved-deployment.example
pnpm validate:release
```

Never put bearer tokens or secrets in `mcp.json` or `.app.json`.

## Authority boundary

AppSpec acceptance, target command execution, source/topology mutation,
publication, release activation, provider provisioning, deployment, tenant
activation, and Production readiness are distinct authorities. A valid proposal
or isolated-workspace receipt proves none of the later outcomes.

Hosted identity, durable cross-process idempotency, and provider resources are
still gated by [the implementation gates](docs/implementation-gates.md).

## License

MIT
