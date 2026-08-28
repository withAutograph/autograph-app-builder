# Public MCP contract

Autograph App Builder exposes one Streamable HTTP MCP endpoint at `/mcp`.
Discovery returns exactly these five tools:

| Public tool         | Internal service operation  |
| ------------------- | --------------------------- |
| `autograph_start`   | `EveSessionService.start`   |
| `autograph_get`     | `EveSessionService.get`     |
| `autograph_send`    | `EveSessionService.send`    |
| `autograph_respond` | `EveSessionService.respond` |
| `autograph_cancel`  | `EveSessionService.cancel`  |

The public names are a closed registry, not aliases. The endpoint does not
register the internal runtime's tool names, and there is no versioned or
compatibility endpoint.

All five tools use the existing session schemas and the same request-scoped
service implementation. That shared implementation owns durable session IDs,
cursor pagination, sanitized errors, complete approval-batch validation,
tenant and audience isolation, idempotent mutation retries, unknown-submission
handling, lost-response recovery, and cooperative cancellation settlement.
The internal Eve routes, adapter session identifiers, storage records, and
transport protocol remain implementation details.

Hosted authorization advertises the matching `autograph:*` scopes. A caller
must hold `autograph:session` before the request-scoped tenant service is
constructed; operation-specific scope checks remain inside the shared service.
