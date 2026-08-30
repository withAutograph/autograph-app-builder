import { createHash } from "node:crypto";

import {
  HOSTED_ARTIFACT_BYTES,
  HOSTED_ARTIFACT_CONTRACT_VERSION,
  HOSTED_ARTIFACT_SHA256,
  HOSTED_ARTIFACT_URL,
  HOSTED_DEPENDENCY_ARCHIVE_BYTES,
  HOSTED_DEPENDENCY_ARCHIVE_SHA256,
  HOSTED_DEPENDENCY_MANIFEST_SHA256,
  HOSTED_SOURCE_ARCHIVE_BYTES,
  HOSTED_SOURCE_ARCHIVE_SHA256,
  HOSTED_SOURCE_ENTRY_COUNT,
  HOSTED_SOURCE_WORKSPACE_DIGEST,
} from "./hosted-artifact";
import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";

export const HOSTED_MISE_VERSION = "2026.8.12";
export const HOSTED_BUN_VERSION = "1.3.14";
export const HOSTED_NODE_VERSION = "24.18.0";
export const HOSTED_TOOLCHAIN_CONTRACT_VERSION = 4;

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
  },
} as const;

export const HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS = [
  "github.com",
  "release-assets.githubusercontent.com",
  "nodejs.org",
] as const;

export const HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT =
  "/workspace/.app-builder/hosted-dependency-cache";

export const HOSTED_BOOTSTRAP_MINIMUM_FILE_BYTES = Math.max(
  HOSTED_ARTIFACT_BYTES,
  HOSTED_DEPENDENCY_ARCHIVE_BYTES,
  HOSTED_SOURCE_ARCHIVE_BYTES,
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
    ;;`;
};

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
command -v sha256sum >/dev/null
command -v unzip >/dev/null
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
tar --extract --gzip --file "$seed" --directory "$work" --no-same-owner --no-same-permissions
artifact="$work/.app-builder-hosted-seed"
test "$(stat --format='%s' "$artifact/source-tree.tar.gz")" = '${HOSTED_SOURCE_ARCHIVE_BYTES}'
printf '%s  %s\n' '${HOSTED_SOURCE_ARCHIVE_SHA256}' "$artifact/source-tree.tar.gz" | sha256sum --check --strict
test "$(stat --format='%s' "$artifact/dependency-cache/node-modules.tar.gz")" = '${HOSTED_DEPENDENCY_ARCHIVE_BYTES}'
printf '%s  %s\n' '${HOSTED_DEPENDENCY_ARCHIVE_SHA256}' "$artifact/dependency-cache/node-modules.tar.gz" | sha256sum --check --strict
printf '%s  %s\n' '${HOSTED_DEPENDENCY_MANIFEST_SHA256}' "$artifact/dependency-cache/manifest.json" | sha256sum --check --strict
curl --fail --location --silent --show-error "$mise_url" --output "$work/mise"
echo "$mise_sha  $work/mise" | sha256sum --check --strict
curl --fail --location --silent --show-error "$bun_url" --output "$work/bun.zip"
echo "$bun_sha  $work/bun.zip" | sha256sum --check --strict
curl --fail --location --silent --show-error "$node_url" --output "$work/node.tar.gz"
echo "$node_sha  $work/node.tar.gz" | sha256sum --check --strict
unzip -q "$work/bun.zip" -d "$work"
tar --extract --gzip --file "$work/node.tar.gz" --directory "$work" --no-same-owner --no-same-permissions
sudo install --owner=root --group=root --mode=0755 "$work/mise" /usr/local/bin/mise
sudo install --owner=root --group=root --mode=0755 "$work/$bun_directory/bun" /usr/local/bin/bun
sudo install --owner=root --group=root --mode=0755 "$work/$node_directory/bin/node" /usr/local/bin/node
sudo install --owner=root --group=root --mode=0755 -d /opt/app-builder/hosted-source/arrusted-development /opt/app-builder/dependency-cache
sudo install --owner=root --group=root --mode=0444 "$artifact/source-tree.tar.gz" /opt/app-builder/hosted-source/arrusted-development/source-tree.tar.gz
sudo install --owner=root --group=root --mode=0444 "$artifact/source-files.json" /opt/app-builder/hosted-source/arrusted-development/source-files.json
sudo install --owner=root --group=root --mode=0444 "$artifact/source-checksums.sha256" /opt/app-builder/hosted-source/arrusted-development/source-checksums.sha256
sudo install --owner=root --group=root --mode=0444 "$artifact/dependency-cache/manifest.json" /opt/app-builder/dependency-cache/manifest.json
sudo install --owner=root --group=root --mode=0444 "$artifact/dependency-cache/node-modules.tar.gz" /opt/app-builder/dependency-cache/node-modules.tar.gz
rm -rf /workspace/repository
install -d -m 0755 /workspace/repository /workspace/.app-builder
tar --extract --gzip --file "$artifact/source-tree.tar.gz" --directory /workspace/repository --no-same-owner --no-same-permissions
install -m 0644 "$artifact/source-files.json" /workspace/.app-builder/source-files.json
install -m 0644 "$artifact/source-checksums.sha256" /workspace/.app-builder/source-checksums.sha256
git --version
mise --version | grep -E '^2026[.]8[.]12($| )'
bun --version | grep -E '^1[.]3[.]14$'
node --version | grep -E '^v24[.]18[.]0$'
bun -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const files=JSON.parse(fs.readFileSync("/workspace/.app-builder/source-files.json","utf8")); if(files.length!==${HOSTED_SOURCE_ENTRY_COUNT}) process.exit(1); if(crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex")!=="${HOSTED_SOURCE_WORKSPACE_DIGEST}") process.exit(1); const cache=JSON.parse(fs.readFileSync("/opt/app-builder/dependency-cache/manifest.json","utf8")); if(cache.platform!=="linux/x86_64"||cache.scope!=="builder-execution"||cache.target.sha!=="ffa0c34adad449c1fe9a7d64d2178cb01bfc8d49"||cache.target.tree!=="88ead91d7b11aae11c526f1c2ee40f5b6db70642") process.exit(1)' \
  && (cd /workspace && sha256sum -c .app-builder/source-checksums.sha256 >/dev/null)`;
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
tar --extract --gzip --file "$seed" --directory "$work" --no-same-owner --no-same-permissions
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
    artifacts: hostedToolchainArtifacts,
    hostedArtifact: {
      contractVersion: HOSTED_ARTIFACT_CONTRACT_VERSION,
      sha256: HOSTED_ARTIFACT_SHA256,
      bytes: HOSTED_ARTIFACT_BYTES,
      sourceArchiveSha256: HOSTED_SOURCE_ARCHIVE_SHA256,
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
