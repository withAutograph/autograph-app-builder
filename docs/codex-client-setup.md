# Dedicated Codex public OAuth client

This deployment operation registers `autograph-codex-desktop` for the existing
Builder authorization server. It is separate from CIMD and dynamic registration.
It creates no user, workspace, membership, consent, access token, or refresh token.
Normal sign-in and explicit consent still determine the account and workspace.

## Registration policy

The client uses public native authentication (`none`), no client secret, S256
PKCE, and only authorization-code and refresh-token grants. Consent is required.
Its scopes are the existing `previewOAuthScopes`: `autograph:session`,
`autograph:start`, `autograph:get`, `autograph:send`, `autograph:respond`,
`autograph:cancel`, and `offline_access`. Client-credentials scopes are empty.
It is bound to exactly one existing, enabled Builder `/mcp` resource.

The sole registered callback is `http://127.0.0.1/callback`. The installed
provider supports RFC 8252 loopback-IP port variance: the scheme, IP host, path,
and query must match, while Codex may use its chosen listener port. This does not
permit another hostname or callback path. Explicitly configure
`oauth.callback_url = "http://127.0.0.1/callback"` so Codex uses this callback
rather than appending its server-specific callback ID. This plain callback also
requires the authorization server discovery metadata to supply its issuer and
`authorization_response_iss_parameter_supported: true`; Codex 0.162.1 otherwise
uses its server-bound callback behavior. Confirm the selected server advertises
that existing protocol support before using this registration; do not weaken
issuer validation or substitute a callback. Codex chooses the loopback listener
port unless a listener port is already configured. If an explicit callback URL
includes a port, its listener port must match it.

## Explicit deployment setup

Run this deployment operation under authorization covering the selected
deployment, its existing Auth database, and this client registration. Reuse
existing authorization that covers these effects; obtain approval only for
uncovered effects. In that authorized deployment context, provide
`DATABASE_URL` through the existing private environment mechanism, then run:

```sh
mise run hosted:codex-client-setup -- --resource https://builder.example/mcp
```

Replace the example resource with the selected Builder's exact resource. The
task uses the existing trusted launcher and private stdin file-descriptor
transport, removes `DATABASE_URL` from the launched process environment, and
does not put the database URL in arguments or output.

The transaction creates the dedicated client and its resource link together.
An existing client is only verified: setup does not change it or repair a missing
resource link. A conflicting or partially configured client fails without
overwriting other clients or grants. Database failures remain failures.
Successful output contains only the public client ID, resource, and readiness.

Do not invoke setup from a request handler, login, readiness check, or startup.
The existing DCR, CIMD validation, and client-management authorization policies
remain unchanged.

## Reconnect the existing owner

After authorized setup succeeds, preserve the complete effective HTTP server
definition, including its `url`, `oauth_resource`, scopes, and other existing
fields. Supply both `oauth.client_id = "autograph-codex-desktop"` and
`oauth.callback_url = "http://127.0.0.1/callback"` through a supported complete
server configuration or adoption of the hosted plugin configuration below.
A complete host configuration with the same canonical `app-builder` server key
shadows the plugin server definition as a whole; preserve its URL, resource,
scopes, headers, timeouts, and policies when intentionally using that route.
Normal adoption and reload of the updated plugin is the preferred package path.
A standalone partial `[mcp_servers.<id>.oauth]` table is not a valid transport
definition and must not be assumed to inherit the plugin's server fields.
Do not add a client secret, replace another client's identity, reset the
profile, or blindly re-add the existing server.

The [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents this pre-registered-client setting and the server-specific
`oauth.callback_url` and `oauth.callback_port` settings. The
[official MCP guide](https://learn.chatgpt.com/docs/extend/mcp) explains why a
pre-registered client needs an explicit callback to avoid the appended ID.

Use the normal `codex mcp login <existing-server-name>` flow in that same
profile. Sign in with the existing Builder account and approve only the
existing resource and listed scopes. Keep credentials in the client's supported
credential store; do not copy tokens or callback URLs into logs or documentation.

After login, use ordinary `autograph_get` for the saved public session and cursor.
A missing session requires checking the selected account/workspace; it does not
authorize creating a replacement session or transferring ownership. Continue
through the public product tools with the original approvals and saved context.

## Hosted Codex packages

The hosted OpenAI adapter generated with `build-openai-package.mts --endpoint`
and the Codex marketplace adapter generated by `build-portable-release.mts`
include both nested `oauth.client_id: "autograph-codex-desktop"` and
`oauth.callback_url: "http://127.0.0.1/callback"` in their complete Codex
`.mcp.json` HTTP server entry. The installed Codex 0.162.1 plugin loader supports these
nested fields. Registration remains the separate approved deployment operation
above; generating a package does not register the client.

Default local development generation and the checked-in localhost adapter keep
their existing authentication behavior. Portable adapters for other clients and
their CIMD configuration are unchanged.

A future hosted plugin release carries this setting for clients adopting that
release. It does not prove that an already installed connection has reloaded its
configuration or credentials. For the current connection, preserve the existing
profile and complete effective HTTP server definition and follow the normal
reconnect steps above.
