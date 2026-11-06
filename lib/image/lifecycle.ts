import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export const IMAGE_PLATFORM = "linux/arm64";
export const IMAGE_OS = "linux";
export const IMAGE_ARCHITECTURE = "arm64";
export const IMAGE_REPOSITORY = "ghcr.io/withautograph/autograph-app-builder-sandbox";
export const IMAGE_VERSION = "sandbox-v2";
export const ARRUSTED_IMAGE_TARGET_SHA = "d378904a05e1bc2c0896886e6fbd3b816babaee2";
export const ARRUSTED_IMAGE_TARGET_TREE = "6735f4b45cc2b29a139531a41dac990c925e0d39";

const sha40 = /^[0-9a-f]{40}$/u;
const sha256 = /^[0-9a-f]{64}$/u;
const nodeModulesIgnoredEntry = "!! node_modules/";
const dockerBuildxVersionArgument = "version";
const secretKey = /(?<key>authorization|cookie|credential|password|secret|token)/iu;
const secretValue = /(?<value>bearer\s+|gh[pousr]_[A-Za-z0-9_]+|github_pat_)/iu;
const ociManifestMediaType = "application/vnd.oci.image.manifest.v1+json";
const sha256Digest = /^sha256:[0-9a-f]{64}$/u;
const digestReference = new RegExp(
  `^${IMAGE_REPOSITORY.replaceAll(".", "[.]")}@sha256:[0-9a-f]{64}$`,
  "u",
);

export type CommandSpec = Readonly<{
  program: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
  launcher?: "trusted-node";
}>;

export const IMAGE_TOOL_VERSIONS = {
  docker: "29.4.0",
  "docker-buildx": "0.33.0",
  msb: "0.5.10",
  node: "24.18.0",
  pnpm: "11.7.0",
} as const;

export type ImageTool = keyof typeof IMAGE_TOOL_VERSIONS;

export const imageToolVersionCommand = (tool: ImageTool): CommandSpec => ({
  args: tool === "docker-buildx" ? [dockerBuildxVersionArgument] : ["--version"],
  program: tool,
});

export const assertExactImageToolVersion = (tool: ImageTool, output: string): void => {
  const expected = IMAGE_TOOL_VERSIONS[tool];
  const normalized = output.trim();
  const escaped = expected.replaceAll(".", "[.]");
  let valid: boolean;
  if (tool === "docker") {
    valid = new RegExp(`^Docker version ${escaped},`, "u").test(normalized);
  } else if (tool === "docker-buildx") {
    valid = new RegExp(`\\bv${escaped}(?:\\s|$)`, "u").test(normalized);
  } else if (tool === "msb") {
    valid = normalized === `msb ${expected}` || normalized === `Microsandbox CLI v${expected}`;
  } else {
    valid = normalized === `${tool === "node" ? "v" : ""}${expected}`;
  }
  if (!valid) {
    throw new Error(`${tool} version does not match ${expected}.`);
  }
};

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

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

type CanonicalProvenance = Omit<ImageProvenance, "digest">;
const canonical = (value: CanonicalProvenance): string => JSON.stringify(value);

const exactSha = (value: string, pattern: RegExp, label: string): void => {
  if (!pattern.test(value)) {
    throw new Error(`${label} is malformed.`);
  }
};

export const assertCanonicalRoot = (
  inputPath: string,
  observedRealPath: string,
  label: string,
): void => {
  if (
    !path.isAbsolute(inputPath) ||
    path.resolve(inputPath) !== inputPath ||
    observedRealPath !== inputPath
  ) {
    throw new Error(`${label} must be an absolute canonical no-link path.`);
  }
};

export const assertCleanStatus = (status: string, label: string): void => {
  if (status !== "") {
    throw new Error(`${label} must have no dirty paths.`);
  }
};

export const assertProofRuntimeIgnoredInventory = (status: string): void => {
  const ignored = status.split("\n").filter((line) => line.startsWith("!! "));
  if (ignored.length !== 1 || ignored[0] !== nodeModulesIgnoredEntry) {
    throw new Error("Proof runtime permits only the exact Builder node_modules/ ignored entry.");
  }
};

