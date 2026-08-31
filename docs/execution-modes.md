# App Builder execution modes

App Builder supports exactly two user-facing execution modes. Eve, image
lifecycle tasks, package builders, eval runners, and provider adapters are
private implementation details and are not additional modes.

## Non-release development

The detailed iteration contract is [Local-development lifecycle](local-development-lifecycle.md).

Run the only non-release workflow with an explicit local Arrusted checkout:

```sh
mise run dev -- --arrusted-root /absolute/path/to/arrusted
```

The checkout may be dirty. At the start of each run App Builder copies tracked
and non-ignored untracked bytes into a new owner-only, read-only snapshot. The
sandbox sees only that snapshot and never mounts or writes the developer
checkout. Generated and applied work stays under a separate builder-owned
destination root.

The source fingerprint covers paths, modes, link targets, and file bytes. App
Builder rechecks it while the run is active. A change terminates both local
services, discards the run snapshot, and restarts from one fresh snapshot, so a
result cannot mix source versions.

The stable development toolchain image contains the operating system, Node,
Bun, mise, and Microsandbox support but no Arrusted source or dependency
closure. It changes only when that Dockerfile changes. Dependency images are
keyed independently by exact Arrusted lock/config file digests,
`linux/arm64` or `linux/amd64`, and the Node, Bun, mise, and Rust versions.
Ordinary source edits reuse dependencies; a lockfile, relevant tool, or
platform change creates a new closure. Architecture-specific native closures
remain distinct.

The task starts loopback Eve and `/mcp`, then proves that endpoint exposes
exactly `autograph_start`, `autograph_get`, `autograph_send`,
`autograph_respond`, and `autograph_cancel`. Only after that proof does it
replace its stable, ignored `autograph-dev` local Codex marketplace registration
and install `app-builder@autograph-dev` in the active Codex profile. Keep the
task running and open a fresh Codex task after the ready message. The package
has no MCP App. Open prototype links returned by the loopback workflow in the
integrated ChatGPT Browser; no MCP App preview surface is part of this mode.

Development runs fail closed for checkout or branch publication, GitHub
mutation, registry upload, deployment, hosted marketplace mutation, provider
emulation or mutation, hosted binding selection, and hosted OAuth. Product
conversation still reports product outcomes and effect-based approvals;
snapshot, image, cache, and receipt mechanics stay internal.

## Release promotion

Create one immutable candidate without publishing it:

```sh
mise run release:prove -- \
  --arrusted-root /absolute/path/to/clean/arrusted \
  --endpoint https://approved-app-builder.example \
  --output /absolute/owner-controlled/release-candidate
```

Release proof requires clean committed Builder and Arrusted sources. It rejects
local or loopback endpoints, dirty trees, an Arrusted commit/tree that differs
from the source-bound release image, unsafe paths, mutable image references,
and non-release bindings.

`release:prove` creates and verifies all candidate bytes before any upload:

1. the deterministic endpoint-bound package, Codex marketplace archive,
   descriptor, checksums, and fresh-client exact-five-tool discovery;
2. the source-bound `linux/arm64` OCI image from sanitized exact Git trees,
   including source/tree, platform, Dockerfile, target closure, and tool
   bindings;
3. the Vercel prebuilt production output plus its exact project binding;
4. a real-sandbox create flow through Browser preview and `reviewed`, with all
   publication tools absent; and
5. a real-sandbox iteration of the existing Vendor app through Browser preview
   and `reviewed`, again without publication.

The resulting `promotion-receipt.json` contains only relative candidate paths
and SHA-256 bindings for every uploaded or deployed byte. It contains no local
source paths or credentials.

After a separate authorization, publish that exact candidate:

```sh
mise run release:publish -- \
  --candidate-root /absolute/owner-controlled/release-candidate \
  --token-file /absolute/owner-only/hosted-oauth-token
```

`release:publish` re-verifies the receipt and every candidate byte. It uploads
the sealed package and marketplace archive, loads and pushes the proven OCI
archive with digest readback, and runs `vercel deploy --prebuilt --prod` from
the proven output. The short-lived owner-only token is used only to discover
the deployed MCP tools after OAuth metadata and exact deployment-alias
readback; it is never copied into the candidate or receipt. The command has no
build step and cannot accept replacement
package, image, deployment, endpoint, or binding inputs. Hosted OAuth,
deployed-endpoint, marketplace, and production checks belong only after this
release boundary.

Promotion is one direction only:

```text
dirty or clean local checkout -> dev snapshot (non-release, never promotable)
clean exact commits -> release:prove candidate -> release:publish same bytes
```
