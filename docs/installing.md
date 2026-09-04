# Installing Autograph App Builder

## Install before shared marketplace publication

Once the pre-release `v0.2.12` GitHub release is published, use its public
[release assets](https://github.com/withAutograph/autograph-app-builder/releases)
until the shared marketplace is available. The release contains:

- `app-builder-0.2.12.tar.gz`
- `app-builder-codex-marketplace-0.2.12.tar.gz`
- `release-receipt.json`
- `promotion-receipt.json`
- `SHA256SUMS`

Download the complete asset set, verify both archive checksums and GitHub's
immutable release state, install, and open a new Codex task. These
commands fail closed until `v0.2.12` exists:

```sh
(
  set -eu
  release_version=0.2.12
  release_dir="$PWD/app-builder-release-$release_version"
  marketplace_dir="$PWD/app-builder-marketplace-$release_version"
  mkdir "$release_dir" "$marketplace_dir"
  gh release download "v$release_version" \
    --repo withAutograph/autograph-app-builder \
    --dir "$release_dir"
  cd "$release_dir"
  shasum -a 256 -c SHA256SUMS
  gh release verify "v$release_version" \
    --repo withAutograph/autograph-app-builder
  gh release verify-asset "v$release_version" \
    "app-builder-codex-marketplace-$release_version.tar.gz" \
    --repo withAutograph/autograph-app-builder
  tar -xzf \
    "app-builder-codex-marketplace-$release_version.tar.gz" \
    -C "$marketplace_dir"
  codex plugin marketplace add "$marketplace_dir"
  codex plugin add app-builder@autograph
)
```

The release package defines the Model Context Protocol (MCP) origin and contains
no credential. On first use, Codex automatically starts OAuth against that
origin's protected-resource and authorization-server metadata, then resumes the
protected connection after consent. Users do not run a separate MCP login
command. Its creation and publication capabilities
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
  codex plugin add app-builder@autograph
)
```

Open a new Codex task after installation. The marketplace contains only
verified endpoint-bound packages; it never installs the loopback development
adapter from App Builder `main`. Publishing a product release does not create
the shared listing: the separate marketplace import opens a reviewed catalog
change.

You can also ask Codex to do the installation:

```text
Install Autograph App Builder from withAutograph/marketplace. Add or upgrade the
marketplace from main, install app-builder@autograph, and verify it is enabled.
When it is ready, give me a short user-facing confirmation and tell me to open a
fresh task to create my app. Put commands, versions, endpoints, and diagnostics
under an optional Details section.
```

The expected handoff is:

> Autograph App Builder is ready. Open a fresh Codex task and describe the app
> you want to create.

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

- `app-builder-0.2.12.tar.gz`, the portable Agent Plugins package
- `app-builder-codex-marketplace-0.2.12.tar.gz`, a self-contained
  local Codex marketplace
- `SHA256SUMS`
- `release-receipt.json`, which binds the source repository, commit, tree, MCP
  origin, archive digests, and exact five Autograph tools
- `promotion-receipt.json`, which binds those package bytes to the exact
  Vercel Git deployment, canonical endpoint, project, source SHA, and health

### Portable archive

Download the complete release, verify its checksums and immutable release state,
then extract the portable archive:

```sh
(
  set -eu
  release_version=0.2.12
  release_dir="$PWD/app-builder-release-$release_version"
  mkdir "$release_dir"
  gh release download "v$release_version" \
    --repo withAutograph/autograph-app-builder \
    --dir "$release_dir"
  cd "$release_dir"
  shasum -a 256 -c SHA256SUMS
  gh release verify "v$release_version" \
    --repo withAutograph/autograph-app-builder
  gh release verify-asset "v$release_version" \
    "app-builder-$release_version.tar.gz" \
    --repo withAutograph/autograph-app-builder
  tar -xzf "app-builder-$release_version.tar.gz"
)
```

Add the extracted `$release_dir/app-builder/` directory using the
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
  codex plugin remove app-builder@autograph
  codex plugin marketplace remove autograph
  mkdir app-builder-marketplace-0.2.12
  tar -xzf app-builder-codex-marketplace-0.2.12.tar.gz \
    -C app-builder-marketplace-0.2.12
  codex plugin marketplace add "$PWD/app-builder-marketplace-0.2.12"
  codex plugin add app-builder@autograph
)
```

Open a new Codex task after installation or upgrade so the client reloads the
plugin and its MCP connection.

## Local development checkout

Run the plugin and Eve service from a source checkout when developing the
project:

```sh
mise run dependencies:install
mise run dev -- --arrusted-root /absolute/path/to/arrusted
```

The task snapshots that checkout, starts the loopback endpoint, proves that it
exposes exactly the five public `autograph_*` tools, and then replaces and
installs the ignored `app-builder@autograph-dev` package in the active Codex
profile. Wait for the ready message, keep the task running, and open a fresh
Codex task. No separate plugin command is required. Do not publish or
redistribute development package bytes as an endpoint-bound release.

## Maintainer release flow

Exact-main CI waits for Vercel Git to deploy the same SHA, then runs
`release:prove` once with that provider-owned URL and the canonical endpoint.
It records `promotion-receipt.json` and attests every asset. The protected
`release:publish` step creates the prerelease from those exact package and
marketplace bytes. It never rebuilds, invokes Vercel CLI, pushes an image, or
accepts replacement bytes or bindings.

Protected-environment policy, exact-current-main CI, immutable GitHub release
verification, and marketplace import readback remain required release
gates. They verify the CI promotion receipt and uploaded digests rather than
rebuilding the candidate.

The archives are the immutable distribution payload behind marketplace and
client installation. The public `withAutograph/marketplace` repository imports
those verified bytes through its **Import plugin release** workflow; it does not
rebuild the package or maintain a hand-edited duplicate.
