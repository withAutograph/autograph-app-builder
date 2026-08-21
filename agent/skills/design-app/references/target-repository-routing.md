# Target Repository Reference Routing

Treat the isolated target workspace as the source of truth. Read its
`docs/README.md`, `docs/principles.md`, and `docs/contracts.md` before production
grounding when those paths exist, then select only task-relevant sources.

| Need                                       | Inspect                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| UI layers, ownership, compositions, tokens | `docs/frontend-architecture.md`, `packages/design-systems/core/`                   |
| Available reusable components              | `docs/component-port-tracker.md`, Storybook stories, package exports, tests        |
| Prototype-led one-shot flow                | `docs/diagrams/one-shot-app/`, current app-creation plans                          |
| Agent mechanics and authority              | `docs/agent-foundation.md`, `packages/agent-foundation/`                           |
| Charts and dashboards                      | `docs/dashboard-agent-evals.md`, chart composition contracts and stories           |
| Data objects and domain vocabulary         | relevant `domain-libs/` and app schemas; do not import app workflow into libraries |
| Imports and reconciliation                 | import contracts, relevant engines/modules, and existing app-owned import policy   |
| Integrations                               | `docs/integrations/` and relevant app-owned adapters/recipes                       |
| App routes and generated client            | existing route-owned apps, generated app client contracts, adoption guide          |
| Writes, drafts, history, provenance        | `docs/contracts.md`, kernel contracts, generated apply lifecycle                   |

Verify capabilities from current code, exports, Storybook, tests, and working
apps. Do not treat a prototype visual or stale tracker row as proof that the
target repository supports production behavior.

For HTML, read current semantic tokens from
`packages/design-systems/core/tokens/theme.css` when present. Reproduce only
what the self-contained artifact needs and record the source; production code
must use target-owned tokens and public components directly.
