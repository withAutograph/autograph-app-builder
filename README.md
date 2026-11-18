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

Local development is the default when changing Builder itself. Start with the
[run-and-use quickstart](docs/local-development-lifecycle.md#run-and-use-the-local-builder)
for the launch command, client connection, and normal product interaction.
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

To review the experience, run `mise run storybook:dev` and open
`http://localhost:6006`. Select **Journey → Start to finish** and step through
the numbered stories. The configuration, handoff, and request cards use
representative fixture data. Client conversation text is explicitly marked as
illustrative; generated prototypes, app results, provider setup, and delivery
vary by session and are not executed by these stories. The other Storybook
sections contain additional component, connection, and recovery states.
For a direct client conversation, choose **Journey → Direct chat**. Its
numbered stories show a cumulative example from the brief through review and an
optional draft on GitHub. **Other situations** covers sign-in, GitHub connection,
questions, waiting, cancellation, failures, and decisions that are pending or
could not be confirmed. It also includes optional protected-preview setup,
project and removal approvals, plus delayed-progress and uncertain-outcome
examples. These are representative states, not an exhaustive
catalog of every possible message or provider failure.

Use `mise run eval:design -- --help` to score an existing preview on demand.
[Design-quality evals](docs/design-quality-evals.md) report Arrusted token
evidence, responsive/browser findings, and an advisory AI design score without
regenerating the app or adding a runtime gate.
Use `--additional-desktop-size WIDTHxHEIGHT` to add one explicit desktop window
observation; the default three desktop captures remain unchanged.

The only pre-operation controls are credential/cross-user isolation and
approval before outward effects. Actual provider or repository command errors
are handled when they occur.

## License

MIT
