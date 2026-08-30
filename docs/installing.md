# Installing Autograph App Builder

## Install before shared marketplace publication

Once the pre-release `v0.2.1` GitHub release is published, use its public
[release assets](https://github.com/withAutograph/autograph-app-builder/releases)
until the shared marketplace is available. The release contains:

- `autograph-app-builder-0.2.1.tar.gz`
- `autograph-app-builder-codex-marketplace-0.2.1.tar.gz`
- `release-receipt.json`
- `SHA256SUMS`

Download the complete asset set, verify both archive checksums and GitHub's
immutable release attestations, install, and open a new Codex task. These
commands fail closed until `v0.2.1` exists:

```sh
(
  set -eu
  release_version=0.2.1
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
and authorization-server metadata. Its creation and publication capabilities
apply only to repositories that satisfy the App Builder's explicit supported
repository contract; it does not claim support for arbitrary repositories.

Confirm that a new task exposes exactly `autograph_start`, `autograph_get`, `autograph_send`,
`autograph_respond`, and `autograph_cancel`. The bundled App Builder skill is fail-closed:
if any App Builder tool is unavailable, it stops without using another app
builder or editing a target directly.

The repository and release assets are public. The release archive is the
supported external installation path until the shared marketplace is
published.

## Install from the shared marketplace after publication

After the release is imported into the organization marketplace, register the
shared catalog and install its `autograph` listing:

```sh
(
  set -eu
  codex plugin marketplace add withAutograph/marketplace
  codex plugin add autograph-app-builder@autograph
)
```

Open a new Codex task after installation. The marketplace contains only
verified endpoint-bound packages; it never installs the loopback development
adapter from App Builder `main`. Publishing a product release does not create
the shared listing: the separate marketplace import opens a reviewed catalog
change.

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

- `autograph-app-builder-0.2.1.tar.gz`, the portable Agent Plugins package
- `autograph-app-builder-codex-marketplace-0.2.1.tar.gz`, a self-contained
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
  release_version=0.2.1
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
  mkdir autograph-app-builder-marketplace-0.2.1
  tar -xzf autograph-app-builder-codex-marketplace-0.2.1.tar.gz \
    -C autograph-app-builder-marketplace-0.2.1
  codex plugin marketplace add "$PWD/autograph-app-builder-marketplace-0.2.1"
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

Publish `v0.2.1` only through the existing tag-triggered
`.github/workflows/release.yml` workflow. Do not create or upload the release
manually. The tag may be created only after the exact release SHA has passed
the hosted proof and `AUTOGRAPH_APP_BUILDER_RELEASE_PROOF_SHA` has been set to
that same accepted SHA.

Maintainers set `AUTOGRAPH_APP_BUILDER_RELEASE_ORIGIN` to the exact deployed
HTTPS origin. A `vMAJOR.MINOR.PATCH` tag whose version matches `plugin.json`
runs the release workflow through the protected `release` environment. Before
creating the tag, an administrator must enable and read back GitHub immutable
releases, accept the exact-SHA hosted proof, and set
`AUTOGRAPH_APP_BUILDER_RELEASE_PROOF_SHA` to that SHA. The workflow requires the
exact current `main`, successful exact-SHA CI, and the accepted proof SHA. It
uses pinned Actions, validates the actual deterministic portable and Codex
marketplace archives, creates a draft, verifies every uploaded digest, and only
then publishes the version as a prerelease without marking it latest. It
requires GitHub's immutable-release attestation and separate build-provenance
attestations to verify before completing.

The archives are the immutable distribution payload behind marketplace and
client installation. The public `withAutograph/marketplace` repository imports
those verified bytes through its **Import plugin release** workflow; it does not
rebuild the package or maintain a hand-edited duplicate.