export const assertStandaloneGitMetadata = (isDirectory: boolean, label: string): void => {
  if (!isDirectory) {
    throw new Error(
      `${label} image execution requires a clean standalone checkout with a .git directory.`,
    );
  }
};

type SecretScanValue =
  | string
  | number
  | boolean
  | null
  | readonly SecretScanValue[]
  | { readonly [key: string]: SecretScanValue };

const secretScanSchema: z.ZodType<SecretScanValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(secretScanSchema),
    z.record(z.string(), secretScanSchema),
  ]),
);

export const assertNoSecretMaterial = (value: SecretScanValue, receiptPath = "receipt"): void => {
  const parsed = secretScanSchema.parse(value);
  const scan = (entry: SecretScanValue, entryPath: string): void => {
    const parsedString = z.string().safeParse(entry);
    if (parsedString.success) {
      if (secretValue.test(parsedString.data)) {
        throw new Error(`${entryPath} contains secret-like material.`);
      }
      return;
    }
    if (Array.isArray(entry)) {
      const children = z.array(secretScanSchema).parse(entry);
      for (const [index, child] of children.entries()) {
        scan(child, `${entryPath}[${index}]`);
      }
      return;
    }
    if (entry !== null) {
      const children = z.record(z.string(), secretScanSchema).parse(entry);
      for (const key of Object.keys(children)) {
        if (secretKey.test(key)) {
          throw new Error(`${entryPath}.${key} is a forbidden secret field.`);
        }
        scan(children[key], `${entryPath}.${key}`);
      }
    }
  };
  scan(parsed, receiptPath);
};

export const createExactImageProvenance = (input: ExactProvenanceInput): ImageProvenance => {
  exactSha(input.expectedBuilderCommit, sha40, "Expected Builder commit");
  exactSha(input.expectedBuilderTree, sha40, "Expected Builder tree");
  exactSha(input.expectedDockerfileSha256, sha256, "Expected Dockerfile digest");
  assertCleanStatus(input.builderStatus, "Builder checkout");
  assertCleanStatus(input.builderIgnored, "Builder ignored-file inventory");
  assertCleanStatus(input.arrustedStatus, "Arrusted checkout");
  assertCleanStatus(input.arrustedIgnored, "Arrusted ignored-file inventory");
  if (input.observedBuilderCommit !== input.expectedBuilderCommit) {
    throw new Error("Builder commit changed after approval.");
  }
  if (input.observedBuilderTree !== input.expectedBuilderTree) {
    throw new Error("Builder tree changed after approval.");
  }
  if (input.observedArrustedCommit !== ARRUSTED_IMAGE_TARGET_SHA) {
    throw new Error("Arrusted commit does not match the immutable image target.");
  }
  if (input.observedArrustedTree !== ARRUSTED_IMAGE_TARGET_TREE) {
    throw new Error("Arrusted tree does not match the immutable image target.");
  }
  if (input.dockerfileSha256 !== input.expectedDockerfileSha256) {
    throw new Error("Dockerfile digest changed after approval.");
  }
  const targetFileEntries = Object.entries(input.targetFiles).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  if (
    targetFileEntries.length !== 10 ||
    targetFileEntries.some(([, digest]) => !sha256.test(digest))
  ) {
    throw new Error("The exact target-file digest set is incomplete.");
  }
  const tag = `${IMAGE_REPOSITORY}:dockerfile-${input.dockerfileSha256.slice(0, 12)}-arrusted-${ARRUSTED_IMAGE_TARGET_SHA.slice(0, 8)}-arm64-v2`;
  const unsigned = {
    arrusted: {
      commit: ARRUSTED_IMAGE_TARGET_SHA,
      root: input.arrustedRoot,
      tree: ARRUSTED_IMAGE_TARGET_TREE,
    },
    builder: {
      commit: input.observedBuilderCommit,
      root: input.builderRoot,
      stateRoot: input.stateRoot,
      tree: input.observedBuilderTree,
    },
    dockerfile: {
      path: "containers/eve-sandbox/Dockerfile" as const,
      sha256: input.dockerfileSha256,
    },
    image: {
      platform: IMAGE_PLATFORM,
      repository: IMAGE_REPOSITORY,
      revision: input.observedBuilderCommit,
      tag,
      version: IMAGE_VERSION,
    },
    targetFiles: Object.fromEntries(targetFileEntries),
    version: 1 as const,
  } as const;
  const provenance = { ...unsigned, digest: hash(canonical(unsigned)) };
  assertNoSecretMaterial(provenance);
  return provenance;
};

