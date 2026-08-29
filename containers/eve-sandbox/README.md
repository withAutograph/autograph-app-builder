# Autograph App Builder execution image (linux/arm64)

This image is Autograph App Builder's externally built, target-bound execution
environment. It pins its Eve runtime base, Git, mise `2026.8.12`, and Bun
`1.3.14`, plus Rust and Cargo `1.97.1`.
It also builds the exact external dependency closure needed by Arrusted's app
creation and app-specific validation commands, including
`@vercel/microfrontends` `2.4.0`, from a clean
checkout of Arrusted commit
`2a461d34dc3ed64564de9fd39c4a0991d4082d0c`.

The final image contains no Arrusted source tree, credentials, or provider
configuration. It contains a normalized, deterministically gzip-compressed
`node_modules` archive and a read-only manifest under
`/opt/app-builder/dependency-cache/`. The manifest binds the
target commit/tree, mise configuration and lock, Bun lock, target command
implementations, runtime version, dependency version, archive size, and archive
SHA-256. The App Builder derives the cache receipt from observed manifest and
archive bytes; there is no operator-supplied cache digest.

## Build and publish boundary

Use clean standalone App Builder and Arrusted checkouts whose `.git`
directories are real directories, not worktree indirection. Every task requires
the exact accepted Builder commit/tree and Dockerfile digest and re-observes both
clean checkouts before acting. An integration worktree is preparation evidence,
not an eligible image execution source. `--state-root` must be an absolute,
canonical, no-link, current-user-owned mode `0700` directory outside both
repositories (or an absent leaf beneath a canonical parent). It contains only
the mode `0600`, fsynced receipts for one exact provenance, the exact owned mode
`0600` Docker configuration, and its exact mode `0700` identity-checking helper
wrapper; unknown files, configuration drift, or a receipt from another
provenance fail closed.

Every lifecycle task takes one exclusive OS-held lock derived from the exact
state-root path before it inspects receipts or invokes an external tool. The OS
releases the lock if the owner is killed. A later owner removes only exact,
owned mode-`0600` interrupted receipt temporaries and exact owned mode-`0700`
sanitized-context temporaries; links, unexpected modes, and unknown artifacts
fail closed. Concurrent build, inspection, push, preload, runtime preparation,
and proof calls therefore cannot dispatch the same external operation twice.

Verify sources, build, inspect the immutable local image identity, publish, and
read back the GHCR manifest in this order:

Match credentials only after separate publication approval. Supply the approved
package token once through bounded standard input. The task compares it directly
and in constant time with the credential read from the existing GitHub CLI
keyring; neither token is accepted from an argument or environment variable.
The pinned `gh` 2.98.0 status must name one active keyring-backed identity with
`write:packages`, and read-only API evidence must bind that identity to the
`withAutograph` namespace. The command never starts login, OAuth, refresh, or a
Docker credential-store operation. It records only public identity and
provenance-domain digests, the closed provider boundary, and the fact that the
operator approval arrived by one-time standard input.

Later push and read-back commands re-read the same credential from the pinned
GitHub CLI keyring. A lifecycle-owned Docker `get` helper sends credential JSON
to the exact digest-bound Docker or Buildx process through an in-memory pipe;
it never places the token in argv, a child environment, a receipt, or a file.
Ambient GitHub and Docker configuration is not publication authority. GitHub
CLI, its no-plaintext-token configuration digest, Docker, Buildx, the wrapper,
verifier module, Node runtime, platform, and closed Docker configuration are
all bound into the login and publication receipts.

```bash
mise run image:login -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 REPLACE_WITH_ACCEPTED_DOCKERFILE_SHA256 \
  --username REPLACE_WITH_GITHUB_LOGIN
```

Type or paste the token only for the first exact receipt at the command's
standard input. An idempotent retry reuses that closed receipt without reading
stdin or contacting GitHub. Do not place the token in shell history, a receipt,
an environment export, or `hosts.yml`. The
subsequent push requires the matching keyring-bound login receipt, while remote
inspection independently reads back the published manifest, config, layers,
platform, and OCI provenance.

```bash
mise run image:verify-sources -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 2f72e495d0d2f115b915f3955475656e37fa550b42bdf331236cc44732120d72
mise run image:build -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 2f72e495d0d2f115b915f3955475656e37fa550b42bdf331236cc44732120d72
mise run image:inspect-local -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 2f72e495d0d2f115b915f3955475656e37fa550b42bdf331236cc44732120d72
mise run image:push -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 2f72e495d0d2f115b915f3955475656e37fa550b42bdf331236cc44732120d72
mise run image:inspect-remote -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 2f72e495d0d2f115b915f3955475656e37fa550b42bdf331236cc44732120d72
```

