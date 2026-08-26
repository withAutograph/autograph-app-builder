import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const IMAGE_PLATFORM = "linux/arm64";
export const IMAGE_OS = "linux";
export const IMAGE_ARCHITECTURE = "arm64";
export const IMAGE_REPOSITORY =
  "ghcr.io/withautograph/autograph-app-builder-sandbox";
export const IMAGE_VERSION = "sandbox-v2";
export const ARRUSTED_IMAGE_TARGET_SHA =
  "e4e76f52a365c6b8da2f84698b38844f26a31750";
export const ARRUSTED_IMAGE_TARGET_TREE =
  "7244f79f2ec523d0269fda6a9b59a1067bd723f8";

const sha40 = /^[0-9a-f]{40}$/u;
const sha256 = /^[0-9a-f]{64}$/u;
const digestReference = new RegExp(
  `^${IMAGE_REPOSITORY.replaceAll(".", "[.]")}@sha256:[0-9a-f]{64}$`,
  "u",
);

export type CommandSpec = Readonly<{
  program: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}>;

export const IMAGE_TOOL_VERSIONS = {
  docker: "29.4.0",
  "docker-buildx": "0.33.0",
  msb: "0.6.14",
  node: "24.18.0",
  pnpm: "11.7.0",
} as const;

export type ImageTool = keyof typeof IMAGE_TOOL_VERSIONS;

export function imageToolVersionCommand(tool: ImageTool): CommandSpec {
  return {
    program: tool,
    args: tool === "docker-buildx" ? ["version"] : ["--version"],
  };
}

export function assertExactImageToolVersion(
  tool: ImageTool,
  output: string,
): void {
  const expected = IMAGE_TOOL_VERSIONS[tool];
  const normalized = output.trim();
  const escaped = expected.replaceAll(".", "[.]");
  const valid =
    tool === "docker"
      ? new RegExp(`^Docker version ${escaped},`, "u").test(normalized)
      : tool === "docker-buildx"
        ? new RegExp(`\\bv${escaped}(?:\\s|$)`, "u").test(normalized)
        : tool === "msb"
          ? normalized === `msb ${expected}` ||
            normalized === `Microsandbox CLI v${expected}`
          : normalized === `${tool === "node" ? "v" : ""}${expected}`;
  if (!valid) throw new Error(`${tool} version does not match ${expected}.`);
}

export type ImageProvenance = Readonly<{
  version: 1;
  builder: Readonly<{
    root: string;
    stateRoot: string;
    commit: string;
    tree: string;
  }>;
  arrusted: Readonly<{
    root: string;
    commit: typeof ARRUSTED_IMAGE_TARGET_SHA;
    tree: typeof ARRUSTED_IMAGE_TARGET_TREE;
  }>;
  dockerfile: Readonly<{
    path: "containers/eve-sandbox/Dockerfile";
    sha256: string;
  }>;
  image: Readonly<{
    repository: typeof IMAGE_REPOSITORY;
    platform: typeof IMAGE_PLATFORM;
    tag: string;
    revision: string;
    version: typeof IMAGE_VERSION;
  }>;
  targetFiles: Readonly<Record<string, string>>;
  digest: string;
}>;

export type ExactProvenanceInput = Readonly<{
  builderRoot: string;
  stateRoot: string;
  observedBuilderCommit: string;
  observedBuilderTree: string;
  expectedBuilderCommit: string;
  expectedBuilderTree: string;
  builderStatus: string;
  builderIgnored: string;
  arrustedRoot: string;
  observedArrustedCommit: string;
  observedArrustedTree: string;
  arrustedStatus: string;
  arrustedIgnored: string;
  dockerfileSha256: string;
  expectedDockerfileSha256: string;
  targetFiles: Readonly<Record<string, string>>;
}>;

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const canonical = (value: unknown): string => JSON.stringify(value);

function exactSha(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`${label} is malformed.`);
}

export function assertCanonicalRoot(
  inputPath: string,
  observedRealPath: string,
  label: string,
): void {
  if (
    !isAbsolute(inputPath) ||
    resolve(inputPath) !== inputPath ||
    observedRealPath !== inputPath
  )
    throw new Error(`${label} must be an absolute canonical no-link path.`);
}

