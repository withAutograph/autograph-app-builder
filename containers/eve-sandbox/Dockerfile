# syntax=docker/dockerfile:1.7

FROM ghcr.io/vercel/eve@sha256:56e1da284465b012c5476c3b67d78f7365ffaa1a7d4997775b85116d5eab9aca AS toolchain

USER root

ARG MISE_VERSION=2026.8.12
ARG MISE_SHA256=071e2d16905360fa04762422a2a889692bb3a4d30f27650de50bc1ac0564840b
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b
ARG RUST_VERSION=1.97.1

ENV MISE_DATA_DIR=/opt/app-builder/mise \
    MISE_CACHE_DIR=/opt/app-builder/mise-cache \
    MISE_TRUSTED_CONFIG_PATHS=/workspace \
    CARGO_HOME=/opt/app-builder/cargo \
    RUSTUP_HOME=/opt/app-builder/rustup \
    RUSTUP_TOOLCHAIN=1.97.1 \
    PATH=/opt/app-builder/mise/installs/bun/1.3.14/bin:/usr/local/bin:/usr/bin:/bin

LABEL org.opencontainers.image.source="https://github.com/withAutograph/autograph-app-builder" \
      org.opencontainers.image.description="Autograph App Builder Eve sandbox with a target-bound offline execution cache"

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
    mise install "rust@${RUST_VERSION}"; \
    mise exec "rust@${RUST_VERSION}" -- rustc --version | grep -E '^rustc 1[.]97[.]1 '; \
    mise exec "rust@${RUST_VERSION}" -- cargo --version | grep -E '^cargo 1[.]97[.]1 '; \
    chmod -R a-w,a+rX /opt/app-builder/rustup \
      /opt/app-builder/mise/installs/rust/${RUST_VERSION}

RUN set -eux; \
    git --version; \
    mise --version | grep -E '^2026[.]8[.]12($| )'; \
    bun --version | grep -E '^1[.]3[.]14$'

FROM toolchain AS dependency-cache

ARG TARGET_SHA=f91b16acd53e67af9cb0cb179952ec5034ab396f
ARG TARGET_TREE=88ead91d7b11aae11c526f1c2ee40f5b6db70642
ARG MISE_CONFIG_SHA256=be05ac034f1d73b62526a81b8353963692817dfbedce6698e5ff4baacbb0e3a8
ARG MISE_LOCK_SHA256=415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462
ARG BUN_LOCK_SHA256=e313e11efc00e7439a6e91f832c80508a6b15cacda267b86a152f76aa5ad4dd0
ARG CARGO_LOCK_SHA256=8ba85741c6021d44cb8f211939f3b0488db22a7b0e11a1d703eccb2d31e259cb
ARG APP_IDENTITY_SHA256=10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c
ARG APP_CONTRACT_SHA256=03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e
ARG APP_VALIDATION_SHA256=db6cac93c5a89ba26db8274312959114d674ec1901ee9fcd93ab9d6ef2c503a5
ARG CREATE_APP_SHA256=357d18e3cb355736638ed087355739858da59cf7c43dc09755ac1c589a4397ff
ARG APP_TEMPLATE_PACKAGE_SHA256=c7cb64a189e464abd5f1825db52dcdac62c3898940826d9ae49553291d35d762
ARG REPOSITORY_PREFLIGHT_SHA256=7c6f5fb5f44aaf436cfc558ea82cc78dae02895dd7012497fa0c1ee7dc589340
ARG REPOSITORY_EXEC_SHA256=7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc

COPY --from=arrusted-target / /tmp/arrusted-target

