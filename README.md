# Autograph App Builder

Autograph App Builder is a portable [Agent Plugin](https://agent-plugins.org/)
for turning product ideas into working applications. Codex is the first
entrypoint, and the public MCP contract exposes exactly five tools:
`autograph_start`, `autograph_get`, `autograph_send`, `autograph_respond`, and
`autograph_cancel`.

## Install

```sh
codex plugin marketplace add withAutograph/marketplace
codex plugin add app-builder@autograph
```

Complete OAuth, open a new task, and mention `@Autograph App Builder`. See
[installing](docs/installing.md) for client-specific details.

## Develop locally

Use `mise run dev`. Edit live code, let HMR or the affected process reload, and
retry the behavior. Vercel Sandbox is the execution backend and project-scoped
OIDC is the provider credential boundary. The checkout is writable and new or
generated files are expected.

Do not rebuild packages, run broad suites, publish, or deploy after every edit.
Caches are optional accelerators, and inspection is best-effort. The builder
does not block on exact versions, source drift, package layout, topology,
receipts, digests, quotas, or other speculative conditions. See the
[local-development lifecycle](docs/local-development-lifecycle.md) and
[execution boundaries](docs/implementation-gates.md).

The only pre-operation controls are credential/cross-user isolation and
approval before outward effects. Actual provider or repository command errors
are handled when they occur.

## License

MIT
