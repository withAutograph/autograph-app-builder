# Installing Autograph App Builder

## Recommended: install from the Codex marketplace

Install Autograph App Builder from its listing in the shared Autograph
marketplace:

1. Open **Autograph App Builder** in the Codex plugin marketplace.
2. Select **Install**.
3. Complete OAuth when Codex prompts for access.
4. Open a new Codex task and mention `@Autograph App Builder`.

You don't need to download an archive, extract files, register a Model Context
Protocol (MCP) server, or manage a bearer token. The marketplace package defines
the MCP origin. Codex handles OAuth through the origin's protected-resource and
authorization-server metadata.

Confirm that a new task exposes exactly `eve_start`, `eve_get`, `eve_send`,
`eve_respond`, and `eve_cancel`. The bundled Eve skill is fail-closed: if any Eve
tool is unavailable, it stops without using another app builder or editing a
target directly.

### Install with the Codex command-line interface

When the shared `autograph` marketplace is already configured, run the
equivalent command-line interface (CLI) installation:

```sh
codex plugin add autograph-app-builder@autograph
```

Open a new Codex task after installation. This command is an alternative to
selecting **Install** in the UI; it is not a separate package format.

## Other Agent Plugins clients

If your client implements [Agent Plugins 1.0.0](https://agent-plugins.org/),
install Autograph App Builder through its plugin catalog or “add plugin” flow.
The canonical portable root contains:

- `plugin.json`
- `mcp.json`
- `skills/`
- `LICENSE`

The release-bound `mcp.json` declares the Streamable HTTP endpoint. Your client
completes OAuth against the endpoint's metadata. The plugin contains no
credential.

Agent Plugins standardizes the portable package, not each client's catalog or
installation UI. Use your client's documented plugin-install command when it
doesn't offer a catalog listing.

## Offline and manual installation

Use archive installation only for offline environments, client testing, and
release verification. It is not the normal installation path.

Every release contains:

- `autograph-app-builder-VERSION.tar.gz`, the portable Agent Plugins package
- `autograph-app-builder-codex-marketplace-VERSION.tar.gz`, a self-contained
  local Codex marketplace
- `SHA256SUMS`
- `release-receipt.json`, which binds the source repository, commit, tree, MCP
  origin, archive digests, and exact five Eve tools

### Portable archive

Verify the files from the release directory and extract the portable package:

```sh
sha256sum --check SHA256SUMS --ignore-missing
tar -xzf autograph-app-builder-VERSION.tar.gz
```

Add the extracted `autograph-app-builder/` directory using the client’s local
Agent Plugin installation procedure.

### Local Codex marketplace archive

For an offline or manually managed Codex installation:

```sh
sha256sum --check SHA256SUMS --ignore-missing
mkdir autograph-app-builder-marketplace
tar -xzf autograph-app-builder-codex-marketplace-VERSION.tar.gz \
  -C autograph-app-builder-marketplace
codex plugin marketplace add "$PWD/autograph-app-builder-marketplace"
codex plugin add autograph-app-builder@autograph
```

This creates a local marketplace only. Prefer the shared marketplace listing
for ordinary installations and updates.

## Local development checkout

Run the plugin and Eve service from a source checkout when developing the
project:

```sh
mise run dependencies:install
mise run package:validate
mise run local:dev
```

The source `mcp.json` intentionally uses a loopback development endpoint. Do not
publish or redistribute source-checkout bytes as an endpoint-bound release.

## Maintainer release flow

Maintainers set `AUTOGRAPH_APP_BUILDER_RELEASE_ORIGIN` to the exact deployed
HTTPS origin. A `vMAJOR.MINOR.PATCH` tag whose version matches `plugin.json`
runs the release workflow. It validates and publishes deterministic portable
and Codex marketplace archives plus their checksums and closed receipt.

The archives are the immutable distribution payload behind marketplace and
client installation. They are not the primary end-user instructions.
