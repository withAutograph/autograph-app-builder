# Protected app runtime environment

A generated app receives its own runtime database credential and public Gateway
verification configuration. It receives no Auth realm SQL connection, Better Auth
signing secret, installer or bootstrap connection, or another app's credential.

The protected plan's optional `deploymentBoundary` retains compatibility with
historical journal inspection. Operational binding requires this boundary and
an authenticated owner authority matching it. Legacy records can be inspected;
they cannot project the former shared Auth environment into an app.

## Deployment identities

The private planner reads current provider state and freezes the team, project,
deployment, and Preview branch identities for the app and Gateway, plus the
separate operator deployment identity. These three projects must differ. The app
project and branch match the selected app; the Gateway project and branch match
`publicGateway`. The owner's issuer, audience, user, and workspace bind the plan
to the authenticated continuation.

These fields are not provider proof by themselves. Before publishing bindings,
the private adapter must independently read current project ownership,
deployment project/environment/branch association, and the Gateway's public
verification configuration. A caller-supplied flag or plausible project ID
cannot replace that read. Vercel Services share project environment variables;
filtering one returned dictionary does not establish physical isolation.

## App projection

Exactly these environment keys are permitted:

- `<APP_ID>_DATABASE_URL`: the selected app database and its runtime role, with
  verified TLS. It is never the migrator or Auth realm role.
- `PLATFORM_PUBLIC_ORIGIN`: the frozen public Gateway origin and principal issuer.
- `PLATFORM_ORIGIN`: the independently bound Gateway origin used by normal zone
  transport.
- `PLATFORM_JWKS_URL`: that Gateway's exact `/_platform/jwks.json` endpoint.

The app's audience and actor/organization scope come from its trusted owned
binding and compiled app identity. They are not freely supplied request headers
or an environment signing key. The existing Arrusted public-JWKS verifier checks
the principal's issuer, audience, request method/path, and owned app scope. Its
verification adapter needs no Better Auth secret or realm database connection.

Current provider readback, protected role grants and revoke fencing, generated
app behavior, and continuity must still be observed before declaring the hosted
app ready. This contract does not establish those outcomes.
