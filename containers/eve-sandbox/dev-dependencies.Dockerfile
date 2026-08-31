# syntax=docker/dockerfile:1.7

ARG TOOLCHAIN_IMAGE
FROM ${TOOLCHAIN_IMAGE} AS dependency-builder

USER root
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ARG DEPENDENCY_KEY
ARG PLATFORM
ARG MISE_CONFIG_SHA256
ARG MISE_LOCK_SHA256
ARG BUN_LOCK_SHA256
ARG CARGO_LOCK_SHA256
ARG RUST_VERSION=1.97.1

ENV CARGO_HOME=/opt/app-builder/cargo \
    RUSTUP_HOME=/opt/app-builder/rustup \
    RUSTUP_TOOLCHAIN=1.97.1

COPY --from=arrusted-source / /tmp/arrusted-source

RUN set -eux; \
    test ! -L /tmp/arrusted-source; \
    rm -rf /tmp/arrusted-source/.git /tmp/arrusted-source/node_modules; \
    cd /tmp/arrusted-source; \
    bun install --frozen-lockfile --ignore-scripts --linker=hoisted; \
    find node_modules -type l -print0 | while IFS= read -r -d '' dependency_link; do \
      dependency_target="$(readlink -f -- "${dependency_link}")"; \
      case "${dependency_target}" in \
        /tmp/arrusted-source/*) \
          dependency_relative="${dependency_target#/tmp/arrusted-source/}"; \
          rm "${dependency_link}"; \
          ln -s "/workspace/repository/${dependency_relative}" "${dependency_link}" ;; \
      esac; \
    done; \
    mise install "rust@${RUST_VERSION}"; \
    install -d /opt/app-builder/cargo-closure/vendor; \
    mise exec "rust@${RUST_VERSION}" -- cargo vendor --locked --versioned-dirs \
      /opt/app-builder/cargo-closure/vendor > /opt/app-builder/cargo-closure/config.toml; \
    printf '\n[net]\noffline = true\n' >> /opt/app-builder/cargo-closure/config.toml; \
    install -d /opt/app-builder/dependency-cache; \
    tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
      --format=posix --pax-option=delete=atime,delete=ctime --create \
      --file - node_modules | gzip --no-name --best \
      > /opt/app-builder/dependency-cache/node-modules.tar.gz; \
    tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
      --format=posix --pax-option=delete=atime,delete=ctime --create \
      --file - --directory /opt/app-builder/cargo-closure config.toml vendor \
      | gzip --no-name --best > /opt/app-builder/dependency-cache/cargo-closure.tar.gz; \
    archive_sha="$(sha256sum /opt/app-builder/dependency-cache/node-modules.tar.gz | cut -d' ' -f1)"; \
    archive_bytes="$(stat --format='%s' /opt/app-builder/dependency-cache/node-modules.tar.gz)"; \
    cargo_sha="$(sha256sum /opt/app-builder/dependency-cache/cargo-closure.tar.gz | cut -d' ' -f1)"; \
    cargo_bytes="$(stat --format='%s' /opt/app-builder/dependency-cache/cargo-closure.tar.gz)"; \
    printf '%s\n' \
      '{' \
      '  "version": 2,' \
      '  "scope": "development-execution",' \
      "  \"platform\": \"${PLATFORM}\"," \
      "  \"dependencyKey\": \"${DEPENDENCY_KEY}\"," \
      '  "lockfiles": {' \
      "    \".config/mise/config.toml\": \"${MISE_CONFIG_SHA256}\"," \
      "    \".config/mise/mise.lock\": \"${MISE_LOCK_SHA256}\"," \
      "    \"bun.lock\": \"${BUN_LOCK_SHA256}\"," \
      "    \"Cargo.lock\": \"${CARGO_LOCK_SHA256}\"" \
      '  },' \
      '  "runtime": { "node": "24.18.0", "bun": "1.3.14", "mise": "2026.8.12", "rust": "1.97.1" },' \
      '  "closure": {' \
      '    "package": "@vercel/microfrontends",' \
      '    "version": "2.4.0",' \
      '    "archivePath": "/opt/app-builder/dependency-cache/node-modules.tar.gz",' \
      "    \"archiveSha256\": \"${archive_sha}\"," \
      "    \"archiveBytes\": ${archive_bytes}," \
      '    "cargoArchivePath": "/opt/app-builder/dependency-cache/cargo-closure.tar.gz",' \
      "    \"cargoArchiveSha256\": \"${cargo_sha}\"," \
      "    \"cargoArchiveBytes\": ${cargo_bytes}" \
      '  }' \
      '}' > /opt/app-builder/dependency-cache/manifest.json

ARG TOOLCHAIN_IMAGE
FROM ${TOOLCHAIN_IMAGE}

USER root
ENV CARGO_HOME=/opt/app-builder/cargo \
    RUSTUP_HOME=/opt/app-builder/rustup \
    RUSTUP_TOOLCHAIN=1.97.1

COPY --from=dependency-builder /opt/app-builder/dependency-cache /opt/app-builder/dependency-cache
COPY --from=dependency-builder /opt/app-builder/cargo-closure /opt/app-builder/cargo-closure
COPY --from=dependency-builder /opt/app-builder/rustup /opt/app-builder/rustup
COPY --from=dependency-builder /opt/app-builder/mise/installs/rust /opt/app-builder/mise/installs/rust

RUN set -eux; \
    archive_sha="$(bun -e 'console.log(require("/opt/app-builder/dependency-cache/manifest.json").closure.archiveSha256)')"; \
    dependency_root="/opt/app-builder/dependencies/${archive_sha}"; \
    install -d "${dependency_root}" /opt/app-builder/cargo; \
    tar --extract --gzip --file /opt/app-builder/dependency-cache/node-modules.tar.gz \
      --directory "${dependency_root}" --no-same-owner --no-same-permissions; \
    install --mode=0444 /opt/app-builder/cargo-closure/config.toml /opt/app-builder/cargo/config.toml; \
    chmod -R a-w,a+rX /opt/app-builder/dependency-cache /opt/app-builder/dependencies \
      /opt/app-builder/cargo /opt/app-builder/cargo-closure /opt/app-builder/rustup \
      /opt/app-builder/mise/installs/rust

USER vercel-sandbox

RUN --network=none set -eux; \
    test -d /opt/app-builder/dependencies; \
    MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false \
      mise exec rust@1.97.1 -- cargo --version | grep -E '^cargo 1[.]97[.]1 '