export function assertCleanStatus(status: string, label: string): void {
  if (status !== "") throw new Error(`${label} must have no dirty paths.`);
}

export function assertProofRuntimeIgnoredInventory(status: string): void {
  const ignored = status.split("\n").filter((line) => line.startsWith("!! "));
  if (ignored.length !== 1 || ignored[0] !== "!! node_modules/")
    throw new Error(
      "Proof runtime permits only the exact Builder node_modules/ ignored entry.",
    );
}

export function assertStandaloneGitMetadata(
  isDirectory: boolean,
  label: string,
): void {
  if (!isDirectory)
    throw new Error(
      `${label} image execution requires a clean standalone checkout with a .git directory.`,
    );
}

export function createExactImageProvenance(
  input: ExactProvenanceInput,
): ImageProvenance {
  exactSha(input.expectedBuilderCommit, sha40, "Expected Builder commit");
  exactSha(input.expectedBuilderTree, sha40, "Expected Builder tree");
  exactSha(
    input.expectedDockerfileSha256,
    sha256,
    "Expected Dockerfile digest",
  );
  assertCleanStatus(input.builderStatus, "Builder checkout");
  assertCleanStatus(input.builderIgnored, "Builder ignored-file inventory");
  assertCleanStatus(input.arrustedStatus, "Arrusted checkout");
  assertCleanStatus(input.arrustedIgnored, "Arrusted ignored-file inventory");
  if (input.observedBuilderCommit !== input.expectedBuilderCommit)
    throw new Error("Builder commit changed after approval.");
  if (input.observedBuilderTree !== input.expectedBuilderTree)
    throw new Error("Builder tree changed after approval.");
  if (input.observedArrustedCommit !== ARRUSTED_IMAGE_TARGET_SHA)
    throw new Error(
      "Arrusted commit does not match the immutable image target.",
    );
  if (input.observedArrustedTree !== ARRUSTED_IMAGE_TARGET_TREE)
    throw new Error("Arrusted tree does not match the immutable image target.");
  if (input.dockerfileSha256 !== input.expectedDockerfileSha256)
    throw new Error("Dockerfile digest changed after approval.");
  const targetFileEntries = Object.entries(input.targetFiles).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (
    targetFileEntries.length !== 7 ||
    targetFileEntries.some(([, digest]) => !sha256.test(digest))
  )
    throw new Error("The exact target-file digest set is incomplete.");
  const tag = `${IMAGE_REPOSITORY}:dockerfile-${input.dockerfileSha256.slice(0, 12)}-arrusted-${ARRUSTED_IMAGE_TARGET_SHA.slice(0, 8)}-arm64-v2`;
  const unsigned = {
    version: 1 as const,
    builder: {
      root: input.builderRoot,
      stateRoot: input.stateRoot,
      commit: input.observedBuilderCommit,
      tree: input.observedBuilderTree,
    },
    arrusted: {
      root: input.arrustedRoot,
      commit: ARRUSTED_IMAGE_TARGET_SHA,
      tree: ARRUSTED_IMAGE_TARGET_TREE,
    },
    dockerfile: {
      path: "containers/eve-sandbox/Dockerfile" as const,
      sha256: input.dockerfileSha256,
    },
    image: {
      repository: IMAGE_REPOSITORY,
      platform: IMAGE_PLATFORM,
      tag,
      revision: input.observedBuilderCommit,
      version: IMAGE_VERSION,
    },
    targetFiles: Object.fromEntries(targetFileEntries),
  } as const;
  const provenance = { ...unsigned, digest: hash(canonical(unsigned)) };
  assertNoSecretMaterial(provenance);
  return provenance;
}

export function imageBuildCommand(
  provenance: ImageProvenance,
  sanitizedTargetRoot: string,
): CommandSpec {
  assertCanonicalRoot(
    sanitizedTargetRoot,
    sanitizedTargetRoot,
    "Sanitized Arrusted build context",
  );
  return {
    program: "docker-buildx",
    args: [
      "build",
      "--platform",
      IMAGE_PLATFORM,
      "--build-context",
      `arrusted-target=${sanitizedTargetRoot}`,
      "--build-arg",
      `APP_BUILDER_REVISION=${provenance.builder.commit}`,
      "--file",
      provenance.dockerfile.path,
      "--tag",
      provenance.image.tag,
      "--load",
      provenance.builder.root,
    ],
  };
}

