# syntax=docker/dockerfile:1.7

# Stable local-development toolchain. Arrusted source and dependency bytes are
# deliberately absent; they are supplied by the content-keyed dependency image.
FROM ghcr.io/vercel/eve@sha256:56e1da284465b012c5476c3b67d78f7365ffaa1a7d4997775b85116d5eab9aca

USER root

ARG TARGETARCH
ARG MISE_VERSION=2026.8.12
ARG NODE_VERSION=24.18.0
ARG BUN_VERSION=1.3.14

ENV MISE_DATA_DIR=/opt/app-builder/mise \
    MISE_CACHE_DIR=/opt/app-builder/mise-cache \
    MISE_TRUSTED_CONFIG_PATHS=/workspace \
    PATH=/opt/app-builder/mise/installs/node/24.18.0/bin:/opt/app-builder/mise/installs/bun/1.3.14/bin:/usr/local/bin:/usr/bin:/bin

LABEL org.opencontainers.image.source="https://github.com/withAutograph/autograph-app-builder" \
      org.opencontainers.image.description="Stable Autograph local-development toolchain without Arrusted source or dependencies" \
      dev.autograph.scope="os-node-bun-mise-microsandbox"

RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) mise_asset=arm64; mise_sha=071e2d16905360fa04762422a2a889692bb3a4d30f27650de50bc1ac0564840b; bun_asset=aarch64; bun_sha=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b ;; \
      amd64) mise_asset=x64; mise_sha=f2092b1e67f0abc8803d3be120dd2bc5b656dd99680ba3159f710e149da10d05; bun_asset=x64; bun_sha=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f ;; \
      *) exit 64 ;; \
    esac; \
    curl --fail --location --silent --show-error \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${mise_asset}" \
      --output /tmp/mise; \
    echo "${mise_sha}  /tmp/mise" | sha256sum --check --strict; \
    install --mode=0755 /tmp/mise /usr/local/bin/mise; \
    curl --fail --location --silent --show-error \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_asset}.zip" \
      --output /tmp/bun.zip; \
    echo "${bun_sha}  /tmp/bun.zip" | sha256sum --check --strict; \
    unzip -q /tmp/bun.zip -d /tmp; \
    install -d "/opt/app-builder/mise/installs/bun/${BUN_VERSION}/bin"; \
    install --mode=0755 "/tmp/bun-linux-${bun_asset}/bun" "/opt/app-builder/mise/installs/bun/${BUN_VERSION}/bin/bun"; \
    mise install "node@${NODE_VERSION}"; \
    rm -rf /tmp/mise /tmp/bun.zip "/tmp/bun-linux-${bun_asset}" /opt/app-builder/mise-cache; \
    node --version | grep -E '^v24[.]18[.]0$'; \
    bun --version | grep -E '^1[.]3[.]14$'; \
    mise --version | grep -E '^2026[.]8[.]12($| )'; \
    chmod -R a-w,a+rX /opt/app-builder/mise

USER vercel-sandbox

RUN --network=none node --version && bun --version && mise --version
