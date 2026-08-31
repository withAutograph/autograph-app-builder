import { createHash } from "node:crypto";

import {
  HOSTED_ARTIFACT_BYTES,
  HOSTED_ARTIFACT_CONTRACT_VERSION,
  HOSTED_ARTIFACT_SHA256,
  HOSTED_ARTIFACT_URL,
  HOSTED_DEPENDENCY_ARCHIVE_BYTES,
  HOSTED_DEPENDENCY_ARCHIVE_SHA256,
  HOSTED_DEPENDENCY_MANIFEST_SHA256,
} from "./hosted-artifact";
import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";

export const HOSTED_MISE_VERSION = "2026.8.12";
export const HOSTED_BUN_VERSION = "1.3.14";
export const HOSTED_NODE_VERSION = "24.18.0";
export const HOSTED_RUST_VERSION = "1.97.1";
export const HOSTED_TOOLCHAIN_CONTRACT_VERSION = 5;

export const hostedToolchainArtifacts = {
  aarch64: {
    miseUrl:
      "https://github.com/jdx/mise/releases/download/v2026.8.12/mise-v2026.8.12-linux-arm64",
    miseSha256:
      "071e2d16905360fa04762422a2a889692bb3a4d30f27650de50bc1ac0564840b",
    bunUrl:
      "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip",
    bunSha256:
      "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
    bunDirectory: "bun-linux-aarch64",
    nodeUrl:
      "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-arm64.tar.gz",
    nodeSha256:
      "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
    nodeDirectory: "node-v24.18.0-linux-arm64",
    rust: {
      cargoUrl:
        "https://static.rust-lang.org/dist/2026-07-16/cargo-1.97.1-aarch64-unknown-linux-gnu.tar.xz",
      cargoSha256:
        "8f70bcaccea5ba4db187c3fd4d64e24592b4e16af513497201f5909d61691dbe",
      cargoDirectory: "cargo-1.97.1-aarch64-unknown-linux-gnu",
      rustcUrl:
        "https://static.rust-lang.org/dist/2026-07-16/rustc-1.97.1-aarch64-unknown-linux-gnu.tar.xz",
      rustcSha256:
        "b344b81f0cd4c2246c7da8b197fe7a339d7dd02bb15cb69b2524115d9c75224c",
      rustcDirectory: "rustc-1.97.1-aarch64-unknown-linux-gnu",
      stdUrl:
        "https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-aarch64-unknown-linux-gnu.tar.xz",
      stdSha256:
        "46aed8e63186350004d8ec6afca798811e6530b514352e5a8a26f3dc4939b3be",
      stdDirectory: "rust-std-1.97.1-aarch64-unknown-linux-gnu",
    },
  },
  x86_64: {
    miseUrl:
      "https://github.com/jdx/mise/releases/download/v2026.8.12/mise-v2026.8.12-linux-x64",
    miseSha256:
      "f2092b1e67f0abc8803d3be120dd2bc5b656dd99680ba3159f710e149da10d05",
    bunUrl:
      "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip",
    bunSha256:
      "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
    bunDirectory: "bun-linux-x64",
    nodeUrl: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.gz",
    nodeSha256:
      "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
    nodeDirectory: "node-v24.18.0-linux-x64",
    rust: {
      cargoUrl:
        "https://static.rust-lang.org/dist/2026-07-16/cargo-1.97.1-x86_64-unknown-linux-gnu.tar.xz",
      cargoSha256:
        "e1be5f5ff7f7f80ca506fb65770b759edbdc6d303781ed71c5de8ec8a8394779",
      cargoDirectory: "cargo-1.97.1-x86_64-unknown-linux-gnu",
      rustcUrl:
        "https://static.rust-lang.org/dist/2026-07-16/rustc-1.97.1-x86_64-unknown-linux-gnu.tar.xz",
      rustcSha256:
        "9819d0a32d56bd339585319c80260e332779f5541fd66838ab7e016d6c814819",
      rustcDirectory: "rustc-1.97.1-x86_64-unknown-linux-gnu",
      stdUrl:
        "https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-x86_64-unknown-linux-gnu.tar.xz",
      stdSha256:
        "1c1e704ae80126b7de34f72ea2825f7fd01736dec20732faed47374b95282fba",
      stdDirectory: "rust-std-1.97.1-x86_64-unknown-linux-gnu",
    },
  },
} as const;

