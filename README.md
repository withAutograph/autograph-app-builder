# Autograph App Builder

Autograph App Builder is a durable [Eve](https://github.com/vercel/eve) agent
and portable Agent Plugin for designing and creating apps in explicitly
supported repositories. Codex is the first user-facing entrypoint.

The project is based on
[`jasonmorganson/eve-agent-plugin`](https://github.com/jasonmorganson/eve-agent-plugin)
without changing that source repository.

## Current implemented workflow

The current local slice supports an existing eligible checkout:

1. inspect the source with the versioned, non-executing V0 adapter;
2. bind the reviewed source SHA and eligibility digest to an approval request;
3. materialize that exact Git tree at `/workspace/repository` inside the Eve
   session sandbox; and
4. expose it read-only to the agent while unrestricted shell and file writes
   remain disabled.

Planning, prototype artifact delivery, apply, reviewed change-set generation,
local publication, GitHub draft-PR publication, and fresh-template acquisition
remain fail-closed until their typed tools and approval receipts land. The
skills describe the intended workflow, but they must use builder-owned
operations; they do not authorize raw target commands.

The initial adapter supports the known `withAutograph/arrusted-development`
repository family and fails closed on drift. It deliberately does not infer
workflows for arbitrary repositories and does not use a target-owned repository
template manifest.

## Included surfaces

- Eve `0.38.3` with durable sessions and human-in-the-loop approvals.
- The four app-creation skills: `create-app`, `design-app`,
  `plan-app-creation`, and `scaffold-app-workspace`.
- A purpose-built supported-template eligibility adapter.
- An approval-gated, digest-bound Eve sandbox workspace tool.
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
platform-delimited allowlist of absolute roots. The reviewed tree is copied into
the durable Eve session sandbox; the source checkout is not mutated.

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
