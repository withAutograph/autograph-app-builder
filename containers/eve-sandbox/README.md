# Eve sandbox image (linux/arm64)

This is the reproducible source for the App Builder's externally acquired Eve
sandbox image. It pins the Eve base image and verifies the release-asset SHA-256
for each added binary at build time. It intentionally contains no repository
contents, credentials, target command, or network-policy changes.

The published `linux/arm64` image is:

```text
ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:c44a40777f2e2b1158a91a5bfc5075224a39573fe053d7b4ea3ef6f65b7484ec
```

Build and locally verify it on an arm64 Docker host:

```bash
docker build --platform linux/arm64 \
  --tag ghcr.io/withautograph/autograph-app-builder-sandbox:20260824-1 \
  containers/eve-sandbox

docker run --rm \
  ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:c44a40777f2e2b1158a91a5bfc5075224a39573fe053d7b4ea3ef6f65b7484ec \
  sh -lc 'id -un; git --version; mise --version; bun --version'
```

The observed result on 2026-08-24 was user `vercel-sandbox`, Git `2.53.0`,
mise `2026.8.12`, and Bun `1.2.20`.

Eve's Microsandbox backend has its own OCI cache. A Docker pull does **not**
preload that cache. On the intended host, preload the exact digest before
running App Builder with `pullPolicy: "never"`:

```bash
pnpm exec msb pull \
  ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:c44a40777f2e2b1158a91a5bfc5075224a39573fe053d7b4ea3ef6f65b7484ec \
  --materialize all
```

Then set the exact digest in the host environment and run the existing
observational Eve eval:

```bash
APP_BUILDER_SANDBOX_IMAGE=ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:c44a40777f2e2b1158a91a5bfc5075224a39573fe053d7b4ea3ef6f65b7484ec \
  pnpm test:sandbox-toolchain
```

The agent is intentionally configured with `pullPolicy: "never"` and
deny-all sandbox networking. It will not pull, build, publish, install, or
execute target-owned commands. Building or publishing another image, including
an image for another architecture, remains a separate approval.
