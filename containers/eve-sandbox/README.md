# Eve sandbox image (linux/arm64)

This image is the App Builder's externally built, target-bound execution
environment. It pins the Eve base, Git, mise `2026.8.12`, and Bun `1.3.14`.
It also builds the exact external dependency closure needed by Arrusted's
read-only app planner, including `@vercel/microfrontends` `2.4.0`, from a clean
checkout of Arrusted commit
`e4e76f52a365c6b8da2f84698b38844f26a31750`.

The final image contains no Arrusted source tree, credentials, or provider
configuration. It contains a normalized `node_modules` archive and a read-only
manifest under `/opt/app-builder/dependency-cache/`. The manifest binds the
target commit/tree, mise configuration and lock, Bun lock, target command
implementations, runtime version, dependency version, archive size, and archive
SHA-256. The App Builder derives the cache receipt from observed manifest and
archive bytes; there is no operator-supplied cache digest.

## Build and publish boundary

Use a clean standalone Arrusted checkout whose `.git` directory is readable in
the build context. Verify it is at the exact target commit with no dirty paths.
From an exact App Builder checkout, build the transient tag:

```bash
docker buildx build \
  --platform linux/arm64 \
  --build-context arrusted-target=/absolute/path/to/clean-arrusted-checkout \
  --file containers/eve-sandbox/Dockerfile \
  --tag ghcr.io/withautograph/autograph-app-builder-sandbox:app-builder-747f536-arrusted-e4e76f52-arm64-v1 \
  --load \
  .
```

The build fails on target SHA/tree or contract/lock drift. It performs the
networked `bun install --frozen-lockfile --ignore-scripts` only while building
the immutable cache layer. The final self-check runs with BuildKit networking
disabled.

Build, registry publication, and local acquisition are separate approvals.
After an approved push, resolve the registry manifest digest and use only:

```text
ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:<remote-manifest-digest>
```

The earlier published image ending in `c44a4077...` contains Bun `1.2.20` and
no target dependency closure. It is intentionally ineligible for real target
identity or planning.

## Local Microsandbox preload

A Docker pull does not populate Microsandbox's OCI cache. Preload the exact
approved digest before starting Eve, whose backend uses `pullPolicy: "never"`
and deny-all networking:

```bash
pnpm exec msb pull \
  ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:<remote-manifest-digest> \
  --materialize all

APP_BUILDER_SANDBOX_IMAGE=ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:<remote-manifest-digest> \
  pnpm test:sandbox-toolchain
```

The observational eval verifies the fixed toolchain and image-internal cache.
Real dependency preparation has its own approval and writes only the
builder-owned planning overlay. It never installs over the network at runtime.
Building another target, architecture, or dependency closure requires another
reviewed image and separate approval.

The first observational target proof is scoped to app id `builder-proof` and
sanitized AppSpec owner `Autograph App Builder proof`. Those values do not grant
apply, validation, publication, provider, deployment, release, or cleanup
authority. Retain local proof artifacts until their sanitized receipts are
accepted.