export function localImageInspectionCommand(
  provenance: ImageProvenance,
): CommandSpec {
  return {
    program: "docker",
    args: [
      "image",
      "inspect",
      "--platform",
      IMAGE_PLATFORM,
      provenance.image.tag,
    ],
  };
}

export function imagePushCommand(provenance: ImageProvenance): CommandSpec {
  return { program: "docker", args: ["push", provenance.image.tag] };
}

/**
 * GHCR credentials are supplied exclusively on the child's standard input.
 * The username is receipt-safe; the token is never an argument, environment
 * value, result, or receipt field.
 */
export function ghcrLoginCommand(username: string): CommandSpec {
  if (!/^[A-Za-z0-9-]{1,39}$/u.test(username))
    throw new Error("GHCR username is malformed.");
  return {
    program: "docker",
    args: ["login", "ghcr.io", "--username", username, "--password-stdin"],
  };
}

export function remoteManifestCommand(
  provenance: ImageProvenance,
): CommandSpec {
  return {
    program: "docker-buildx",
    args: ["imagetools", "inspect", "--raw", provenance.image.tag],
  };
}

export function remoteDescriptorCommand(
  provenance: ImageProvenance,
): CommandSpec {
  return {
    program: "docker-buildx",
    args: [
      "imagetools",
      "inspect",
      provenance.image.tag,
      "--format",
      "{{json .Manifest}}",
    ],
  };
}

export function remoteImageCommand(provenance: ImageProvenance): CommandSpec {
  return {
    program: "docker-buildx",
    args: [
      "imagetools",
      "inspect",
      provenance.image.tag,
      "--format",
      "{{json .Image}}",
    ],
  };
}

export function exactDigestReference(reference: string): string {
  if (!digestReference.test(reference))
    throw new Error(
      "The image reference must be the fixed GHCR repository at an exact digest.",
    );
  return reference;
}

export function imagePreloadCommand(reference: string): CommandSpec {
  return {
    program: "msb",
    args: ["pull", exactDigestReference(reference), "--materialize", "all"],
  };
}

export function prepareProofRuntimeCommand(): CommandSpec {
  return {
    program: "pnpm",
    args: ["install", "--force", "--frozen-lockfile", "--ignore-scripts"],
  };
}

export function inspectProofRuntimeCommand(): CommandSpec {
  return {
    program: "pnpm",
    args: ["list", "--depth", "Infinity", "--json"],
  };
}

export function sandboxProofCommand(
  reference: string,
  sourceRoot: string,
): CommandSpec {
  return {
    program: "node",
    args: [
      "--import",
      "tsx",
      "scripts/run-eve-eval.mts",
      "--gate-a-profile",
      "sandbox",
      "--gate-a-image",
      exactDigestReference(reference),
      "--gate-a-source-root",
      sourceRoot,
      "sandbox-identity-planning",
      "--strict",
      "--skip-report",
    ],
  };
}

type ImageInspect = {
  Id?: unknown;
  Architecture?: unknown;
  Os?: unknown;
  RepoTags?: unknown;
  Config?: { Labels?: Record<string, unknown> };
  RootFS?: { Layers?: unknown };
};

