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

The checkout may be dirty and is the live development source. App Builder
synchronizes its tracked and non-ignored working-tree bytes into the persistent
Vercel Sandbox as a new planning input. The source checkout remains writable;
dependency setup, generated planning files, and app changes use the
builder-owned mutable overlay rather than redefining the source input.

Source identity is observed to explain what a planning result used, not to turn
ordinary edits into a local failure. When source bytes change, the next plan is
made from those bytes. No long-lived baseline or drift gate may block design,
planning, implementation, or draft-PR creation. A draft proposal is
provisional and is reconciled against current main only when someone chooses
to merge it.

Vercel Sandbox is the sole real execution backend. Local development obtains a
project-scoped Vercel OIDC token through the mise-owned startup path; Preview
and Production receive the same identity from Vercel. Dependency templates are
keyed independently by exact Arrusted lock/config digests, platform, and pinned
tool versions. Ordinary source edits reuse dependencies; a lockfile, relevant
tool, or platform change creates a new closure.

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
snapshot, cache, and receipt mechanics stay internal. Development does not
need a release-candidate source identity: only bytes selected for build/publish
promotion are immutable.

## Release promotion

Create one immutable candidate without publishing it:

```sh
mise run release:prove -- \
  --arrusted-root /absolute/path/to/clean/arrusted \
  --endpoint https://approved-app-builder.example \
  --output /absolute/owner-controlled/release-candidate
```

Release proof requires a clean committed Builder source and an exact successful
Vercel Git deployment for that source SHA. It rejects local or loopback
endpoints, dirty trees, unsafe paths, changed package bytes, and non-release
bindings.

`release:prove` creates and verifies all candidate bytes before any upload:

1. the deterministic endpoint-bound package and Codex marketplace archive;
2. checksums, release receipt, and exact-five-tool discovery evidence; and
3. the exact Vercel Git deployment URL, source SHA, project, canonical endpoint,
   and health response.

The resulting `promotion-receipt.json` contains only relative candidate paths
and SHA-256 bindings for every uploaded or deployed byte. It contains no local
source paths or credentials.

After a separate authorization, publish that exact candidate:

```sh
mise run release:publish -- \
  --candidate-root /absolute/owner-controlled/release-candidate \
  --token-file /absolute/owner-only/hosted-oauth-token
```

`release:publish` re-verifies the receipt and every candidate byte, then creates
the GitHub prerelease from those exact files. It never builds, deploys, pushes
an image, or mutates the marketplace. Vercel Git integration owns deployment;
the marketplace independently imports and reviews the immutable release bytes.

Promotion is one direction only:

```text
dirty or clean local checkout -> dev snapshot (non-release, never promotable)
clean exact main commit -> Vercel Git deployment -> release:prove candidate -> release:publish same bytes
```