RUN set -eux; \
    test ! -e /tmp/arrusted-target/.git; \
    test "$(bun -e 'console.log(require("/tmp/arrusted-target/.app-builder-source-manifest.json").source.commit)')" = "${TARGET_SHA}"; \
    test "$(bun -e 'console.log(require("/tmp/arrusted-target/.app-builder-source-manifest.json").source.tree)')" = "${TARGET_TREE}"; \
    echo "${MISE_CONFIG_SHA256}  /tmp/arrusted-target/.config/mise/config.toml" | sha256sum --check --strict; \
    echo "${MISE_LOCK_SHA256}  /tmp/arrusted-target/.config/mise/mise.lock" | sha256sum --check --strict; \
    echo "${BUN_LOCK_SHA256}  /tmp/arrusted-target/bun.lock" | sha256sum --check --strict; \
    echo "${CARGO_LOCK_SHA256}  /tmp/arrusted-target/Cargo.lock" | sha256sum --check --strict; \
    echo "${APP_IDENTITY_SHA256}  /tmp/arrusted-target/.config/mise/scripts/repository/app-identity.ts" | sha256sum --check --strict; \
    echo "${APP_CONTRACT_SHA256}  /tmp/arrusted-target/.config/mise/scripts/repository/app-contract.ts" | sha256sum --check --strict; \
    echo "${APP_VALIDATION_SHA256}  /tmp/arrusted-target/.config/mise/scripts/repository/app-validation.ts" | sha256sum --check --strict; \
    echo "${CREATE_APP_SHA256}  /tmp/arrusted-target/.config/turbo/generators/create-app.ts" | sha256sum --check --strict; \
    echo "${APP_TEMPLATE_PACKAGE_SHA256}  /tmp/arrusted-target/.config/turbo/generators/templates/app/package.json.hbs" | sha256sum --check --strict; \
    echo "${REPOSITORY_PREFLIGHT_SHA256}  /tmp/arrusted-target/.config/mise/scripts/repository/repository-preflight.ts" | sha256sum --check --strict; \
    echo "${REPOSITORY_EXEC_SHA256}  /tmp/arrusted-target/.config/mise/tasks/repository/exec" | sha256sum --check --strict

