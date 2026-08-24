FROM ghcr.io/vercel/eve@sha256:56e1da284465b012c5476c3b67d78f7365ffaa1a7d4997775b85116d5eab9aca

USER root

ARG MISE_VERSION=2026.8.12
ARG MISE_SHA256=071e2d16905360fa04762422a2a889692bb3a4d30f27650de50bc1ac0564840b
ARG BUN_VERSION=1.2.20
ARG BUN_SHA256=98d2e0b2c09421569172b4d46b6f81378c2dbdd77480ebb27f3989dd4e72e18b

LABEL org.opencontainers.image.source="https://github.com/withAutograph/autograph-app-builder" \
      org.opencontainers.image.description="Autograph App Builder Eve sandbox with pinned mise and Bun"

RUN set -eux; \
    curl --fail --location --silent --show-error \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-arm64" \
      --output /tmp/mise; \
    echo "${MISE_SHA256}  /tmp/mise" | sha256sum --check --strict; \
    install --mode=0755 /tmp/mise /usr/local/bin/mise; \
    rm /tmp/mise

RUN set -eux; \
    curl --fail --location --silent --show-error \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip" \
      --output /tmp/bun.zip; \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum --check --strict; \
    unzip -q /tmp/bun.zip -d /tmp; \
    install --mode=0755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64

RUN set -eux; \
    git --version; \
    mise --version | grep -E '^2026[.]8[.]12($| )'; \
    bun --version | grep -E '^1[.]2[.]20$'

USER vercel-sandbox
