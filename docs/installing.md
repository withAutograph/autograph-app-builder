# Installing Autograph App Builder

## Install before shared marketplace publication

Once the pre-release `v0.2.0` GitHub release is published, use its public
[release assets](https://github.com/withAutograph/autograph-app-builder/releases)
until the shared marketplace is available. The release contains:

- `autograph-app-builder-0.2.0.tar.gz`
- `autograph-app-builder-codex-marketplace-0.2.0.tar.gz`
- `release-receipt.json`
- `SHA256SUMS`

Download the complete asset set, verify both archive checksums and GitHub's
immutable release attestations, install, and open a new Codex task. These
commands fail closed until `v0.2.0` exists:

```sh
(
  set -eu
  release_version=0.2.0
  release_dir="$PWD/autograph-app-builder-release-$release_version"
  marketplace_dir="$PWD/autograph-app-builder-marketplace-$release_version"
  mkdir "$release_dir" "$marketplace_dir"
  gh release download "v$release_version" \
    --repo withAutograph/autograph-app-builder \
    --dir "$release_dir"
  cd "$release_dir"
  shasum -a 256 -c SHA256SUMS
  gh release verify "v$release_version" \
    --repo withAutograph/autograph-app-builder
  gh release verify-asset "v$release_version" \
    "autograph-app-builder-codex-marketplace-$release_version.tar.gz" \
    --repo withAutograph/autograph-app-builder
  tar -xzf \
    "autograph-app-builder-codex-marketplace-$release_version.tar.gz" \
    -C "$marketplace_dir"
  codex plugin marketplace add "$marketplace_dir"
  codex plugin add autograph-app-builder@autograph
)
```

The release package defines the Model Context Protocol (MCP) origin and contains
no credential. Codex completes OAuth against that origin's protected-resource
and authorization-server metadata.

Confirm that a new task exposes exactly `autograph_start`, `autograph_get`, `autograph_send`,
`autograph_respond`, and `autograph_cancel`. The bundled App Builder skill is fail-closed:
if any App Builder tool is unavailable, it stops without using another app
builder or editing a target directly.

The repository and release assets are public. The release archive is the
supported external installation path until the shared marketplace is
published.

## Install from the shared marketplace after publication

After the immutable marketplace tag is published, register that exact Git ref
and install its `autograph` listing:

```sh
(
  set -eu
  codex plugin marketplace add withAutograph/autograph-app-builder \
    --ref codex-marketplace-v0.2.0
  codex plugin add autograph-app-builder@autograph
)
```

Open a new Codex task after installation. The marketplace tag contains only the
generated catalog and endpoint-bound plugin; it never installs the loopback
development adapter from `main`. Publishing a release does not create the
shared listing; marketplace publication is a separate distribution action.

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

- `autograph-app-builder-0.2.0.tar.gz`, the portable Agent Plugins package
- `autograph-app-builder-codex-marketplace-0.2.0.tar.gz`, a self-contained
  local Codex marketplace
- `SHA256SUMS`
- `release-receipt.json`, which binds the source repository, commit, tree, MCP
  origin, archive digests, and exact five Autograph tools

### Portable archive

Download the complete release, verify its checksums and immutable attestations,
then extract the portable archive:

```sh
(
  set -eu
  release_version=0.2.0
  release_dir="$PWD/autograph-app-builder-release-$release_version"
  mkdir "$release_dir"
  gh release download "v$release_version" \
    --repo withAutograph/autograph-app-builder \
    --dir "$release_dir"
  cd "$release_dir"
  shasum -a 256 -c SHA256SUMS
  gh release verify "v$release_version" \
    --repo withAutograph/autograph-app-builder
  gh release verify-asset "v$release_version" \
    "autograph-app-builder-$release_version.tar.gz" \
    --repo withAutograph/autograph-app-builder
  tar -xzf "autograph-app-builder-$release_version.tar.gz"
)
```

Add the extracted `$release_dir/autograph-app-builder/` directory using the
client’s local Agent Plugin installation procedure.

### Local Codex marketplace archive

For an offline or manually managed Codex installation, use the complete
download, verification, extraction, and installation command in
**Install before shared marketplace publication** above. It creates a local
marketplace and is the supported Codex installation path until a separately
managed shared marketplace listing is published.

### Upgrade a local Codex marketplace installation

Download and verify the new release first. Then remove the installed plugin and
old marketplace registration before adding the newly extracted, versioned
marketplace directory:

```sh
(
  set -eu
  codex plugin remove autograph-app-builder@autograph
  codex plugin marketplace remove autograph
  mkdir autograph-app-builder-marketplace-0.2.0
  tar -xzf autograph-app-builder-codex-marketplace-0.2.0.tar.gz \
    -C autograph-app-builder-marketplace-0.2.0
  codex plugin marketplace add "$PWD/autograph-app-builder-marketplace-0.2.0"
  codex plugin add autograph-app-builder@autograph
)
```

Open a new Codex task after installation or upgrade so the client reloads the
plugin and its MCP connection.

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
runs the release workflow through the protected `release` environment. Before
creating the tag, an administrator must enable and read back GitHub immutable
releases, accept the exact-SHA hosted proof, and set
`AUTOGRAPH_APP_BUILDER_RELEASE_PROOF_SHA` to that SHA. The workflow requires the
exact current `main`, successful exact-SHA CI, and the accepted proof SHA. It
uses pinned Actions, validates the actual deterministic portable and Codex
marketplace archives, creates a draft, verifies every uploaded digest, and only
then publishes. It requires GitHub's immutable-release attestation and separate
build-provenance attestations to verify before completing.

The archives are the immutable distribution payload behind marketplace and
client installation. Publishing a shared marketplace or client catalog entry
is a separate distribution action.
