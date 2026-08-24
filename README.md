# Autograph App Builder

Autograph App Builder is a durable [Eve](https://github.com/vercel/eve) agent
and portable [Agent Plugin](https://agent-plugins.org/) for designing and
creating apps in explicitly supported repositories. Codex is the first
user-facing entrypoint.

The project is based on
[`jasonmorganson/eve-agent-plugin`](https://github.com/jasonmorganson/eve-agent-plugin)
without changing that source repository.

## Current implemented workflow

The current local slice supports an existing eligible checkout or an explicitly
allowlisted fresh-template checkout:

1. inspect the source with the versioned, non-executing V0 adapter;
2. emit a canonical receipt binding source kind, exact SHA, eligibility,
   supported-template contract, and release-disabled state;
3. for a fresh-template source, require a separate acquisition approval that
   does not clone, copy, or create a destination repository;
4. materialize that exact approved receipt at `/workspace/repository` inside the Eve
   session sandbox; and
5. persist the prepared phase in durable Eve state and expose a verified,
   read-only workspace-status receipt while unrestricted shell and file writes
   remain disabled;
6. record and exactly read approval-bound prototype artifact receipts without
   writing the target workspace; and
7. accept a recorded AppSpec revision against that receipt; and
8. after a distinct approval, verify and materialize the image-internal,
   target-bound offline dependency closure only in the builder-owned planning
   overlay; and
9. after another distinct approval, run only the fixed target identity and planning
   commands against a builder-owned input overlay and record their strictly
   parsed, digest-bound receipts; and
10. after a separate apply approval and a fresh readiness check, invoke only the
    fixed target apply command in a fresh builder-owned overlay, recording exact
    pre/post tree and normalized changed-content receipts; and
11. after a separate validation approval, persist a pending attempt before
    execution, then run only the fixed check and test commands in independent
    builder-owned copies of the exact applied tree and record a durable pass or
    recovery-required failure receipt without change-review or publication
    claims.

Prototype artifacts are durable, session-scoped receipts under
`prototype/<app-id>/`; only `app-spec.md`, `decisions.md`, and `index.html`
are accepted. Recording a new artifact revision invalidates any accepted
AppSpec and downstream proposal. Artifact recording never writes the target
workspace. The durable workflow uses its V5 state key so older, synthetic, or
unverified-cache planning state cannot be mistaken for target identity or
planning receipts;
an intact prepared sandbox can still be recovered and reviewed again.

The real target commands remain fail-closed until an immutable cache-bearing
sandbox image is configured and its fixed manifest and archive bytes are
verified inside the sandbox. No free-form cache digest is accepted. Tests use an
injectable executor and never run Arrusted commands. Apply is proposal-bound,
approval-gated, and limited to a fresh builder-owned overlay; a failed attempt
persists recovery-required state and is never replayed automatically. Validation,
is separately approved, runs each fixed command against an independent copy,
and persists pending state before execution so an interrupted attempt is never
redispatched automatically. Reviewed change-set generation, local publication, GitHub
draft-PR publication, cloning, destination-repository creation, and remote
template acquisition remain fail-closed until
their typed tools and approval receipts land. The skills describe the intended
workflow, but they must use builder-owned operations; they do not authorize raw
target commands.

The initial adapter supports the known `withAutograph/arrusted-development`
repository family and fails closed on drift. It deliberately does not infer
workflows for arbitrary repositories and does not use a target-owned repository
template manifest.

## Included surfaces

- Eve `0.43.0` with durable sessions and human-in-the-loop approvals.
- The four app-creation skills: `create-app`, `design-app`,
  `plan-app-creation`, and `scaffold-app-workspace`.
- A purpose-built supported-template eligibility adapter and canonical local
  source receipt that distinguishes existing-repository from fresh-template.
- An approval-gated, digest-bound Eve sandbox workspace tool.
- Durable prepared-phase state plus a read-only workspace integrity tool.
- Approval-bound, session-scoped prototype artifact receipts with exact-digest
  readback and a content-free workflow-status receipt.
- Approval-bound AppSpec acceptance, separate offline dependency preparation,
  and fixed bounded target identity/planning commands. Strict receipts bind
  source, workspace, toolchain, observed cache bytes, and artifact revision
  without writing the prepared target workspace.
- Proposal-bound target apply in a fresh builder-owned overlay, with a separate
  approval, a repeated readiness check, normalized pre/post tree evidence, and
  durable success or partial-failure receipts.
- Approval-bound fixed target validation in independent exact-tree overlays,
  with an atomic durable claim, protected source/cache/planning/apply drift
  detection, passed or recovery-required failure receipts, and no
  validation-generated files admitted to the future reviewed change set.
- A fixed, read-only sandbox toolchain inspection receipt; it cannot accept
  commands, install tools, or authorize target repository execution.
- Five public MCP operations: `eve_start`, `eve_get`, `eve_send`,
  `eve_respond`, and `eve_cancel`.
- A loopback-only local MCP-to-Eve adapter.
- Deterministic unit tests and Eve evals that drive the real HTTP session
  surface with a fixture model, including approval and cancellation paths.

## Portable plugin package

The repository root is the cross-client Agent Plugins 1.0.0 package:

- `plugin.json` is the canonical portable manifest;
- `skills/` contains portable Agent Skills;
- `mcp.json` declares the Streamable HTTP MCP server; and
- `schemas/agent-plugins/1.0.0/` vendors the canonical versioned schemas used by
  `pnpm validate:plugin`.

Client adapters are additive. `.codex-plugin/plugin.json` and `.app.json` are
generated Codex/OpenAI integration files; they do not replace or redefine the
portable package. Other compatible clients can install the same root package
and consume its skills and MCP declaration according to their own distribution,
permission, and authentication model.

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

To inspect the fixed tool allowlist through Eve's real sandbox backend:

```bash
pnpm test:sandbox-toolchain
```

The inspection is observational and remains not-ready unless an externally
built, preloaded OCI image is configured through
`APP_BUILDER_SANDBOX_IMAGE=<image>@sha256:<digest>`. The agent never pulls,
builds, or publishes that image: its pinned microsandbox backend uses
`pullPolicy: "never"` and deny-all network policy. The image must contain Git,
`mise 2026.8.12`, `bun 1.3.14`, and the target-bound external dependency
closure; the receipt verifies the exact versions and cache bytes
before any future typed target command can be enabled. See [the implementation
gates](docs/implementation-gates.md). The reproducible `linux/arm64` image
source and its digest-resolution procedure are documented in
[`containers/eve-sandbox`](containers/eve-sandbox/README.md).

For local source access, set `REPOSITORY_LOCAL_ROOTS` to a platform-delimited
allowlist of absolute roots. Fresh-template acquisition means approving one
exact local checkout receipt; it never means cloning or creating a destination
repository. A separately approved preparation copies the reviewed tree into the
durable Eve session sandbox; the source checkout is not mutated.

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
