# syntax=docker/dockerfile:1.7

FROM ghcr.io/vercel/eve@sha256:56e1da284465b012c5476c3b67d78f7365ffaa1a7d4997775b85116d5eab9aca AS toolchain

USER root

ARG MISE_VERSION=2026.8.12
ARG MISE_SHA256=071e2d16905360fa04762422a2a889692bb3a4d30f27650de50bc1ac0564840b
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b

ENV MISE_DATA_DIR=/opt/app-builder/mise \
    MISE_CACHE_DIR=/opt/app-builder/mise-cache \
    MISE_TRUSTED_CONFIG_PATHS=/workspace \
    PATH=/opt/app-builder/mise/installs/bun/1.3.14/bin:/usr/local/bin:/usr/bin:/bin

LABEL org.opencontainers.image.source="https://github.com/withAutograph/autograph-app-builder" \
      org.opencontainers.image.description="Autograph App Builder Eve sandbox with a target-bound offline planning cache"

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
    install -d /opt/app-builder/mise/installs/bun/${BUN_VERSION}/bin; \
    install --mode=0755 /tmp/bun-linux-aarch64/bun \
      /opt/app-builder/mise/installs/bun/${BUN_VERSION}/bin/bun; \
    ln -s /opt/app-builder/mise/installs/bun/${BUN_VERSION}/bin/bun /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64

RUN set -eux; \
    git --version; \
    mise --version | grep -E '^2026[.]8[.]12($| )'; \
    bun --version | grep -E '^1[.]3[.]14$'

FROM toolchain AS dependency-cache

ARG TARGET_SHA=e4e76f52a365c6b8da2f84698b38844f26a31750
ARG TARGET_TREE=7244f79f2ec523d0269fda6a9b59a1067bd723f8
ARG MISE_CONFIG_SHA256=a9d2bf3a9366e38a1d75eb05d21b7a7dde46a5530afc5be2bff96be73ceb3782
ARG MISE_LOCK_SHA256=847ebdcfea49e4550ab80e909e61a855dea0fa8a12ff98c89d99f38fc9ea3ab2
ARG BUN_LOCK_SHA256=e2818f05408189b47223b67f71a66f1e8f9c8a31e5ad8326ba4a22130b5e6a33
ARG APP_IDENTITY_SHA256=10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c
ARG APP_CONTRACT_SHA256=e391e032dcff5c63dea66c64e79c88be3ce4b9e1a00333b11cedb8836e109073
ARG REPOSITORY_PREFLIGHT_SHA256=898751baaebc72d82e591afde5f07ad37570a065f60c122bf23b2f85996df37e
ARG REPOSITORY_EXEC_SHA256=7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc

COPY --from=arrusted-target / /tmp/arrusted-target

RUN set -eux; \
    test "$(git -C /tmp/arrusted-target rev-parse HEAD)" = "${TARGET_SHA}"; \
    test "$(git -C /tmp/arrusted-target rev-parse HEAD^{tree})" = "${TARGET_TREE}"; \
    test -z "$(git -C /tmp/arrusted-target status --porcelain=v1)"; \
    echo "${MISE_CONFIG_SHA256}  /tmp/arrusted-target/.config/mise/config.toml" | sha256sum --check --strict; \
    echo "${MISE_LOCK_SHA256}  /tmp/arrusted-target/.config/mise/mise.lock" | sha256sum --check --strict; \
    echo "${BUN_LOCK_SHA256}  /tmp/arrusted-target/bun.lock" | sha256sum --check --strict; \
    echo "${APP_IDENTITY_SHA256}  /tmp/arrusted-target/.config/mise/scripts/repository/app-identity.ts" | sha256sum --check --strict; \
    echo "${APP_CONTRACT_SHA256}  /tmp/arrusted-target/.config/mise/scripts/repository/app-contract.ts" | sha256sum --check --strict; \
    echo "${REPOSITORY_PREFLIGHT_SHA256}  /tmp/arrusted-target/.config/mise/scripts/repository/repository-preflight.ts" | sha256sum --check --strict; \
    echo "${REPOSITORY_EXEC_SHA256}  /tmp/arrusted-target/.config/mise/tasks/repository/exec" | sha256sum --check --strict

RUN set -eux; \
    cd /tmp/arrusted-target; \
    rm -rf node_modules; \
    bun install --frozen-lockfile --ignore-scripts; \
    test "$(bun --version)" = "1.3.14"; \
    test "$(bun -e 'console.log(require("./node_modules/@vercel/microfrontends/package.json").version)')" = "2.4.0"

RUN set -eux; \
    install -d /opt/app-builder/dependency-cache; \
    tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
      --format=posix --pax-option=delete=atime,delete=ctime --create \
      --file /opt/app-builder/dependency-cache/node-modules.tar \
      --directory /tmp/arrusted-target node_modules; \
    archive_sha="$(sha256sum /opt/app-builder/dependency-cache/node-modules.tar | cut -d' ' -f1)"; \
    archive_bytes="$(stat --format='%s' /opt/app-builder/dependency-cache/node-modules.tar)"; \
    printf '%s\n' \
      '{' \
      '  "version": 1,' \
      '  "scope": "identity-planning",' \
      '  "platform": "linux/arm64",' \
      '  "target": {' \
      "    \"sha\": \"${TARGET_SHA}\"," \
      "    \"tree\": \"${TARGET_TREE}\"," \
      "    \"miseConfigSha256\": \"${MISE_CONFIG_SHA256}\"," \
      "    \"miseLockSha256\": \"${MISE_LOCK_SHA256}\"," \
      "    \"bunLockSha256\": \"${BUN_LOCK_SHA256}\"," \
      "    \"appIdentitySha256\": \"${APP_IDENTITY_SHA256}\"," \
      "    \"appContractSha256\": \"${APP_CONTRACT_SHA256}\"," \
      "    \"repositoryPreflightSha256\": \"${REPOSITORY_PREFLIGHT_SHA256}\"," \
      "    \"repositoryExecSha256\": \"${REPOSITORY_EXEC_SHA256}\"" \
      '  },' \
      '  "runtime": { "bun": "1.3.14" },' \
      '  "closure": {' \
      '    "package": "@vercel/microfrontends",' \
      '    "version": "2.4.0",' \
      '    "archivePath": "/opt/app-builder/dependency-cache/node-modules.tar",' \
      "    \"archiveSha256\": \"${archive_sha}\"," \
      "    \"archiveBytes\": ${archive_bytes}" \
      '  }' \
      '}' > /opt/app-builder/dependency-cache/manifest.json; \
    chmod 0444 /opt/app-builder/dependency-cache/manifest.json \
      /opt/app-builder/dependency-cache/node-modules.tar; \
    chmod 0555 /opt/app-builder/dependency-cache

FROM toolchain

COPY --from=dependency-cache --chown=root:root /opt/app-builder/dependency-cache \
  /opt/app-builder/dependency-cache

RUN --network=none set -eux; \
    test "$(bun --version)" = "1.3.14"; \
    bun -e 'const {execFileSync}=require("node:child_process"); const m=require("/opt/app-builder/dependency-cache/manifest.json"); const actual=execFileSync("sha256sum",[m.closure.archivePath],{encoding:"utf8"}).split(/\s/u)[0]; if(actual!==m.closure.archiveSha256) process.exit(1)'

USER vercel-sandbox
