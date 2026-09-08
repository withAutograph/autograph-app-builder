# Target Repository Reference Routing

Treat the isolated target workspace as the source of truth. Read its
`docs/README.md`, `docs/principles.md`, and `docs/contracts.md` before production
grounding when those paths exist, then select only task-relevant sources.

| Need                                       | Inspect                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| UI layers, ownership, compositions, tokens | `docs/frontend-architecture.md`, `packages/design-systems/core/`                                    |
| Available reusable components              | public package exports, then relevant Storybook stories/examples                                    |
| Task-matched UI examples                   | `docs/app-builder-ui-catalog.json` and its linked record-review, form, and overview/detail examples |
| Production layout and responsive context   | representative app consumers using the selected components and compositions                         |
| Prototype-led one-shot flow                | `docs/diagrams/one-shot-app/`, current app-creation plans                                           |
| Agent mechanics and authority              | `docs/agent-foundation.md`, `packages/agent-foundation/`                                            |
| Charts and dashboards                      | `docs/dashboard-agent-evals.md`, chart composition contracts and stories                            |
| Data objects and domain vocabulary         | relevant `domain-libs/` and app schemas; do not import app workflow into libraries                  |
| Imports and reconciliation                 | import contracts, relevant engines/modules, and existing app-owned import policy                    |
| Integrations                               | `docs/integrations/` and relevant app-owned adapters/recipes                                        |
| App routes and generated client            | existing route-owned apps, generated app client contracts, adoption guide                           |
| Writes, drafts, history, provenance        | `docs/contracts.md`, kernel contracts, generated apply lifecycle                                    |

Verify capabilities from current code, exports, Storybook, tests, and working
apps. Do not treat a prototype visual or stale tracker row as proof that the
target repository supports production behavior.

For the component-backed UI, read current semantic tokens from
`packages/design-systems/core/tokens/theme.css` when present and use the
target-owned token entrypoint directly. Do not reproduce a literal token table
or infer a palette from screenshots when the prepared source provides it.

The catalog is a discovery shortcut, not a runtime allowlist. Follow links only
for the task at hand. If a link or listed API is stale, inspect the current public
exports and use the actual renderer error to adapt. Never require a catalog
version or an example to exist before continuing.

Read how the selected composition handles narrow screens, selection, empty data,
primary actions, and required providers. Do not assume all tables have selection
or all details panels manage navigation. For forms, prefer supported field and
form components; for overviews, start with the information needed for the next
decision, not decorative metrics. Reuse the same route composition when building
the app rather than translating the preview back into a new layout.
