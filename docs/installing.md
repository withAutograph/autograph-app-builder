# Installing Autograph App Builder

Autograph App Builder is distributed as two immutable, endpoint-bound archives:

- `autograph-app-builder-VERSION.tar.gz` is the portable Agent Plugins 1.0.0
  package for clients that ingest the standard directly.
- `autograph-app-builder-codex-marketplace-VERSION.tar.gz` is a derived Codex
  marketplace containing the same portable core plus Codex adapter metadata.

Every GitHub release also includes `SHA256SUMS` and a closed
`release-receipt.json` binding the source repository, commit, tree, MCP origin,
archive digests, and exact five Eve tools. Verify the checksum before extracting
either archive.

## Codex

Download and verify the Codex marketplace archive, extract it to a directory
you control, then register that extracted marketplace and install the plugin:

```sh
sha256sum --check SHA256SUMS --ignore-missing
mkdir autograph-app-builder-marketplace
tar -xzf autograph-app-builder-codex-marketplace-VERSION.tar.gz \
  -C autograph-app-builder-marketplace
codex plugin marketplace add "$PWD/autograph-app-builder-marketplace"
codex plugin add autograph-app-builder@autograph
```

Open a new Codex task after installation. Codex will complete OAuth on first
use. Confirm that the connection exposes exactly `eve_start`, `eve_get`,
`eve_send`, `eve_respond`, and `eve_cancel`. The bundled Eve skill is
fail-closed: if any Eve tool is unavailable, it stops without using another app
builder or editing a target directly.

## Other Agent Plugins clients

Download and verify the portable archive, then extract it into the plugin
directory used by the client:

```sh
sha256sum --check SHA256SUMS --ignore-missing
tar -xzf autograph-app-builder-VERSION.tar.gz
```

The extracted `autograph-app-builder/` directory is the portable plugin root.
It contains the standard `plugin.json`, `mcp.json`, `skills/`, and `LICENSE`
entries. Authentication is performed by the client against the protected
resource and authorization-server metadata advertised by the bound MCP origin;
no bearer token or credential is embedded in the package.

Client-specific installation UX is outside Agent Plugins 1.0.0. Follow the
client's documented procedure for adding a local Agent Plugin directory when it
does not provide a marketplace command.

## Maintainers

Set the repository variable `AUTOGRAPH_APP_BUILDER_RELEASE_ORIGIN` to the exact
deployed HTTPS origin. A `vMAJOR.MINOR.PATCH` tag whose version matches
`plugin.json` runs the release workflow. It rebuilds the deterministic archives,
validates the portable package and client fixtures, and publishes only the
sealed assets and receipts.