export const HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS = [
  "github.com",
  "release-assets.githubusercontent.com",
  "nodejs.org",
  "static.rust-lang.org",
] as const;

export const HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT =
  "/workspace/.app-builder/hosted-dependency-cache";

export const HOSTED_BOOTSTRAP_MINIMUM_FILE_BYTES = Math.max(
  HOSTED_ARTIFACT_BYTES,
  HOSTED_DEPENDENCY_ARCHIVE_BYTES,
);

const artifactCase = (
  architecture: keyof typeof hostedToolchainArtifacts,
): string => {
  const artifact = hostedToolchainArtifacts[architecture];
  return `${architecture})
    mise_url='${artifact.miseUrl}'
    mise_sha='${artifact.miseSha256}'
    bun_url='${artifact.bunUrl}'
    bun_sha='${artifact.bunSha256}'
    bun_directory='${artifact.bunDirectory}'
    node_url='${artifact.nodeUrl}'
    node_sha='${artifact.nodeSha256}'
    node_directory='${artifact.nodeDirectory}'
    cargo_url='${artifact.rust.cargoUrl}'
    cargo_sha='${artifact.rust.cargoSha256}'
    cargo_directory='${artifact.rust.cargoDirectory}'
    rustc_url='${artifact.rust.rustcUrl}'
    rustc_sha='${artifact.rust.rustcSha256}'
    rustc_directory='${artifact.rust.rustcDirectory}'
    rust_std_url='${artifact.rust.stdUrl}'
    rust_std_sha='${artifact.rust.stdSha256}'
    rust_std_directory='${artifact.rust.stdDirectory}'
    ;;`;
};

export const HOSTED_ARCHIVE_EXTRACTION_PROGRAM = `import pathlib
import sys
import tarfile

archive_path = sys.argv[1]
destination = pathlib.Path(sys.argv[2]).resolve()
prefix = sys.argv[3] or None
destination.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive_path, "r:*") as archive:
    selected = []
    for member in archive.getmembers():
        member_path = pathlib.PurePosixPath(member.name)
        if member_path.is_absolute() or ".." in member_path.parts:
            raise SystemExit("unsafe archive path")
        if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
            raise SystemExit("unsupported archive entry")
        if prefix is None or member.name == prefix or member.name.startswith(prefix + "/"):
            selected.append(member)
    if prefix is not None and not selected:
        raise SystemExit("required archive subtree is missing")
    archive.extractall(destination, members=selected, filter="data")`;

export function hostedArchiveExtractorShellFunction(): string {
  return `extract_verified_archive() {
  python3 - "$1" "$2" "\${3-}" <<'PY'
${HOSTED_ARCHIVE_EXTRACTION_PROGRAM}
PY
}`;
}