export const imageBuildCommand = (
  provenance: ImageProvenance,
  sanitizedTargetRoot: string,
): CommandSpec => {
  assertCanonicalRoot(sanitizedTargetRoot, sanitizedTargetRoot, "Sanitized Arrusted build context");
  return {
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
    program: "docker-buildx",
  };
};

export const localImageInspectionCommand = (provenance: ImageProvenance): CommandSpec => ({
  args: ["image", "inspect", "--platform", IMAGE_PLATFORM, provenance.image.tag],
  program: "docker",
});

export const imagePushCommand = (provenance: ImageProvenance): CommandSpec => ({
  args: ["push", provenance.image.tag],
  program: "docker",
});

export const assertGhcrUsername = (username: string): void => {
  if (!/^[A-Za-z0-9-]{1,39}$/u.test(username)) {
    throw new Error("GHCR username is malformed.");
  }
};

export const exactDigestReference = (reference: string): string => {
  if (!digestReference.test(reference)) {
    throw new Error("The image reference must be the fixed GHCR repository at an exact digest.");
  }
  return reference;
};

export const remoteIndexCommand = (reference: string): CommandSpec => ({
  args: ["imagetools", "inspect", "--raw", exactDigestReference(reference)],
  program: "docker-buildx",
});

export const remoteDescriptorCommand = (provenance: ImageProvenance): CommandSpec => ({
  args: ["imagetools", "inspect", provenance.image.tag, "--format", "{{json .Manifest}}"],
  program: "docker-buildx",
});

export const remoteManifestCommand = (reference: string): CommandSpec => ({
  args: ["imagetools", "inspect", "--raw", exactDigestReference(reference)],
  program: "docker-buildx",
});

export const remoteImageCommand = (reference: string): CommandSpec => ({
  args: ["imagetools", "inspect", exactDigestReference(reference), "--format", "{{json .Image}}"],
  program: "docker-buildx",
});

export const imagePreloadCommand = (reference: string): CommandSpec => ({
  args: ["pull", exactDigestReference(reference), "--materialize", "all"],
  program: "msb",
});

export const prepareProofRuntimeCommand = (): CommandSpec => ({
  args: ["install", "--force", "--frozen-lockfile", "--ignore-scripts"],
  program: "pnpm",
});

export const inspectProofRuntimeCommand = (): CommandSpec => ({
  args: ["list", "--depth", "Infinity", "--json"],
  program: "pnpm",
});

export const sandboxProofCommand = (reference: string, sourceRoot: string): CommandSpec => ({
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
  launcher: "trusted-node",
  program: "node",
});

const stringRecordSchema = z.record(z.string(), z.string());
const imageInspectSchema = z
  .object({
    Architecture: z.string().optional(),
    Config: z.object({ Labels: stringRecordSchema.optional() }).optional(),
    Descriptor: z
      .object({
        digest: z.string().optional(),
        mediaType: z.string().optional(),
        platform: z
          .object({ architecture: z.string().optional(), os: z.string().optional() })
          .optional(),
        size: z.number().optional(),
      })
      .optional(),
    Id: z.string().optional(),
    Os: z.string().optional(),
    RepoTags: z.array(z.string()).optional(),
    RootFS: z.object({ Layers: z.array(z.string()).optional() }).optional(),
  })
  .loose();
type ImageInspect = z.infer<typeof imageInspectSchema>;