export function parseLocalImageInspection(
  raw: string,
  provenance: ImageProvenance,
): Readonly<{
  platform: typeof IMAGE_PLATFORM;
  tag: string;
  revision: string;
  imageId: string;
  rootFsLayers: readonly string[];
}> {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1)
    throw new Error("Local image inspection returned an unexpected image set.");
  const image = parsed[0] as ImageInspect;
  if (image.Os !== IMAGE_OS || image.Architecture !== IMAGE_ARCHITECTURE)
    throw new Error("Local image platform does not match linux/arm64.");
  if (
    !Array.isArray(image.RepoTags) ||
    !image.RepoTags.includes(provenance.image.tag)
  )
    throw new Error("Local image tag does not match the approved provenance.");
  const labels = image.Config?.Labels;
  if (
    labels?.["org.opencontainers.image.revision"] !==
      provenance.builder.commit ||
    labels["org.opencontainers.image.version"] !== IMAGE_VERSION
  )
    throw new Error("Local image OCI provenance labels do not match.");
  if (typeof image.Id !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(image.Id))
    throw new Error("Local image inspection did not return an exact image ID.");
  const rootFsLayers = image.RootFS?.Layers;
  if (
    !Array.isArray(rootFsLayers) ||
    rootFsLayers.length === 0 ||
    rootFsLayers.some(
      (layer) =>
        typeof layer !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(layer),
    )
  )
    throw new Error(
      "Local image inspection did not return exact rootfs layers.",
    );
  return {
    platform: IMAGE_PLATFORM,
    tag: provenance.image.tag,
    revision: provenance.builder.commit,
    imageId: image.Id,
    rootFsLayers: rootFsLayers as string[],
  };
}

type RemoteDescriptor = { digest?: unknown };
type RemoteManifest = {
  config?: { digest?: unknown };
  layers?: readonly { digest?: unknown }[];
};
type RemoteImage = {
  architecture?: unknown;
  os?: unknown;
  config?: { Labels?: Record<string, unknown> };
  rootfs?: { diff_ids?: unknown };
};

export function parseRemoteImageInspection(
  descriptorRaw: string,
  manifestRaw: string,
  imageRaw: string,
  provenance: ImageProvenance,
  local: Readonly<{ imageId: string; rootFsLayers: readonly string[] }>,
): Readonly<{
  digest: string;
  reference: string;
  platform: typeof IMAGE_PLATFORM;
  revision: string;
}> {
  const descriptor = JSON.parse(descriptorRaw) as RemoteDescriptor;
  const manifest = JSON.parse(manifestRaw) as RemoteManifest;
  const image = JSON.parse(imageRaw) as RemoteImage;
  if (
    typeof descriptor.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(descriptor.digest)
  )
    throw new Error(
      "Remote registry inspection did not return an exact manifest digest.",
    );
  if (image.os !== IMAGE_OS || image.architecture !== IMAGE_ARCHITECTURE)
    throw new Error("Remote image platform does not match linux/arm64.");
  const labels = image.config?.Labels;
  if (
    labels?.["org.opencontainers.image.revision"] !==
      provenance.builder.commit ||
    labels["org.opencontainers.image.version"] !== IMAGE_VERSION
  )
    throw new Error("Remote image OCI provenance labels do not match.");
  if (manifest.config?.digest !== local.imageId)
    throw new Error(
      "Remote image config digest does not match the inspected local image.",
    );
  const remoteDiffIds = image.rootfs?.diff_ids;
  if (
    !Array.isArray(remoteDiffIds) ||
    remoteDiffIds.length !== local.rootFsLayers.length ||
    remoteDiffIds.some((digest, index) => digest !== local.rootFsLayers[index])
  )
    throw new Error(
      "Remote image rootfs identity does not match the inspected local image.",
    );
  if (
    !Array.isArray(manifest.layers) ||
    manifest.layers.length === 0 ||
    manifest.layers.some(
      (layer) =>
        typeof layer.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(layer.digest),
    )
  )
    throw new Error("Remote manifest does not contain exact layer digests.");
  const reference = exactDigestReference(
    `${IMAGE_REPOSITORY}@${descriptor.digest}`,
  );
  return {
    digest: descriptor.digest,
    reference,
    platform: IMAGE_PLATFORM,
    revision: provenance.builder.commit,
  };
}

const secretKey = /(authorization|cookie|credential|password|secret|token)/iu;
const secretValue = /(bearer\s+|gh[pousr]_[A-Za-z0-9_]+|github_pat_)/iu;

export function assertNoSecretMaterial(value: unknown, path = "receipt"): void {
  if (typeof value === "string") {
    if (secretValue.test(value))
      throw new Error(`${path} contains secret-like material.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretMaterial(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (secretKey.test(key))
      throw new Error(`${path}.${key} is a forbidden secret field.`);
    assertNoSecretMaterial(entry, `${path}.${key}`);
  }
}

export function hashArtifact(content: string | Uint8Array): string {
  return hash(content);
}