export function hostedToolchainBootstrapCommand(
  maximumFileBytes: number = SANDBOX_EXECUTION_POLICY.command.maximumFileBytes,
): string {
  if (maximumFileBytes < HOSTED_BOOTSTRAP_MINIMUM_FILE_BYTES) {
    throw new Error(
      "The sandbox file-size limit cannot hold the hosted artifact.",
    );
  }
  return `set -euo pipefail
case "$(uname -m)" in
  ${artifactCase("aarch64")}
  ${artifactCase("x86_64")}
  *) echo 'unsupported Vercel Sandbox architecture' >&2; exit 1 ;;
esac
command -v curl >/dev/null
command -v git >/dev/null
command -v python3 >/dev/null
command -v sha256sum >/dev/null
command -v unzip >/dev/null
${hostedArchiveExtractorShellFunction()}
work="$(mktemp -d /tmp/app-builder-toolchain.XXXXXX)"
seed='/workspace/.app-builder/hosted-seed.tar.gz'
stage='prepare-workspace'
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then printf 'hosted_toolchain_bootstrap_failed:%s\n' "$stage" >&2; fi
  find "$work" -depth -delete 2>/dev/null || true
  rm -f "$seed"
  exit "$status"
}
trap cleanup EXIT
install -d -m 0755 /workspace/.app-builder
stage='artifact-download'
curl --fail --location --silent --show-error '${HOSTED_ARTIFACT_URL}' --output "$seed"
stage='artifact-verification'
test "$(stat --format='%s' "$seed")" = '${HOSTED_ARTIFACT_BYTES}'
echo '${HOSTED_ARTIFACT_SHA256}  /workspace/.app-builder/hosted-seed.tar.gz' | sha256sum --check --strict
extract_verified_archive "$seed" "$work" '.app-builder-hosted-seed/dependency-cache'
artifact="$work/.app-builder-hosted-seed"
test "$(stat --format='%s' "$artifact/dependency-cache/node-modules.tar.gz")" = '${HOSTED_DEPENDENCY_ARCHIVE_BYTES}'
printf '%s  %s\n' '${HOSTED_DEPENDENCY_ARCHIVE_SHA256}' "$artifact/dependency-cache/node-modules.tar.gz" | sha256sum --check --strict
printf '%s  %s\n' '${HOSTED_DEPENDENCY_MANIFEST_SHA256}' "$artifact/dependency-cache/manifest.json" | sha256sum --check --strict
stage='mise-download-verification'
curl --fail --location --silent --show-error "$mise_url" --output "$work/mise"
echo "$mise_sha  $work/mise" | sha256sum --check --strict
stage='bun-download-verification'
curl --fail --location --silent --show-error "$bun_url" --output "$work/bun.zip"
echo "$bun_sha  $work/bun.zip" | sha256sum --check --strict
stage='node-download-verification'
curl --fail --location --silent --show-error "$node_url" --output "$work/node.tar.gz"
echo "$node_sha  $work/node.tar.gz" | sha256sum --check --strict
stage='cargo-download-verification'
curl --fail --location --silent --show-error "$cargo_url" --output "$work/cargo.tar.xz"
echo "$cargo_sha  $work/cargo.tar.xz" | sha256sum --check --strict
stage='rustc-download-verification'
curl --fail --location --silent --show-error "$rustc_url" --output "$work/rustc.tar.xz"
echo "$rustc_sha  $work/rustc.tar.xz" | sha256sum --check --strict
stage='rust-std-download-verification'
curl --fail --location --silent --show-error "$rust_std_url" --output "$work/rust-std.tar.xz"
echo "$rust_std_sha  $work/rust-std.tar.xz" | sha256sum --check --strict
stage='toolchain-extraction'
unzip -q "$work/bun.zip" -d "$work"
extract_verified_archive "$work/node.tar.gz" "$work"
extract_verified_archive "$work/cargo.tar.xz" "$work"
extract_verified_archive "$work/rustc.tar.xz" "$work"
extract_verified_archive "$work/rust-std.tar.xz" "$work"
stage='toolchain-installation'
sudo install --owner=root --group=root --mode=0755 "$work/mise" /usr/local/bin/mise
sudo install --owner=root --group=root --mode=0755 "$work/$bun_directory/bun" /usr/local/bin/bun
sudo install --owner=root --group=root --mode=0755 "$work/$node_directory/bin/node" /usr/local/bin/node
sudo "$work/$cargo_directory/install.sh" --prefix=/opt/app-builder/rust --disable-ldconfig
sudo "$work/$rustc_directory/install.sh" --prefix=/opt/app-builder/rust --disable-ldconfig
sudo "$work/$rust_std_directory/install.sh" --prefix=/opt/app-builder/rust --disable-ldconfig
sudo ln --symbolic --force /opt/app-builder/rust/bin/cargo /usr/local/bin/cargo
sudo ln --symbolic --force /opt/app-builder/rust/bin/rustc /usr/local/bin/rustc
sudo install --owner=root --group=root --mode=0755 -d /opt/app-builder/dependency-cache
sudo install --owner=root --group=root --mode=0444 "$artifact/dependency-cache/manifest.json" /opt/app-builder/dependency-cache/manifest.json
sudo install --owner=root --group=root --mode=0444 "$artifact/dependency-cache/node-modules.tar.gz" /opt/app-builder/dependency-cache/node-modules.tar.gz
stage='toolchain-readback'
git --version
mise --version | grep -E '^2026[.]8[.]12($| )'
bun --version | grep -E '^1[.]3[.]14$'
node --version | grep -E '^v24[.]18[.]0$'
cargo --version | grep -E '^cargo 1[.]97[.]1 '
rustc --version | grep -E '^rustc 1[.]97[.]1 '
node -e 'const fs=require("node:fs"); const cache=JSON.parse(fs.readFileSync("/opt/app-builder/dependency-cache/manifest.json","utf8")); if(cache.platform!=="linux/x86_64"||cache.scope!=="builder-execution"||cache.target.sha!=="d378904a05e1bc2c0896886e6fbd3b816babaee2"||cache.target.tree!=="6735f4b45cc2b29a139531a41dac990c925e0d39") process.exit(1)'`;
}