RUN set -eux; \
    cd /tmp/arrusted-target; \
    rm -rf node_modules; \
    bun install --frozen-lockfile --ignore-scripts --linker=hoisted; \
    test "$(bun --version)" = "1.3.14"; \
    test "$(bun -e 'console.log(require("./node_modules/@vercel/microfrontends/package.json").version)')" = "2.4.0"; \
    cd packages/platform-microfrontends; \
    test "$(bun -e 'console.log(require("path-to-regexp/package.json").version)')" = "8.4.2"; \
    test "$(bun -e 'console.log(require("../../node_modules/@vercel/microfrontends/node_modules/path-to-regexp/package.json").version)')" = "6.3.0"; \
    bun -e 'const { match } = require("path-to-regexp"); if (match("/vendor")("/vendor")?.path !== "/vendor") process.exit(1)'; \
    cd /tmp/arrusted-target; \
    record_workspace_targets() { \
      source_root="$1"; \
      node_root="$2"; \
      link_list="$3"; \
      output="$4"; \
      find "${node_root}" -type l -print0 > "${link_list}" || return 1; \
      : > "${output}" || return 1; \
      while IFS= read -r -d '' dependency_link; do \
          dependency_target="$(readlink -f -- "${dependency_link}")" || return 1; \
          test -e "${dependency_target}" || return 1; \
          case "${dependency_target}" in \
            "${node_root}"/*) continue ;; \
            "${source_root}"/*) dependency_relative="${dependency_target#"${source_root}"/}" ;; \
            *) return 1 ;; \
          esac; \
          case "${dependency_relative}" in \
            .config/turbo/generators|.config/turbo/generators/*) dependency_owner=.config/turbo/generators ;; \
            apps/hc|apps/hc/*) dependency_owner=apps/hc ;; \
            apps/vendor|apps/vendor/*) dependency_owner=apps/vendor ;; \
            domain-libs/_shared|domain-libs/_shared/*) dependency_owner=domain-libs/_shared ;; \
            domain-libs/accounting|domain-libs/accounting/*) dependency_owner=domain-libs/accounting ;; \
            domain-libs/compensation|domain-libs/compensation/*) dependency_owner=domain-libs/compensation ;; \
            domain-libs/contractor|domain-libs/contractor/*) dependency_owner=domain-libs/contractor ;; \
            domain-libs/employee|domain-libs/employee/*) dependency_owner=domain-libs/employee ;; \
            domain-libs/org-assignment|domain-libs/org-assignment/*) dependency_owner=domain-libs/org-assignment ;; \
            domain-libs/position|domain-libs/position/*) dependency_owner=domain-libs/position ;; \
            domain-libs/recruiting|domain-libs/recruiting/*) dependency_owner=domain-libs/recruiting ;; \
            domain-libs/requisition|domain-libs/requisition/*) dependency_owner=domain-libs/requisition ;; \
            domain-libs/revenue|domain-libs/revenue/*) dependency_owner=domain-libs/revenue ;; \
            domain-libs/vendor|domain-libs/vendor/*) dependency_owner=domain-libs/vendor ;; \
            packages/agents/csv|packages/agents/csv/*) dependency_owner=packages/agents/csv ;; \
            packages/agents/reference-resolution|packages/agents/reference-resolution/*) dependency_owner=packages/agents/reference-resolution ;; \
            packages/app-runtime|packages/app-runtime/*) dependency_owner=packages/app-runtime ;; \
            packages/auth|packages/auth/*) dependency_owner=packages/auth ;; \
            packages/dashboard-agent-evals|packages/dashboard-agent-evals/*) dependency_owner=packages/dashboard-agent-evals ;; \
            packages/integrations|packages/integrations/*) dependency_owner=packages/integrations ;; \
            packages/microfrontends|packages/microfrontends/*) dependency_owner=packages/microfrontends ;; \
            packages/microfrontends-shell|packages/microfrontends-shell/*) dependency_owner=packages/microfrontends-shell ;; \
            packages/platform-microfrontends|packages/platform-microfrontends/*) dependency_owner=packages/platform-microfrontends ;; \
            packages/typescript-config|packages/typescript-config/*) dependency_owner=packages/typescript-config ;; \
            packages/vite-config|packages/vite-config/*) dependency_owner=packages/vite-config ;; \
            *) return 1 ;; \
          esac; \
          printf '%s\n' "${dependency_owner}" >> "${output}" || return 1; \
        done < "${link_list}"; \
    }; \
    fixture_root=/tmp/workspace-closure-fixtures; \
    install -d "${fixture_root}/source/packages/vite-config" \
      "${fixture_root}/source/other" "${fixture_root}/node_modules/@autograph" \
      /tmp/workspace-closure-outside; \
    ln -s ../../source/packages/vite-config "${fixture_root}/node_modules/@autograph/vite-config"; \
    record_workspace_targets "${fixture_root}/source" "${fixture_root}/node_modules" \
      "${fixture_root}/positive.links" "${fixture_root}/positive.targets"; \
    grep -Fx 'packages/vite-config' "${fixture_root}/positive.targets"; \
    ln -s ../../source/missing "${fixture_root}/node_modules/@autograph/missing"; \
    if record_workspace_targets "${fixture_root}/source" "${fixture_root}/node_modules" \
      "${fixture_root}/missing.links" "${fixture_root}/missing.targets"; then exit 1; fi; \
    rm "${fixture_root}/node_modules/@autograph/missing"; \
    ln -s /tmp/workspace-closure-outside "${fixture_root}/node_modules/@autograph/outside"; \
    if record_workspace_targets "${fixture_root}/source" "${fixture_root}/node_modules" \
      "${fixture_root}/outside.links" "${fixture_root}/outside.targets"; then exit 1; fi; \
    rm "${fixture_root}/node_modules/@autograph/outside"; \
    ln -s ../../source/other "${fixture_root}/node_modules/@autograph/unallowlisted"; \
    if record_workspace_targets "${fixture_root}/source" "${fixture_root}/node_modules" \
      "${fixture_root}/unallowlisted.links" "${fixture_root}/unallowlisted.targets"; then exit 1; fi; \
    rm -rf "${fixture_root}" /tmp/workspace-closure-outside; \
    record_workspace_targets /tmp/arrusted-target /tmp/arrusted-target/node_modules \
      /tmp/workspace-closure.links /tmp/workspace-closure.unsorted; \
    LC_ALL=C sort -u /tmp/workspace-closure.unsorted > /tmp/workspace-closure.list; \
    printf '%s\n' \
      '.config/turbo/generators' \
      'apps/hc' \
      'apps/vendor' \
      'domain-libs/_shared' \
      'domain-libs/accounting' \
      'domain-libs/compensation' \
      'domain-libs/contractor' \
      'domain-libs/employee' \
      'domain-libs/org-assignment' \
      'domain-libs/position' \
      'domain-libs/recruiting' \
      'domain-libs/requisition' \
      'domain-libs/revenue' \
      'domain-libs/vendor' \
      'packages/agents/csv' \
      'packages/agents/reference-resolution' \
      'packages/app-runtime' \
      'packages/auth' \
      'packages/dashboard-agent-evals' \
      'packages/integrations' \
      'packages/microfrontends' \
      'packages/microfrontends-shell' \
      'packages/platform-microfrontends' \
      'packages/typescript-config' \
      'packages/vite-config' > /tmp/workspace-closure.expected; \
    cmp -s /tmp/workspace-closure.expected /tmp/workspace-closure.list

RUN set -eux; \
    cd /tmp/arrusted-target; \
    install -d /opt/app-builder/cargo-closure; \
    mise exec "rust@${RUST_VERSION}" -- \
      cargo vendor --locked --versioned-dirs /opt/app-builder/cargo-closure/vendor \
      > /opt/app-builder/cargo-closure/config.toml; \
    printf '\n[net]\noffline = true\n' >> /opt/app-builder/cargo-closure/config.toml; \
    CARGO_HOME=/opt/app-builder/cargo-closure CARGO_NET_OFFLINE=true \
      mise exec "rust@${RUST_VERSION}" -- \
      cargo metadata --format-version 1 --locked --all-features > /tmp/cargo-metadata.json

RUN set -eux; \
    install -d /opt/app-builder/dependency-cache; \
    tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
      --format=posix --pax-option=delete=atime,delete=ctime --create \
      --exclude='packages/*/node_modules' \
      --exclude='packages/agents/*/node_modules' \
      --exclude='apps/*/node_modules' \
      --exclude='.config/turbo/generators/node_modules' \
      --file - --directory /tmp/arrusted-target \
      node_modules \
      --files-from /tmp/workspace-closure.list \
      | gzip --no-name --best > /opt/app-builder/dependency-cache/node-modules.tar.gz; \
    tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
      --format=posix --pax-option=delete=atime,delete=ctime --create \
      --file - --directory /opt/app-builder/cargo-closure config.toml vendor \
      | gzip --no-name --best > /opt/app-builder/dependency-cache/cargo-closure.tar.gz; \
    tar --list --gzip --file /opt/app-builder/dependency-cache/cargo-closure.tar.gz \
      > /tmp/cargo-closure.list; \
    grep -Eq '^config[.]toml$' /tmp/cargo-closure.list; \
    grep -Eq '^vendor/' /tmp/cargo-closure.list; \
    ! grep -Ev '^(config[.]toml|vendor(/.*)?)$' /tmp/cargo-closure.list; \
    archive_sha="$(sha256sum /opt/app-builder/dependency-cache/node-modules.tar.gz | cut -d' ' -f1)"; \
    archive_bytes="$(stat --format='%s' /opt/app-builder/dependency-cache/node-modules.tar.gz)"; \
    cargo_archive_sha="$(sha256sum /opt/app-builder/dependency-cache/cargo-closure.tar.gz | cut -d' ' -f1)"; \
    cargo_archive_bytes="$(stat --format='%s' /opt/app-builder/dependency-cache/cargo-closure.tar.gz)"; \
    printf '%s\n' \
      '{' \
      '  "version": 1,' \
      '  "scope": "builder-execution",' \
      '  "platform": "linux/arm64",' \
      '  "target": {' \
      "    \"sha\": \"${TARGET_SHA}\"," \
      "    \"tree\": \"${TARGET_TREE}\"," \
      "    \"miseConfigSha256\": \"${MISE_CONFIG_SHA256}\"," \
      "    \"miseLockSha256\": \"${MISE_LOCK_SHA256}\"," \
      "    \"bunLockSha256\": \"${BUN_LOCK_SHA256}\"," \
      "    \"cargoLockSha256\": \"${CARGO_LOCK_SHA256}\"," \
      "    \"appIdentitySha256\": \"${APP_IDENTITY_SHA256}\"," \
      "    \"appContractSha256\": \"${APP_CONTRACT_SHA256}\"," \
      "    \"appValidationSha256\": \"${APP_VALIDATION_SHA256}\"," \
      "    \"createAppSha256\": \"${CREATE_APP_SHA256}\"," \
      "    \"appTemplatePackageSha256\": \"${APP_TEMPLATE_PACKAGE_SHA256}\"," \
      "    \"repositoryPreflightSha256\": \"${REPOSITORY_PREFLIGHT_SHA256}\"," \
      "    \"repositoryExecSha256\": \"${REPOSITORY_EXEC_SHA256}\"" \
      '  },' \
      '  "runtime": { "bun": "1.3.14", "rust": "1.97.1" },' \
      '  "closure": {' \
      '    "package": "@vercel/microfrontends",' \
      '    "version": "2.4.0",' \
      '    "archivePath": "/opt/app-builder/dependency-cache/node-modules.tar.gz",' \
      "    \"archiveSha256\": \"${archive_sha}\"," \
      "    \"archiveBytes\": ${archive_bytes}," \
      '    "cargoArchivePath": "/opt/app-builder/dependency-cache/cargo-closure.tar.gz",' \
      "    \"cargoArchiveSha256\": \"${cargo_archive_sha}\"," \
      "    \"cargoArchiveBytes\": ${cargo_archive_bytes}" \
      '  }' \
      '}' > /opt/app-builder/dependency-cache/manifest.json; \
    chmod 0444 /opt/app-builder/dependency-cache/manifest.json \
      /opt/app-builder/dependency-cache/node-modules.tar.gz \
      /opt/app-builder/dependency-cache/cargo-closure.tar.gz; \
    chmod 0555 /opt/app-builder/dependency-cache

FROM toolchain

ARG APP_BUILDER_REVISION

LABEL org.opencontainers.image.revision="${APP_BUILDER_REVISION}" \
      org.opencontainers.image.version="sandbox-v2"

COPY --from=dependency-cache --chown=root:root /opt/app-builder/dependency-cache \
  /opt/app-builder/dependency-cache

RUN set -eux; \
    archive_sha="$(bun -e 'console.log(require("/opt/app-builder/dependency-cache/manifest.json").closure.archiveSha256)')"; \
    dependency_root="/opt/app-builder/dependencies/${archive_sha}"; \
    install -d "${dependency_root}"; \
    tar --extract --gzip --file /opt/app-builder/dependency-cache/node-modules.tar.gz \
      --directory "${dependency_root}" --no-same-owner --no-same-permissions; \
    test -d "${dependency_root}/node_modules"; \
    chmod -R a-w,a+rX /opt/app-builder/dependencies; \
    if find /opt/app-builder/dependencies \( -type f -o -type d \) -perm /222 -print -quit | grep -q .; then exit 1; fi; \
    find "${dependency_root}/node_modules/@autograph" -mindepth 1 -maxdepth 1 -type l -print0 \
      | while IFS= read -r -d '' workspace_link; do \
          workspace_target="$(readlink -f -- "${workspace_link}")"; \
          test -e "${workspace_target}"; \
          case "${workspace_target}" in "${dependency_root}"/*) ;; *) exit 1 ;; esac; \
        done; \
    test "$(bun -e 'console.log(require("'"${dependency_root}"'/node_modules/@vercel/microfrontends/package.json").version)')" = "2.4.0"; \
    test "$(bun -e 'console.log(require("'"${dependency_root}"'/node_modules/@autograph/vite-config/package.json").name)')" = "@autograph/vite-config"; \
    install -d /opt/app-builder/cargo-closure; \
    tar --extract --gzip --file /opt/app-builder/dependency-cache/cargo-closure.tar.gz \
      --directory /opt/app-builder/cargo-closure --no-same-owner --no-same-permissions; \
    install --mode=0444 /opt/app-builder/cargo-closure/config.toml \
      /opt/app-builder/cargo/config.toml; \
    chmod -R a-w,a+rX /opt/app-builder/cargo-closure /opt/app-builder/cargo

USER vercel-sandbox

RUN --network=none set -eux; \
    echo "${APP_BUILDER_REVISION}" | grep -E '^[0-9a-f]{40}$'; \
    test "$(bun --version)" = "1.3.14"; \
    MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false \
      mise exec rust@1.97.1 -- rustc --version | grep -E '^rustc 1[.]97[.]1 '; \
    MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false \
      mise exec rust@1.97.1 -- cargo --version | grep -E '^cargo 1[.]97[.]1 '; \
    bun -e 'const fs=require("node:fs"),{execFileSync}=require("node:child_process"); const m=require("/opt/app-builder/dependency-cache/manifest.json"); const digest=(path)=>execFileSync("sha256sum",[path],{encoding:"utf8"}).split(/\s/u)[0]; const root=`/opt/app-builder/dependencies/${m.closure.archiveSha256}/node_modules`; if(digest(m.closure.archivePath)!==m.closure.archiveSha256 || digest(m.closure.cargoArchivePath)!==m.closure.cargoArchiveSha256 || !fs.statSync(root).isDirectory()) process.exit(1)'