The tasks derive the transient tag from the first 12 hex characters of the
Dockerfile's SHA-256 and the Arrusted target. They resolve pinned Docker,
standalone Buildx, Microsandbox, Node, and pnpm binaries through mise. The local receipt binds the image
ID and rootfs diff IDs. Remote readback requires one exact OCI index containing
the matching `linux/arm64` platform manifest and one descriptor-bound BuildKit
attestation companion. The companion is recorded but is not trusted as
provenance. The selected platform manifest is then fetched by digest and its
closed manifest shape, labels, and rootfs identity must match before the task
emits the platform digest-only reference. The selected platform manifest
digest, not the transient tag or top-level index, remains runtime authority.
For this exact Dockerfile and Arrusted source, the transient tag is
`dockerfile-<dockerfile-sha-prefix>-arrusted-2a461d34-arm64-v2`; it is only a publication
handle and never runtime authority.

The build fails on target SHA/tree or contract/lock drift. It performs the
networked `bun install --frozen-lockfile --ignore-scripts` only while building
the immutable cache layer. The final self-check runs with BuildKit networking
disabled.

The Arrusted checkout itself is never a BuildKit context. Immediately before
the build, the locked lifecycle reconstructs a private temporary context from
the exact commit's tracked Git blobs and modes, rejecting submodules, unsafe
paths, unsupported modes, and escaping links. It adds a content-free source
manifest binding the already verified commit, tree, tracked-entry digest, and
entry count. The temporary context contains no `.git` directory or Git config,
is passed as the named `arrusted-target` context, and is removed after the
command or reconciled after a crash. The default Builder context remains
deny-all through `.dockerignore`.

Build, registry publication, and local acquisition are separate approvals.
After an approved push, resolve the registry manifest digest and use only:

```text
ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:<remote-manifest-digest>
```

Buildx receives a lifecycle-owned temporary `BUILDX_CONFIG` for builds and
grouped registry reads. The directory is removed on success or failure and is
the only Buildx state shape recovered after an interrupted operation;
`DOCKER_CONFIG` remains the closed credential-helper root.

The earlier published image ending in `c44a4077...` contains Bun `1.2.20` and
no target dependency closure. It is intentionally ineligible for real target
identity or planning.

## Local Microsandbox preload

A Docker pull does not populate Microsandbox's OCI cache. The mise-pinned
standalone `msb` binary preloads the exact approved digest from
`remote-image-receipt.json`. The proof then uses Eve from a separately prepared,
frozen Builder runtime. Source verification, build, publication, readback, and
preload require empty ignored-file inventories in both repositories. The proof
runtime is the sole exception: `image:prepare-proof-runtime` performs a forced
`pnpm install --frozen-lockfile --ignore-scripts`, permits exactly the collapsed
Builder entry `node_modules/`, and records the pnpm lock, dependency metadata,
and normalized path/mode/symlink/file-byte tree digests. Symlinks must resolve
inside `node_modules`. Arrusted's ignored inventory remains empty, and
`.dockerignore` denies the entire Builder context so the runtime dependencies
cannot enter the image build. Each proof re-hashes the actual dependency bytes
before it can reuse or produce a receipt.

```bash
mise run image:preload -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 2f72e495d0d2f115b915f3955475656e37fa550b42bdf331236cc44732120d72 \
  --image ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:REPLACE_WITH_VERIFIED_DIGEST
mise run image:prepare-proof-runtime -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 2f72e495d0d2f115b915f3955475656e37fa550b42bdf331236cc44732120d72
mise run image:prove -- --arrusted-root /absolute/path/to/standalone-arrusted \
  --state-root /absolute/path/to/private-image-lifecycle-state \
  --builder-commit REPLACE_WITH_ACCEPTED_BUILDER_COMMIT \
  --builder-tree REPLACE_WITH_ACCEPTED_BUILDER_TREE \
  --dockerfile-sha256 2f72e495d0d2f115b915f3955475656e37fa550b42bdf331236cc44732120d72 \
  --image ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:REPLACE_WITH_VERIFIED_DIGEST
```

The Eve proof uses the signed Gate A sandbox profile to bind the exact digest
and canonical Arrusted source root. It prepares the immutable source tree,
records and accepts a proof AppSpec, materializes the image-internal offline
dependency cache into builder-owned planning metadata, and runs only the fixed
typed identity and planning commands. The eval must terminate in `planned` and
asserts that apply, validation, change-set acceptance, publication, generic
shell, and generic file-write tools never ran. It never installs over the
network at runtime.
Building another target, architecture, or dependency closure requires another
reviewed image and separate approval.

The first observational target proof is scoped to app id `builder-proof` and
sanitized AppSpec owner `Autograph App Builder proof`. Those values do not grant
apply, validation, publication, provider, deployment, release, or cleanup
authority. Retain local proof artifacts until their sanitized receipts are
accepted.
