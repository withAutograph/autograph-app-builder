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

ARG TARGET_SHA=2503b6ad5820f650b1469d72fc569260bee298a8
ARG TARGET_TREE=226cf97f187d50ba0db5877b62f7c38db95061da
ARG MISE_CONFIG_SHA256=563ef5a6a44ce320ce4833f61391ebd9f41b02ac542d4254f04087285ce449ae
ARG MISE_LOCK_SHA256=415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462
ARG BUN_LOCK_SHA256=a3c9712b469ef5bf8d22ae588b42c5834fff53adb2cf6c0ed84ebac9f3e0999b
ARG APP_IDENTITY_SHA256=10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c
ARG APP_CONTRACT_SHA256=03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e
ARG REPOSITORY_PREFLIGHT_SHA256=6e3d96c9373d046f24d654bada360d08bbbbc155bc3b382fc9fc1a0009e7a6e6
ARG REPOSITORY_EXEC_SHA256=7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc

COPY --from=arrusted-target / /tmp/arrusted-target

RUN set -eux; \
    test ! -e /tmp/arrusted-target/.git; \
    test "$(bun -e 'console.log(require("/tmp/arrusted-target/.app-builder-source-manifest.json").source.commit)')" = "${TARGET_SHA}"; \
    test "$(bun -e 'console.log(require("/tmp/arrusted-target/.app-builder-source-manifest.json").source.tree)')" = "${TARGET_TREE}"; \
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
      --file - --directory /tmp/arrusted-target node_modules \
      | gzip --no-name --best > /opt/app-builder/dependency-cache/node-modules.tar.gz; \
    archive_sha="$(sha256sum /opt/app-builder/dependency-cache/node-modules.tar.gz | cut -d' ' -f1)"; \
    archive_bytes="$(stat --format='%s' /opt/app-builder/dependency-cache/node-modules.tar.gz)"; \
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
      '    "archivePath": "/opt/app-builder/dependency-cache/node-modules.tar.gz",' \
      "    \"archiveSha256\": \"${archive_sha}\"," \
      "    \"archiveBytes\": ${archive_bytes}" \
      '  }' \
      '}' > /opt/app-builder/dependency-cache/manifest.json; \
    chmod 0444 /opt/app-builder/dependency-cache/manifest.json \
      /opt/app-builder/dependency-cache/node-modules.tar.gz; \
    chmod 0555 /opt/app-builder/dependency-cache

FROM toolchain

ARG APP_BUILDER_REVISION

LABEL org.opencontainers.image.revision="${APP_BUILDER_REVISION}" \
      org.opencontainers.image.version="sandbox-v2"

COPY --from=dependency-cache --chown=root:root /opt/app-builder/dependency-cache \
  /opt/app-builder/dependency-cache

RUN --network=none set -eux; \
    echo "${APP_BUILDER_REVISION}" | grep -E '^[0-9a-f]{40}$'; \
    test "$(bun --version)" = "1.3.14"; \
    bun -e 'const {execFileSync}=require("node:child_process"); const m=require("/opt/app-builder/dependency-cache/manifest.json"); const actual=execFileSync("sha256sum",[m.closure.archivePath],{encoding:"utf8"}).split(/\s/u)[0]; if(actual!==m.closure.archiveSha256) process.exit(1)'

USER vercel-sandbox