const hasExactKeys = <Value extends object>(
  value: Value,
  expected: readonly string[] & readonly (keyof Value | string)[],
): boolean => {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

type Digest = `sha256:${string}`;
const isExactDigest = (value: string | undefined): value is Digest =>
  value !== undefined && sha256Digest.test(value);
const isDigest = (value: string): value is Digest => sha256Digest.test(value);
const isPositiveSize = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0;
const isExactLocalDescriptor = (
  descriptor: ImageInspect["Descriptor"],
  imageId: string,
): boolean => {
  if (descriptor === undefined) {
    return false;
  }
  if (!hasExactKeys(descriptor, ["digest", "mediaType", "platform", "size"])) {
    return false;
  }
  if (descriptor.digest !== imageId || descriptor.mediaType !== ociManifestMediaType) {
    return false;
  }
  if (!isPositiveSize(descriptor.size) || descriptor.platform === undefined) {
    return false;
  }
  return (
    JSON.stringify(descriptor.platform) ===
    JSON.stringify({ architecture: IMAGE_ARCHITECTURE, os: IMAGE_OS })
  );
};

type LocalImageInspection = Readonly<{
  platform: typeof IMAGE_PLATFORM;
  tag: string;
  revision: string;
  imageId: string;
  rootFsLayers: readonly string[];
}>;

export const parseLocalImageInspection = (
  raw: string,
  provenance: ImageProvenance,
): LocalImageInspection => {
  const parsed = z.array(imageInspectSchema).parse(JSON.parse(raw));
  if (parsed.length !== 1) {
    throw new Error("Local image inspection returned an unexpected image set.");
  }
  const [image] = parsed;
  if (image.Os !== IMAGE_OS || image.Architecture !== IMAGE_ARCHITECTURE) {
    throw new Error("Local image platform does not match linux/arm64.");
  }
  if (!Array.isArray(image.RepoTags) || !image.RepoTags.includes(provenance.image.tag)) {
    throw new Error("Local image tag does not match the approved provenance.");
  }
  const labels = image.Config?.Labels;
  if (
    labels?.["org.opencontainers.image.revision"] !== provenance.builder.commit ||
    labels?.["org.opencontainers.image.version"] !== IMAGE_VERSION
  ) {
    throw new Error("Local image OCI provenance labels do not match.");
  }
  if (!isExactDigest(image.Id)) {
    throw new Error("Local image inspection did not return an exact image ID.");
  }
  const descriptor = image.Descriptor;
  if (!isExactLocalDescriptor(descriptor, image.Id)) {
    throw new Error("Local image descriptor does not match the exact platform manifest.");
  }
  const rootFsLayers = image.RootFS?.Layers;
  if (
    !Array.isArray(rootFsLayers) ||
    rootFsLayers.length === 0 ||
    rootFsLayers.some((layer) => !isDigest(layer))
  ) {
    throw new Error("Local image inspection did not return exact rootfs layers.");
  }
  return {
    imageId: image.Id,
    platform: IMAGE_PLATFORM,
    revision: provenance.builder.commit,
    rootFsLayers,
    tag: provenance.image.tag,
  };
};

const ociIndexMediaType = "application/vnd.oci.image.index.v1+json";
const ociConfigMediaType = "application/vnd.oci.image.config.v1+json";
const ociLayerMediaType = "application/vnd.oci.image.layer.v1.tar+gzip";

const remotePlatformSchema = z.looseObject({
  architecture: z.string().optional(),
  os: z.string().optional(),
});
const remoteDescriptorSchema = z.looseObject({
  annotations: stringRecordSchema.optional(),
  digest: z.string().optional(),
  mediaType: z.string().optional(),
  platform: remotePlatformSchema.optional(),
  size: z.number().optional(),
});
const remoteIndexSchema = z.looseObject({
  digest: z.string().optional(),
  manifests: z.array(remoteDescriptorSchema).optional(),
  mediaType: z.string().optional(),
  schemaVersion: z.number().optional(),
  size: z.number().optional(),
});
const remoteManifestDescriptorSchema = z.looseObject({
  digest: z.string().optional(),
  mediaType: z.string().optional(),
  size: z.number().optional(),
});
const remoteManifestSchema = z.looseObject({
  config: remoteManifestDescriptorSchema.optional(),
  layers: z.array(remoteManifestDescriptorSchema).optional(),
  mediaType: z.string().optional(),
  schemaVersion: z.number().optional(),
});
const remoteImageSchema = z.looseObject({
  architecture: z.string().optional(),
  config: z.object({ Labels: stringRecordSchema.optional() }).optional(),
  os: z.string().optional(),
  rootfs: z.object({ diff_ids: z.array(z.string()).optional() }).optional(),
});
type RemoteIndex = z.infer<typeof remoteIndexSchema>;
type RemoteManifest = z.infer<typeof remoteManifestSchema>;
type RemoteManifestDescriptor = NonNullable<RemoteManifest["layers"]>[number];
type RemoteIndexDescriptor = NonNullable<RemoteIndex["manifests"]>[number];

const isExactIndexDescriptor = (descriptor: RemoteIndex): boolean => {
  if (!hasExactKeys(descriptor, ["digest", "manifests", "mediaType", "schemaVersion", "size"])) {
    return false;
  }
  return (
    descriptor.schemaVersion === 2 &&
    descriptor.mediaType === ociIndexMediaType &&
    isPositiveSize(descriptor.size) &&
    Array.isArray(descriptor.manifests)
  );
};

const isPlatformPlatform = (entry: RemoteIndexDescriptor): boolean =>
  entry.platform?.os === IMAGE_OS && entry.platform.architecture === IMAGE_ARCHITECTURE;

const isAttestationPlatform = (entry: RemoteIndexDescriptor): boolean =>
  entry.platform?.os === "unknown" && entry.platform.architecture === "unknown";

const isExactLayerDescriptor = (layer: RemoteManifestDescriptor): boolean =>
  layer.mediaType === ociLayerMediaType &&
  isExactDigest(layer.digest) &&
  isPositiveSize(layer.size);

export type RemoteIndexSelection = Readonly<{
  indexDigest: string;
  indexReference: string;
  platformManifestDigest: string;
  platformManifestSize: number;
  platformReference: string;
  attestationManifestDigest: string;
}>;

type RemoteIndexDescriptorResult = Readonly<{ indexDigest: string; indexReference: string }>;
type RemoteImageInspectionResult = Readonly<{
  digest: string;
  reference: string;
  indexDigest: string;
  indexReference: string;
  platform: typeof IMAGE_PLATFORM;
  platformManifestDigest: string;
  platformReference: string;
  attestationManifestDigest: string;
  attestationPolicy: "descriptor-bound-not-trusted";
  revision: string;
}>;

export const parseRemoteIndexDescriptor = (descriptorRaw: string): RemoteIndexDescriptorResult => {
  const descriptor = remoteIndexSchema.parse(JSON.parse(descriptorRaw));
  if (!isExactDigest(descriptor.digest)) {
    throw new Error("Remote registry inspection did not return an exact manifest digest.");
  }
  if (!isExactIndexDescriptor(descriptor)) {
    throw new Error("Remote registry did not return the exact OCI image index descriptor.");
  }
  return {
    indexDigest: descriptor.digest,
    indexReference: exactDigestReference(`${IMAGE_REPOSITORY}@${descriptor.digest}`),
  };
};

const isExactRemoteIndexPair = (
  descriptor: RemoteIndex,
  index: RemoteIndex,
  indexRaw: string,
): boolean => {
  if (!isExactIndexDescriptor(descriptor)) {
    return false;
  }
  if (descriptor.size !== Buffer.byteLength(indexRaw)) {
    return false;
  }
  if (!hasExactKeys(index, ["manifests", "mediaType", "schemaVersion"])) {
    return false;
  }
  if (index.schemaVersion !== 2 || index.mediaType !== ociIndexMediaType) {
    return false;
  }
  if (!Array.isArray(index.manifests)) {
    return false;
  }
  return JSON.stringify(descriptor.manifests) === JSON.stringify(index.manifests);
};

const isPlatformDescriptor = (entry: RemoteIndexDescriptor, localImageId: Digest): boolean => {
  if (!hasExactKeys(entry, ["digest", "mediaType", "platform", "size"])) {
    return false;
  }
  if (entry.platform === undefined || !hasExactKeys(entry.platform, ["architecture", "os"])) {
    return false;
  }
  return (
    entry.mediaType === ociManifestMediaType &&
    entry.digest === localImageId &&
    isPositiveSize(entry.size)
  );
};

const isAttestationDescriptor = (
  entry: RemoteIndexDescriptor,
  platformEntry: RemoteIndexDescriptor,
): entry is RemoteIndexDescriptor & { digest: Digest; annotations: Record<string, string> } => {
  if (!hasExactKeys(entry, ["annotations", "digest", "mediaType", "platform", "size"])) {
    return false;
  }
  if (entry.platform === undefined || !hasExactKeys(entry.platform, ["architecture", "os"])) {
    return false;
  }
  if (entry.annotations === undefined) {
    return false;
  }
  if (
    !hasExactKeys(entry.annotations, ["vnd.docker.reference.digest", "vnd.docker.reference.type"])
  ) {
    return false;
  }
  return (
    entry.mediaType === ociManifestMediaType &&
    isExactDigest(entry.digest) &&
    entry.digest !== platformEntry.digest &&
    isPositiveSize(entry.size) &&
    entry.annotations["vnd.docker.reference.digest"] === platformEntry.digest &&
    entry.annotations["vnd.docker.reference.type"] === "attestation-manifest"
  );
};

const isExactManifestDescriptor = (
  manifest: RemoteManifest,
  raw: string,
  selection: RemoteIndexSelection,
): boolean => {
  const { config, layers } = manifest;
  if (!hasExactKeys(manifest, ["config", "layers", "mediaType", "schemaVersion"])) {
    return false;
  }
  if (manifest.schemaVersion !== 2 || manifest.mediaType !== ociManifestMediaType) {
    return false;
  }
  if (selection.platformManifestSize !== Buffer.byteLength(raw)) {
    return false;
  }
  if (config === undefined || !hasExactKeys(config, ["digest", "mediaType", "size"])) {
    return false;
  }
  if (config.mediaType !== ociConfigMediaType || !isExactDigest(config.digest)) {
    return false;
  }
  if (!isPositiveSize(config.size) || !Array.isArray(layers) || layers.length === 0) {
    return false;
  }
  return layers.every(isExactLayerDescriptor);
};

const assertLocalImageBinding = (
  local: Readonly<{ imageId: string; rootFsLayers: readonly string[] }>,
  selection: RemoteIndexSelection,
): asserts local is Readonly<{ imageId: Digest; rootFsLayers: readonly string[] }> => {
  const imageIdIsExact = isExactDigest(local.imageId);
  const imageMatchesSelection = selection.platformManifestDigest === local.imageId;
  const referenceMatchesImage =
    selection.platformReference === exactDigestReference(`${IMAGE_REPOSITORY}@${local.imageId}`);
  const layersAreExact =
    local.rootFsLayers.length > 0 &&
    local.rootFsLayers.every((digest) => sha256Digest.test(digest));
  if (!imageIdIsExact || !imageMatchesSelection || !referenceMatchesImage || !layersAreExact) {
    throw new Error("Remote platform selection is not bound to the local image identity.");
  }
};

const assertOciContentDigest = (raw: string, expectedDigest: string, label: string): void => {
  if (raw.length === 0 || raw.endsWith("\n") || raw.endsWith("\r")) {
    throw new Error(`${label} did not return exact unframed OCI JSON bytes.`);
  }
  if (`sha256:${hash(raw)}` !== expectedDigest) {
    throw new Error(`${label} bytes do not match the declared digest.`);
  }
};

export const parseRemoteIndexInspection = (
  descriptorRaw: string,
  indexRaw: string,
  localImageId: string,
): RemoteIndexSelection => {
  if (!isExactDigest(localImageId)) {
    throw new Error("Local image identity is not an exact digest.");
  }
  const descriptor = remoteIndexSchema.parse(JSON.parse(descriptorRaw));
  const index = remoteIndexSchema.parse(JSON.parse(indexRaw));
  if (!isExactDigest(descriptor.digest)) {
    throw new Error("Remote registry inspection did not return an exact manifest digest.");
  }
  if (!isExactRemoteIndexPair(descriptor, index, indexRaw)) {
    throw new Error("Remote registry did not return the exact OCI image index.");
  }
  assertOciContentDigest(indexRaw, descriptor.digest, "Remote OCI image index");
  const entries = index.manifests;
  if (entries.length !== 2) {
    throw new Error("Remote OCI image index has an unexpected descriptor set.");
  }
  const platformEntry = entries.find(isPlatformPlatform);
  const attestationEntry = entries.find(isAttestationPlatform);
  if (platformEntry === undefined) {
    throw new Error("Remote platform manifest does not match the inspected local image.");
  }
  if (!isPlatformDescriptor(platformEntry, localImageId)) {
    throw new Error("Remote platform manifest does not match the inspected local image.");
  }
  if (attestationEntry === undefined) {
    throw new Error("Remote attestation manifest is not exactly bound to the platform image.");
  }
  if (!isAttestationDescriptor(attestationEntry, platformEntry)) {
    throw new Error("Remote attestation manifest is not exactly bound to the platform image.");
  }
  const indexReference = exactDigestReference(`${IMAGE_REPOSITORY}@${descriptor.digest}`);
  const platformReference = exactDigestReference(`${IMAGE_REPOSITORY}@${platformEntry.digest}`);
  return {
    attestationManifestDigest: attestationEntry.digest,
    indexDigest: descriptor.digest,
    indexReference,
    platformManifestDigest: platformEntry.digest,
    platformManifestSize: platformEntry.size,
    platformReference,
  };
};

export const parseRemoteImageInspection = (
  manifestRaw: string,
  imageRaw: string,
  provenance: ImageProvenance,
  local: Readonly<{ imageId: string; rootFsLayers: readonly string[] }>,
  selection: RemoteIndexSelection,
): RemoteImageInspectionResult => {
  assertLocalImageBinding(local, selection);
  const manifest = remoteManifestSchema.parse(JSON.parse(manifestRaw));
  const image = remoteImageSchema.parse(JSON.parse(imageRaw));
  if (!isExactManifestDescriptor(manifest, manifestRaw, selection)) {
    throw new Error("Remote platform reference did not return the exact OCI image manifest.");
  }
  assertOciContentDigest(
    manifestRaw,
    selection.platformManifestDigest,
    "Remote OCI platform manifest",
  );
  if (image.os !== IMAGE_OS || image.architecture !== IMAGE_ARCHITECTURE) {
    throw new Error("Remote image platform does not match linux/arm64.");
  }
  const labels = image.config?.Labels;
  if (
    labels?.["org.opencontainers.image.revision"] !== provenance.builder.commit ||
    labels?.["org.opencontainers.image.version"] !== IMAGE_VERSION
  ) {
    throw new Error("Remote image OCI provenance labels do not match.");
  }
  const remoteDiffIds = image.rootfs?.diff_ids;
  if (
    remoteDiffIds === undefined ||
    remoteDiffIds.length !== local.rootFsLayers.length ||
    remoteDiffIds.some((digest, index) => digest !== local.rootFsLayers[index])
  ) {
    throw new Error("Remote image rootfs identity does not match the inspected local image.");
  }
  return {
    attestationManifestDigest: selection.attestationManifestDigest,
    attestationPolicy: "descriptor-bound-not-trusted",
    digest: selection.platformManifestDigest,
    indexDigest: selection.indexDigest,
    indexReference: selection.indexReference,
    platform: IMAGE_PLATFORM,
    platformManifestDigest: selection.platformManifestDigest,
    platformReference: selection.platformReference,
    reference: selection.platformReference,
    revision: provenance.builder.commit,
  };
};

export const hashArtifact = (content: string | Uint8Array): string => hash(content);
