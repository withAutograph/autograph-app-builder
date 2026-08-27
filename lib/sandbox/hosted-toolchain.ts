import { createHash } from "node:crypto";

export const HOSTED_MISE_VERSION = "2026.8.12";
export const HOSTED_BUN_VERSION = "1.3.14";
export const HOSTED_TOOLCHAIN_CONTRACT_VERSION = 2;

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
  },
} as const;

export const HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS = [
  "github.com",
  "release-assets.githubusercontent.com",
] as const;

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
    ;;`;
};

export function hostedToolchainBootstrapCommand(): string {
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
trap 'find "$work" -depth -delete 2>/dev/null || true' EXIT
curl --fail --location --silent --show-error "$mise_url" --output "$work/mise"
echo "$mise_sha  $work/mise" | sha256sum --check --strict
curl --fail --location --silent --show-error "$bun_url" --output "$work/bun.zip"
echo "$bun_sha  $work/bun.zip" | sha256sum --check --strict
unzip -q "$work/bun.zip" -d "$work"
sudo install --owner=root --group=root --mode=0755 "$work/mise" /usr/local/bin/mise
sudo install --owner=root --group=root --mode=0755 "$work/$bun_directory/bun" /usr/local/bin/bun
git --version
mise --version | grep -E '^2026[.]8[.]12($| )'
bun --version | grep -E '^1[.]3[.]14$'`;
}

export function hostedToolchainRevalidationKey(
  bootstrapCommand = hostedToolchainBootstrapCommand(),
): string {
  const binding = {
    contractVersion: HOSTED_TOOLCHAIN_CONTRACT_VERSION,
    mise: HOSTED_MISE_VERSION,
    bun: HOSTED_BUN_VERSION,
    artifacts: hostedToolchainArtifacts,
    downloadHosts: HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
    bootstrapCommand,
  };
  return `autograph-app-builder-vercel-toolchain-v${HOSTED_TOOLCHAIN_CONTRACT_VERSION}:${createHash(
    "sha256",
  )
    .update(JSON.stringify(binding))
    .digest("hex")}`;
}