export function hostedArtifactWorkspaceInstallCommand(): string {
  return `set -euo pipefail
command -v sha256sum >/dev/null
work="$(mktemp -d /tmp/app-builder-hosted-artifact.XXXXXX)"
seed='/workspace/.app-builder/hosted-seed.tar.gz'
trap 'find "$work" -depth -delete 2>/dev/null || true; rm -f "$seed"' EXIT
install -d -m 0755 /workspace/.app-builder
curl --fail --location --silent --show-error '${HOSTED_ARTIFACT_URL}' --output "$seed"
test "$(stat --format='%s' "$seed")" = '${HOSTED_ARTIFACT_BYTES}'
printf '%s  %s\n' '${HOSTED_ARTIFACT_SHA256}' "$seed" | sha256sum --check --strict
tar --extract --gzip --file "$seed" --directory "$work" --no-same-owner --no-same-permissions .app-builder-hosted-seed/dependency-cache
artifact="$work/.app-builder-hosted-seed/dependency-cache"
test "$(stat --format='%s' "$artifact/node-modules.tar.gz")" = '${HOSTED_DEPENDENCY_ARCHIVE_BYTES}'
printf '%s  %s\n' '${HOSTED_DEPENDENCY_ARCHIVE_SHA256}' "$artifact/node-modules.tar.gz" | sha256sum --check --strict
printf '%s  %s\n' '${HOSTED_DEPENDENCY_MANIFEST_SHA256}' "$artifact/manifest.json" | sha256sum --check --strict
rm -rf '${HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT}'
install -d -m 0755 '${HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT}'
install -m 0444 "$artifact/manifest.json" '${HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT}/manifest.json'
install -m 0444 "$artifact/node-modules.tar.gz" '${HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT}/node-modules.tar.gz'`;
}

export function hostedToolchainRevalidationKey(
  bootstrapCommand = hostedToolchainBootstrapCommand(),
): string {
  const binding = {
    contractVersion: HOSTED_TOOLCHAIN_CONTRACT_VERSION,
    mise: HOSTED_MISE_VERSION,
    bun: HOSTED_BUN_VERSION,
    node: HOSTED_NODE_VERSION,
    rust: HOSTED_RUST_VERSION,
    artifacts: hostedToolchainArtifacts,
    hostedArtifact: {
      contractVersion: HOSTED_ARTIFACT_CONTRACT_VERSION,
      sha256: HOSTED_ARTIFACT_SHA256,
      bytes: HOSTED_ARTIFACT_BYTES,
      dependencyManifestSha256: HOSTED_DEPENDENCY_MANIFEST_SHA256,
      dependencyArchiveSha256: HOSTED_DEPENDENCY_ARCHIVE_SHA256,
    },
    downloadHosts: HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
    bootstrapCommand,
  };
  return `autograph-app-builder-vercel-toolchain-v${HOSTED_TOOLCHAIN_CONTRACT_VERSION}:${createHash(
    "sha256",
  )
    .update(JSON.stringify(binding))
    .digest("hex")}`;
}
