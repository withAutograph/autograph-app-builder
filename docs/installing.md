# Installing Autograph App Builder

## Install before shared marketplace publication

Until the shared marketplace is published, download these files from the public
[GitHub releases](https://github.com/withAutograph/autograph-app-builder/releases):

- `autograph-app-builder-codex-marketplace-VERSION.tar.gz`
- `SHA256SUMS`

Then verify, install, and open a new Codex task:

```sh
sha256sum --check SHA256SUMS --ignore-missing
mkdir autograph-app-builder-marketplace
tar -xzf autograph-app-builder-codex-marketplace-VERSION.tar.gz \
  -C autograph-app-builder-marketplace
codex plugin marketplace add "$PWD/autograph-app-builder-marketplace"
codex plugin add autograph-app-builder@autograph
```

The release package defines the Model Context Protocol (MCP) origin and contains
no credential. Codex completes OAuth against that origin's protected-resource
and authorization-server metadata.

Confirm that a new task exposes exactly `eve_start`, `eve_get`, `eve_send`,
`eve_respond`, and `eve_cancel`. The bundled Eve skill is fail-closed: if any Eve
tool is unavailable, it stops without using another app builder or editing a
target directly.

The repository and release assets are public. The release archive is the
supported external installation path until the shared marketplace is
published.

## Install from the shared marketplace after publication

After an administrator publishes and configures the shared `autograph`
marketplace, install through its Codex listing or run:

```sh
codex plugin add autograph-app-builder@autograph
```

Open a new Codex task after installation. Publishing a release does not create
the shared listing; marketplace publication is a separate distribution action.

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

## Release contents and manual installation

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

This creates a local marketplace. It is the supported Codex installation path
until a separately managed shared marketplace listing is published.

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
client installation. Publishing a shared marketplace or client catalog entry
is a separate distribution action.
