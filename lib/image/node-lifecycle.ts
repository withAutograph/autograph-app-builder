import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { arch, homedir, platform } from "node:os";
import nodePath from "node:path";
import { z } from "zod";

import {
  ARRUSTED_IMAGE_TARGET_SHA,
  ARRUSTED_IMAGE_TARGET_TREE,
  assertCanonicalRoot,
  assertExactImageToolVersion,
  assertGhcrUsername,
  assertNoSecretMaterial,
  assertProofRuntimeIgnoredInventory,
  assertStandaloneGitMetadata,
  createExactImageProvenance,
  exactDigestReference,
  hashArtifact,
  imageBuildCommand,
  imagePreloadCommand,
  imagePushCommand,
  imageToolVersionCommand,
  inspectProofRuntimeCommand,
  localImageInspectionCommand,
  parseLocalImageInspection,
  parseRemoteIndexDescriptor,
  parseRemoteIndexInspection,
  parseRemoteImageInspection,
  prepareProofRuntimeCommand,
  remoteDescriptorCommand,
  remoteImageCommand,
  remoteIndexCommand,
  remoteManifestCommand,
  sandboxProofCommand,
} from "./lifecycle.ts";
import type { CommandSpec, ImageProvenance, ImageTool } from "./lifecycle.ts";
import {
  assertGithubStateRoot,
  assertVerifiedGhcrLoginPayload,
  githubConfigDigest,
  githubStateDigest,
  ghcrIdentityDigest,
  readBoundedInput,
} from "./ghcr-bound-helper.ts";
import { hasTestCapability } from "../testing/test-capability.ts";
import { materializeSanitizedGitTree } from "./sanitized-git-tree.ts";
import type { SanitizedGitTree } from "./sanitized-git-tree.ts";

export { materializeSanitizedGitTree } from "./sanitized-git-tree.ts";

const { dirname, isAbsolute, join, relative, resolve: pathResolve, sep } = nodePath;
const dockerfilePath = "containers/eve-sandbox/Dockerfile" as const;
const maximumCommandOutputBytes = 4 * 1024 * 1024;
const receiptFileNames = {
  build: "build-receipt.json",
  ghcrLogin: "ghcr-login-receipt.json",
  localImage: "local-image-receipt.json",
  preload: "preload-receipt.json",
  proofRuntime: "proof-runtime-receipt.json",
  push: "push-receipt.json",
  remoteImage: "remote-image-receipt.json",
  sandboxProof: "sandbox-proof-receipt.json",
  source: "source-receipt.json",
} as const;
const receiptKindNames = {
  build: "image-build",
  ghcrLogin: "ghcr-login",
  localImage: "local-image",
  preload: "image-preload",
  proofRuntime: "proof-runtime",
  push: "image-push",
  remoteImage: "remote-image",
  sandboxProof: "sandbox-proof",
  source: "image-source",
} as const;
const receiptKinds = new Map<string, string>([
  [receiptFileNames.build, receiptKindNames.build],
  [receiptFileNames.ghcrLogin, receiptKindNames.ghcrLogin],
  [receiptFileNames.localImage, receiptKindNames.localImage],
  [receiptFileNames.preload, receiptKindNames.preload],
  [receiptFileNames.proofRuntime, receiptKindNames.proofRuntime],
  [receiptFileNames.push, receiptKindNames.push],
  [receiptFileNames.remoteImage, receiptKindNames.remoteImage],
  [receiptFileNames.sandboxProof, receiptKindNames.sandboxProof],
  [receiptFileNames.source, receiptKindNames.source],
]);
const unsafeReceiptMessage = "Image lifecycle state contains an unknown or unsafe artifact.";
const stateRootLabel = "Image lifecycle state root";
const builderRootLabel = "Builder root";
const arrustedRootLabel = "Arrusted root";
const proofRuntimeStatusFlag = "--porcelain=v1";

const targetArguments = {
  APP_IDENTITY_SHA256: ".config/mise/scripts/repository/app-identity.ts",
  APP_TEMPLATE_PACKAGE_SHA256: ".config/turbo/generators/templates/app/package.json.hbs",
  APP_VALIDATION_SHA256: ".config/mise/scripts/repository/app-validation.ts",
  BUN_LOCK_SHA256: "bun.lock",
  CARGO_LOCK_SHA256: "Cargo.lock",
  CREATE_APP_SHA256: ".config/turbo/generators/create-app.ts",
  MISE_CONFIG_SHA256: ".config/mise/config.toml",
  MISE_LOCK_SHA256: ".config/mise/mise.lock",
  REPOSITORY_EXEC_SHA256: ".config/mise/tasks/repository/exec",
  REPOSITORY_PREFLIGHT_SHA256: ".config/mise/scripts/repository/repository-preflight.ts",
} as const;

export type LifecycleApproval = Readonly<{
  arrustedRoot: string;
  stateRoot: string;
  builderCommit: string;
  builderTree: string;
  dockerfileSha256: string;
}>;

type ReceiptEnvelope = Readonly<{
  version: 1;
  kind: string;
  provenance: ImageProvenance;
  result: ReceiptResult;
  digest: string;
}>;
type ReceiptResult = Readonly<object>;
type CurrentGhcrLogin = Readonly<{
  receipt: ReceiptEnvelope;
  binding: GhcrCredentialBinding;
  identity: Readonly<{
    username: string;
    digest: string;
    provenanceDigest: string;
    stateDigest: string;
  }>;
}>;
type ObservedProofRuntime = Readonly<{ provenance: ImageProvenance; result: ProofRuntimeResult }>;
type CurrentProofRuntime = Readonly<{ provenance: ImageProvenance; receipt: ReceiptEnvelope }>;

const injectedImageProvenance = new AsyncLocalStorage<ImageProvenance>();
const receiptEnvelopeSchema = z.object({
  digest: z.string(),
  kind: z.string(),
  provenance: z.custom<ImageProvenance>(),
  result: z.looseObject({}),
  version: z.literal(1),
});
const localImageIdentitySchema = z.object({
  imageId: z.string(),
  rootFsLayers: z.array(z.string()),
});
const pushBindingSchema = z.object({
  ghcrLoginReceiptDigest: z.string(),
  localImageReceiptDigest: z.string(),
});
const referenceReceiptSchema = z.object({ reference: z.string() });
const sandboxProofReceiptSchema = z.object({
  proofRuntimeReceiptDigest: z.string(),
  reference: z.string(),
});
const ghcrLoginResultSchema = z.object({
  authenticationBoundary: z.unknown(),
  authenticationBoundaryDigest: z.string(),
  authenticationProvider: z.string(),
  identityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  keyringReadbackTransport: z.literal("github-cli-keyring"),
  operatorApprovalTransport: z.literal("one-time-stdin"),
  provenanceDigest: z.string(),
  providerMutation: z.literal("none"),
  registry: z.literal("ghcr.io"),
  schema: z.literal("ghcr-login-v3"),
  status: z.literal("credential-matched"),
  username: z.string(),
});

export const withImageLifecycleTestProvenance = function withImageLifecycleTestProvenance<T>(
  provenance: ImageProvenance,
  operation: () => T,
): T {
  if (!hasTestCapability("simulated-target")) {
    throw new Error("Image lifecycle provenance injection requires structural test authority.");
  }
  return injectedImageProvenance.run(provenance, operation);
};

const fixedGit = "/usr/bin/git";
const githubCliVersion = "2.98.0";
const ghcrDockerConfigName = "config.json";
const ghcrBoundHelperName = "docker-credential-ghcr-bound";
const githubStateRootName = "github-cli-state";
const ghcrDockerConfigBytes = Buffer.from('{"credHelpers":{"ghcr.io":"ghcr-bound"}}\n', "utf-8");
const ghcrBoundHelperBytes = Buffer.from(
  '#!/bin/sh\nexec "$APP_BUILDER_IMAGE_NODE_BIN" --experimental-strip-types "$APP_BUILDER_IMAGE_GHCR_BOUND_HELPER_MODULE" "$@"\n',
  "utf-8",
);

const ghcrDockerConfigPath = function ghcrDockerConfigPath(stateRoot: string): string {
  return join(stateRoot, ghcrDockerConfigName);
};

const ghcrBoundHelperPath = function ghcrBoundHelperPath(stateRoot: string): string {
  return join(stateRoot, ghcrBoundHelperName);
};

type GhcrCredentialBinding = Readonly<{
  version: 3;
  platform: string;
  provider: Readonly<{
    name: "gh";
    version: "2.98.0";
    sha256: string;
    configDigest: string;
    authenticationSource: "keyring";
    protocol: "operator-stdin-keyring-readback-v2";
    statusCommand: readonly string[];
    keyringReadCommand: readonly string[];
    userCommand: readonly string[];
    membershipCommand: readonly string[];
  }>;
  consumers: Readonly<{ dockerSha256: string; buildxSha256: string }>;
  dockerConfig: Readonly<{
    sha256: string;
    providerName: "ghcr-bound";
  }>;
  state: Readonly<{
    environment: "XDG_STATE_HOME";
    relativePath: "github-cli-state";
    policy: "owned-0700-closed-gh-device-id-v1";
    digest: string;
  }>;
  verifier: Readonly<{
    wrapperSha256: string;
    moduleSha256: string;
    nodeSha256: string;
  }>;
}>;

const sanitizedEnvironment = (extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => ({
  HOME: homedir(),
  LANG: "C",
  NODE_ENV: "production",
  PATH: "/usr/bin:/bin",
  ...extra,
});

const git = (root: string, args: readonly string[]) =>
  execFileSync(fixedGit, ["-C", root, ...args], {
    encoding: "utf-8",
    env: sanitizedEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

const ensureNoLinkPath = function ensureNoLinkPath(path: string, label: string): void {
  const canonical = pathResolve(path);
  assertCanonicalRoot(canonical, realpathSync(canonical), label);
  const root = pathResolve(canonical, "/") === canonical ? canonical : undefined;
  if (root !== undefined) {
    throw new Error(`${label} cannot be the filesystem root.`);
  }
  let cursor = canonical;
  for (;;) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link.`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
};

const assertAbsoluteInput = function assertAbsoluteInput(path: string, label: string): void {
  if (!isAbsolute(path) || pathResolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
};

const containsPath = function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const lifecycleLockPort = function lifecycleLockPort(stateRoot: string, attempt = 0): number {
  const value = createHash("sha256").update(stateRoot).digest().readUInt16BE(0);
  return 32_768 + ((value + attempt) % 24_000);
};

const portIsOurLock = async function portIsOurLock(
  port: number,
  identity: string,
): Promise<boolean> {
  const socket = createConnection({ host: "127.0.0.1", port });
  let data = "";
  socket.setEncoding("utf-8");
  socket.setTimeout(100);
  socket.on("data", (chunk) => {
    data += chunk.toString();
  });
  socket.once("timeout", () => {
    socket.destroy();
  });
  try {
    await once(socket, "close");
    return data === identity;
  } catch {
    return false;
  }
};

export const withLifecycleLock = async function withLifecycleLock<T>(
  stateRoot: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  assertAbsoluteInput(stateRoot, stateRootLabel);
  const identity = createHash("sha256").update(stateRoot).digest("hex");
  const server = createServer((socket) => {
    socket.end(identity);
  });
  const acquire = async (attempt: number): Promise<void> => {
    const port = lifecycleLockPort(stateRoot, attempt);
    const listening = once(server, "listening");
    server.listen({ exclusive: true, host: "127.0.0.1", port });
    let acquired = true;
    try {
      await listening;
    } catch (error: unknown) {
      const listenError = error instanceof Error ? error : new Error(String(error));
      if (listenError.code !== "EADDRINUSE") throw error;
      acquired = false;
    }
    if (acquired) {
      return;
    }
    const lockOwner = await portIsOurLock(port, identity);
    if (lockOwner) {
      throw new Error(
        "Another image lifecycle operation holds the exclusive external-operation lock.",
      );
    }
    await acquire(attempt + 1);
  };
  await acquire(0);
  server.unref();
  try {
    return await operation();
  } finally {
    server.close();
    await once(server, "close");
  }
};

export const normalizedNodeModulesDigest = function normalizedNodeModulesDigest(
  nodeModulesRoot: string,
): string {
  const records: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).toSorted()) {
      const absolute = join(directory, name);
      const relativePath = relative(nodeModulesRoot, absolute);
      const stat = lstatSync(absolute);
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (isAbsolute(target)) {
          throw new Error(`Proof runtime symlink ${relativePath} has an absolute target.`);
        }
        const resolvedTarget = pathResolve(dirname(absolute), target);
        if (!containsPath(nodeModulesRoot, resolvedTarget)) {
          throw new Error(`Proof runtime symlink ${relativePath} escapes node_modules.`);
        }
        const canonicalTarget = realpathSync(absolute);
        if (!containsPath(nodeModulesRoot, canonicalTarget)) {
          throw new Error(`Proof runtime symlink ${relativePath} resolves outside node_modules.`);
        }
        records.push(`l\0${relativePath}\0${mode}\0${target}`);
      } else if (stat.isDirectory()) {
        records.push(`d\0${relativePath}\0${mode}`);
        walk(absolute);
      } else if (stat.isFile()) {
        records.push(
          `f\0${relativePath}\0${mode}\0${stat.size}\0${hashArtifact(readFileSync(absolute))}`,
        );
      } else {
        throw new Error(`Proof runtime contains unsupported entry ${relativePath}.`);
      }
    }
  };
  walk(nodeModulesRoot);
  return createHash("sha256").update(records.join("\n")).digest("hex");
};

const assertDisjointRoots = function assertDisjointRoots(
  stateRoot: string,
  repositoryRoot: string,
  label: string,
): void {
  if (containsPath(repositoryRoot, stateRoot) || containsPath(stateRoot, repositoryRoot)) {
    throw new Error(`${label} must be outside the image lifecycle state root.`);
  }
};

const assertOwnedPrivateDirectory = function assertOwnedPrivateDirectory(
  path: string,
  label: string,
): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must be a mode 0700 directory.`);
  }
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== uid) {
    throw new Error(`${label} must be owned by the current user.`);
  }
};

const assertLifecycleStateScope = function assertLifecycleStateScope(
  approval: LifecycleApproval,
): void {
  const builderRoot = process.cwd();
  assertAbsoluteInput(builderRoot, builderRootLabel);
  assertAbsoluteInput(approval.arrustedRoot, arrustedRootLabel);
  assertAbsoluteInput(approval.stateRoot, stateRootLabel);
  ensureNoLinkPath(builderRoot, builderRootLabel);
  ensureNoLinkPath(approval.arrustedRoot, arrustedRootLabel);
  if (existsSync(approval.stateRoot)) {
    ensureNoLinkPath(approval.stateRoot, stateRootLabel);
    assertOwnedPrivateDirectory(approval.stateRoot, stateRootLabel);
  } else {
    ensureNoLinkPath(dirname(approval.stateRoot), "Image lifecycle state parent");
  }
  assertDisjointRoots(approval.stateRoot, builderRoot, builderRootLabel);
  assertDisjointRoots(approval.stateRoot, approval.arrustedRoot, arrustedRootLabel);
};

const exactDockerArgument = function exactDockerArgument(dockerfile: string, name: string): string {
  const match = new RegExp(`^ARG ${name}=([^\\n]+)$`, "mu").exec(dockerfile);
  if (match?.[1] === undefined) {
    throw new Error(`Dockerfile is missing exact ${name}.`);
  }
  return match[1];
};

const temporaryReceiptPattern = new RegExp(
  `^(?:${Object.keys(receiptKinds)
    .map((name) => name.replaceAll(".", "[.]"))
    .join("|")})[.]tmp-[0-9]+-[0-9a-f-]{36}$`,
  "u",
);
const temporaryContextPattern = /^arrusted-context[.]tmp-[0-9]+-[0-9a-f-]{36}$/u;
const temporaryBuildxPattern = /^buildx-runtime[.]tmp-[0-9]+-[0-9a-f-]{36}$/u;

const assertOwnedNoLinkTree = function assertOwnedNoLinkTree(path: string, uid: number): void {
  const stat = lstatSync(path);
  const supportedType = stat.isDirectory() || stat.isFile();
  const safeFileLinks = !stat.isFile() || stat.nlink === 1;
  if (stat.isSymbolicLink() || stat.uid !== uid || !supportedType || !safeFileLinks) {
    throw new Error("Unsafe interrupted Buildx state requires review.");
  }
  if (!stat.isDirectory()) {
    return;
  }
  for (const entry of readdirSync(path)) {
    assertOwnedNoLinkTree(join(path, entry), uid);
  }
};

const removeBuildxRuntime = function removeBuildxRuntime(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error("Unsafe interrupted Buildx state requires review.");
  }
  assertOwnedNoLinkTree(path, uid);
  rmSync(path, { force: false, recursive: true });
};

export const reconcileLifecycleTemps = function reconcileLifecycleTemps(stateRoot: string): void {
  if (!existsSync(stateRoot)) {
    return;
  }
  ensureNoLinkPath(stateRoot, stateRootLabel);
  assertOwnedPrivateDirectory(stateRoot, stateRootLabel);
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Image lifecycle recovery requires a current user ID.");
  }
  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    const absolute = join(stateRoot, entry.name);
    const stat = lstatSync(absolute);
    if (temporaryReceiptPattern.test(entry.name)) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        stat.uid !== uid ||
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        (stat.mode & 0o777) !== 0o600
      ) {
        throw new Error("Unsafe interrupted receipt artifact requires review.");
      }
      unlinkSync(absolute);
    } else if (temporaryContextPattern.test(entry.name)) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        stat.uid !== uid ||
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        (stat.mode & 0o777) !== 0o700
      ) {
        throw new Error("Unsafe interrupted build context requires review.");
      }
      rmSync(absolute, { force: false, recursive: true });
    } else if (temporaryBuildxPattern.test(entry.name)) {
      removeBuildxRuntime(absolute, uid);
    }
  }
};

export const withBuildxRuntime = function withBuildxRuntime<T>(
  stateRoot: string,
  operation: (environment: Readonly<{ BUILDX_CONFIG: string }>) => T,
): T {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Buildx runtime isolation requires a current user ID.");
  }
  const runtime = join(stateRoot, `buildx-runtime.tmp-${process.pid}-${randomUUID()}`);
  mkdirSync(runtime, { mode: 0o700, recursive: false });
  try {
    return operation({ BUILDX_CONFIG: runtime });
  } finally {
    removeBuildxRuntime(runtime, uid);
  }
};

const writeExactFile = function writeExactFile(path: string, bytes: Buffer, mode: number): void {
  const descriptor = openSync(
    path,
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
};

const removeSanitizedGitTree = function removeSanitizedGitTree(context: SanitizedGitTree): void {
  if (!temporaryContextPattern.test(context.root.split(sep).at(-1) ?? "")) {
    throw new Error("Refusing to remove a non-lifecycle build context.");
  }
  const stat = lstatSync(context.root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing to remove an unsafe lifecycle build context.");
  }
  rmSync(context.root, { force: false, recursive: true });
};

const readReceipt = function readReceipt(
  stateRoot: string,
  filename: string,
  kind: string,
  provenance: ImageProvenance,
): ReceiptEnvelope {
  const path = join(stateRoot, filename);
  ensureNoLinkPath(path, `${kind} receipt`);
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  const validMode = (stat.mode & 0o777) === 0o600;
  const ownedByCurrentUser = uid !== undefined && stat.uid === uid;
  if (!stat.isFile() || stat.isSymbolicLink() || !validMode || !ownedByCurrentUser) {
    throw new Error(`${kind} receipt must be an owned mode 0600 regular file.`);
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const parsed = receiptEnvelopeSchema.parse(raw);
  const provenanceMatches = parsed.provenance.digest === provenance.digest;
  if (parsed.version !== 1 || parsed.kind !== kind || !provenanceMatches) {
    throw new Error(`${kind} receipt does not match exact provenance.`);
  }
  const { digest, ...unsigned } = parsed;
  if (digest !== hashArtifact(JSON.stringify(unsigned))) {
    throw new Error(`${kind} receipt digest is invalid.`);
  }
  assertNoSecretMaterial(parsed);
  return parsed;
};

const writeReceipt = function writeReceipt(
  stateRoot: string,
  filename: string,
  kind: string,
  provenance: ImageProvenance,
  result: ReceiptResult,
): ReceiptEnvelope {
  const unsigned = { kind, provenance, result, version: 1 as const };
  assertNoSecretMaterial(unsigned);
  const receipt = {
    ...unsigned,
    digest: hashArtifact(JSON.stringify(unsigned)),
  };
  const root = stateRoot;
  ensureNoLinkPath(root, "Image lifecycle artifact root");
  const path = join(root, filename);
  if (existsSync(path)) {
    const existing = readReceipt(stateRoot, filename, kind, provenance);
    if (existing.digest !== receipt.digest) {
      throw new Error(`${kind} already has a different exact receipt.`);
    }
    return existing;
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
    throw error;
  }
  return receipt;
};

const optionalReceipt = function optionalReceipt(
  stateRoot: string,
  filename: string,
  kind: string,
  provenance: ImageProvenance,
): ReceiptEnvelope | undefined {
  return existsSync(join(stateRoot, filename))
    ? readReceipt(stateRoot, filename, kind, provenance)
    : undefined;
};

const assertExactGhcrBoundHelper = function assertExactGhcrBoundHelper(stateRoot: string): void {
  const path = ghcrBoundHelperPath(stateRoot);
  ensureNoLinkPath(path, "GHCR bound helper");
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  const validMode = (stat.mode & 0o777) === 0o700;
  const ownedByCurrentUser = uid !== undefined && stat.uid === uid;
  if (!stat.isFile() || stat.isSymbolicLink() || !ownedByCurrentUser || !validMode) {
    throw new Error("GHCR bound helper must be an owned mode 0700 regular file.");
  }
  if (!readFileSync(path).equals(ghcrBoundHelperBytes)) {
    throw new Error("GHCR bound helper does not match the closed implementation.");
  }
};

const assertExactGhcrDockerConfig = function assertExactGhcrDockerConfig(stateRoot: string): void {
  const path = ghcrDockerConfigPath(stateRoot);
  ensureNoLinkPath(path, "GHCR Docker configuration");
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional permission bitmask.
  const validMode = (stat.mode & 0o777) === 0o600;
  const ownedByCurrentUser = uid !== undefined && stat.uid === uid;
  if (!stat.isFile() || stat.isSymbolicLink() || !ownedByCurrentUser || !validMode) {
    throw new Error("GHCR Docker configuration must be an owned mode 0600 regular file.");
  }
  if (!readFileSync(path).equals(ghcrDockerConfigBytes)) {
    throw new Error("GHCR Docker configuration does not match the closed schema.");
  }
};

const verifyStateRootContents = function verifyStateRootContents(
  provenance: ImageProvenance,
): void {
  const { stateRoot } = provenance.builder;
  for (const entry of readdirSync(stateRoot, {
    withFileTypes: true,
  })) {
    if (entry.name === ghcrDockerConfigName) {
      assertExactGhcrDockerConfig(stateRoot);
    } else if (entry.name === ghcrBoundHelperName) {
      assertExactGhcrBoundHelper(stateRoot);
    } else if (entry.name === githubStateRootName) {
      assertGithubStateRoot(join(stateRoot, githubStateRootName));
    } else {
      const kind = receiptKinds.get(entry.name);
      if (kind === undefined || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(unsafeReceiptMessage);
      }
      readReceipt(stateRoot, entry.name, kind, provenance);
    }
  }
};

export const observeImageProvenance = function observeImageProvenance(
  approval: LifecycleApproval,
  builderRootInput: string = process.cwd(),
  options: Readonly<{ allowProofRuntime?: boolean }> = {},
): ImageProvenance {
  const injected = injectedImageProvenance.getStore();
  if (injected !== undefined) {
    const approvalMatchesInjected = [
      approval.arrustedRoot === injected.arrusted.root,
      approval.stateRoot === injected.builder.stateRoot,
      approval.builderCommit === injected.builder.commit,
      approval.builderTree === injected.builder.tree,
      approval.dockerfileSha256 === injected.dockerfile.sha256,
    ].every(Boolean);
    if (!approvalMatchesInjected) {
      throw new Error("Injected image provenance does not match the lifecycle approval.");
    }
    return injected;
  }
  assertAbsoluteInput(builderRootInput, builderRootLabel);
  assertAbsoluteInput(approval.arrustedRoot, arrustedRootLabel);
  assertAbsoluteInput(approval.stateRoot, stateRootLabel);
  const builderRoot = pathResolve(builderRootInput);
  const arrustedRoot = pathResolve(approval.arrustedRoot);
  const stateRoot = pathResolve(approval.stateRoot);
  ensureNoLinkPath(builderRoot, builderRootLabel);
  ensureNoLinkPath(arrustedRoot, arrustedRootLabel);
  if (!existsSync(stateRoot)) {
    const parent = dirname(stateRoot);
    ensureNoLinkPath(parent, "Image lifecycle state parent");
    mkdirSync(stateRoot, { mode: 0o700, recursive: false });
  }
  ensureNoLinkPath(stateRoot, stateRootLabel);
  assertOwnedPrivateDirectory(stateRoot, stateRootLabel);
  assertDisjointRoots(stateRoot, builderRoot, builderRootLabel);
  assertDisjointRoots(stateRoot, arrustedRoot, arrustedRootLabel);
  const builderDotGit = join(builderRoot, ".git");
  ensureNoLinkPath(builderDotGit, "Builder Git metadata");
  assertStandaloneGitMetadata(lstatSync(builderDotGit).isDirectory(), "Builder");
  const dotGit = join(arrustedRoot, ".git");
  ensureNoLinkPath(dotGit, "Arrusted Git metadata");
  assertStandaloneGitMetadata(lstatSync(dotGit).isDirectory(), "Arrusted");
  const dockerfileAbsolute = join(builderRoot, dockerfilePath);
  ensureNoLinkPath(dockerfileAbsolute, "Sandbox Dockerfile");
  const dockerfile = readFileSync(dockerfileAbsolute, "utf-8");
  if (exactDockerArgument(dockerfile, "TARGET_SHA") !== ARRUSTED_IMAGE_TARGET_SHA) {
    throw new Error("Dockerfile target commit does not match lifecycle policy.");
  }
  if (exactDockerArgument(dockerfile, "TARGET_TREE") !== ARRUSTED_IMAGE_TARGET_TREE) {
    throw new Error("Dockerfile target tree does not match lifecycle policy.");
  }
  const targetFiles = Object.fromEntries(
    Object.entries(targetArguments).map(([argument, relativePath]) => {
      const absolute = join(arrustedRoot, relativePath);
      ensureNoLinkPath(absolute, `Arrusted target file ${relativePath}`);
      const digest = hashArtifact(readFileSync(absolute));
      if (exactDockerArgument(dockerfile, argument) !== digest) {
        throw new Error(`Arrusted target file ${relativePath} drifted.`);
      }
      return [relativePath, digest];
    }),
  );
  const builderIgnored = git(builderRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
  ]);
  if (options.allowProofRuntime === true) {
    const collapsedIgnored = git(builderRoot, [
      "status",
      proofRuntimeStatusFlag,
      "--ignored",
      "--untracked-files=normal",
    ]);
    assertProofRuntimeIgnoredInventory(collapsedIgnored);
    const nodeModules = join(builderRoot, "node_modules");
    ensureNoLinkPath(nodeModules, "Builder proof-runtime node_modules");
    const stat = lstatSync(nodeModules);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || uid === undefined || stat.uid !== uid) {
      throw new Error(
        "Builder proof-runtime node_modules must be a real current-user-owned directory.",
      );
    }
  }
  const provenance = createExactImageProvenance({
    arrustedIgnored: git(arrustedRoot, ["ls-files", "--others", "--ignored", "--exclude-standard"]),
    arrustedRoot,
    arrustedStatus: git(arrustedRoot, ["status", proofRuntimeStatusFlag, "--untracked-files=all"]),
    builderIgnored: options.allowProofRuntime === true ? "" : builderIgnored,
    builderRoot,
    builderStatus: git(builderRoot, ["status", proofRuntimeStatusFlag, "--untracked-files=all"]),
    dockerfileSha256: hashArtifact(dockerfile),
    expectedBuilderCommit: approval.builderCommit,
    expectedBuilderTree: approval.builderTree,
    expectedDockerfileSha256: approval.dockerfileSha256,
    observedArrustedCommit: git(arrustedRoot, ["rev-parse", "HEAD"]),
    observedArrustedTree: git(arrustedRoot, ["rev-parse", "HEAD^{tree}"]),
    observedBuilderCommit: git(builderRoot, ["rev-parse", "HEAD"]),
    observedBuilderTree: git(builderRoot, ["rev-parse", "HEAD^{tree}"]),
    stateRoot,
    targetFiles,
  });
  verifyStateRootContents(provenance);
  return provenance;
};

const toolEnvironmentKeys = {
  docker: "APP_BUILDER_IMAGE_DOCKER_BIN",
  "docker-buildx": "APP_BUILDER_IMAGE_BUILDX_BIN",
  msb: "APP_BUILDER_IMAGE_MSB_BIN",
  node: "APP_BUILDER_IMAGE_NODE_BIN",
  pnpm: "APP_BUILDER_IMAGE_PNPM_BIN",
} as const;

const exactGithubCli = function exactGithubCli(): string {
  const configured = process.env.APP_BUILDER_IMAGE_GH_BIN;
  if (configured === undefined || !isAbsolute(configured)) {
    throw new Error("GitHub CLI must be resolved by the owning mise task.");
  }
  const binary = realpathSync(configured);
  if (binary !== configured || binary.split(sep).at(-1) !== "gh") {
    throw new Error("GitHub CLI must use its canonical exact path.");
  }
  const stat = lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("GitHub CLI does not resolve to a regular file.");
  }
  const version = spawnSync(binary, ["version"], {
    encoding: "utf-8",
    env: sanitizedEnvironment(),
    maxBuffer: maximumCommandOutputBytes,
    timeout: 10_000,
  });
  if (
    version.error !== undefined ||
    version.status !== 0 ||
    !version.stdout.startsWith(`gh version ${githubCliVersion} `)
  ) {
    throw new Error("GitHub CLI version is unsupported.");
  }
  return binary;
};

const exactGithubConfigRoot = function exactGithubConfigRoot(): string {
  // The trusted launcher never forwards this internal override. It exists so
  // hermetic tests can bind an owner-only fixture without reading the runner's
  // real GitHub configuration.
  const configured = process.env.APP_BUILDER_GH_CONFIG_DIR;
  const root = realpathSync(configured ?? join(homedir(), ".config/gh"));
  ensureNoLinkPath(root, "GitHub configuration root");
  githubConfigDigest(root);
  return root;
};

const exactToolBinary = function exactToolBinary(program: ImageTool): string {
  const key = toolEnvironmentKeys[program];
  const configured = process.env[key];
  if (configured === undefined || !isAbsolute(configured)) {
    throw new Error(`${program} must be resolved by the owning mise task.`);
  }
  const binary = realpathSync(configured);
  const stat = lstatSync(binary);
  if (!stat.isFile()) {
    throw new Error(`${program} does not resolve to a regular file.`);
  }
  return binary;
};

export const imageToolInvocation = function imageToolInvocation(
  tool: ImageTool,
  args: readonly string[],
) {
  const binary = exactToolBinary(tool);
  if (tool !== "msb") {
    return { args, program: binary };
  }
  return {
    args: [binary, ...args],
    program: exactToolBinary("node"),
  };
};

const ensureGithubStateRoot = function ensureGithubStateRoot(stateRoot: string): string {
  const path = join(stateRoot, githubStateRootName);
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o700, recursive: false });
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    const directory = openSync(stateRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  assertGithubStateRoot(path);
  return path;
};

const ensureGhcrDockerConfig = function ensureGhcrDockerConfig(stateRoot: string): void {
  const path = ghcrDockerConfigPath(stateRoot);
  if (!existsSync(path)) {
    writeExactFile(path, ghcrDockerConfigBytes, 0o600);
  }
  assertExactGhcrDockerConfig(stateRoot);
};

const ensureGhcrBoundHelper = function ensureGhcrBoundHelper(stateRoot: string): void {
  const path = ghcrBoundHelperPath(stateRoot);
  if (!existsSync(path)) {
    writeExactFile(path, ghcrBoundHelperBytes, 0o700);
  }
  assertExactGhcrBoundHelper(stateRoot);
};

const exactGhcrBoundHelperModule = function exactGhcrBoundHelperModule(): string {
  const path = realpathSync(join(process.cwd(), "lib/image/ghcr-bound-helper.ts"));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("GHCR bound helper module is invalid.");
  }
  return path;
};

export const currentGhcrCredentialBinding = function currentGhcrCredentialBinding(
  stateRoot: string,
): GhcrCredentialBinding {
  ensureGhcrDockerConfig(stateRoot);
  ensureGhcrBoundHelper(stateRoot);
  ensureGithubStateRoot(stateRoot);
  const gh = exactGithubCli();
  const ghConfigRoot = exactGithubConfigRoot();
  const verifierModule = exactGhcrBoundHelperModule();
  const node = exactToolBinary("node");
  return {
    consumers: {
      buildxSha256: hashArtifact(readFileSync(exactToolBinary("docker-buildx"))),
      dockerSha256: hashArtifact(readFileSync(exactToolBinary("docker"))),
    },
    dockerConfig: {
      providerName: "ghcr-bound",
      sha256: hashArtifact(ghcrDockerConfigBytes),
    },
    platform: `${platform()}/${arch()}`,
    provider: {
      authenticationSource: "keyring",
      configDigest: githubConfigDigest(ghConfigRoot),
      keyringReadCommand: [
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        "<receipt-username>",
      ],
      membershipCommand: [
        "api",
        "/user/memberships/orgs/withAutograph",
        "--jq",
        "[.state,.role,.organization.login] | @tsv",
      ],
      name: "gh",
      protocol: "operator-stdin-keyring-readback-v2",
      sha256: hashArtifact(readFileSync(gh)),
      statusCommand: ["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
      userCommand: ["api", "/user", "--jq", ".login"],
      version: githubCliVersion,
    },
    state: {
      digest: githubStateDigest(join(stateRoot, githubStateRootName)),
      environment: "XDG_STATE_HOME",
      policy: "owned-0700-closed-gh-device-id-v1",
      relativePath: githubStateRootName,
    },
    verifier: {
      moduleSha256: hashArtifact(readFileSync(verifierModule)),
      nodeSha256: hashArtifact(readFileSync(node)),
      wrapperSha256: hashArtifact(ghcrBoundHelperBytes),
    },
    version: 3,
  };
};

export const ghcrCredentialEnvironment = function ghcrCredentialEnvironment(
  stateRoot: string,
  identity?: Readonly<{
    username: string;
    digest: string;
    provenanceDigest: string;
    stateDigest?: string;
  }>,
) {
  const gh = exactGithubCli();
  const ghConfigRoot = exactGithubConfigRoot();
  ensureGhcrDockerConfig(stateRoot);
  ensureGhcrBoundHelper(stateRoot);
  const githubStateRoot = ensureGithubStateRoot(stateRoot);
  const environment = {
    APP_BUILDER_GH_CONFIG_DIGEST: githubConfigDigest(ghConfigRoot),
    APP_BUILDER_GH_CONFIG_DIR: ghConfigRoot,
    APP_BUILDER_GH_SHA256: hashArtifact(readFileSync(gh)),
    APP_BUILDER_GH_STATE_DIR: githubStateRoot,
    APP_BUILDER_IMAGE_GHCR_BOUND_HELPER_MODULE: exactGhcrBoundHelperModule(),
    APP_BUILDER_IMAGE_GH_BIN: gh,
    APP_BUILDER_IMAGE_NODE_BIN: exactToolBinary("node"),
    DOCKER_CONFIG: stateRoot,
    PATH: `${stateRoot}:/usr/bin:/bin`,
  };
  if (identity !== undefined) {
    environment.APP_BUILDER_GHCR_USERNAME = identity.username;
    environment.APP_BUILDER_GHCR_IDENTITY_DIGEST = identity.digest;
    environment.APP_BUILDER_GHCR_PROVENANCE_DIGEST = identity.provenanceDigest;
    if (identity.stateDigest !== undefined) {
      environment.APP_BUILDER_GH_STATE_DIGEST = identity.stateDigest;
    }
  }
  return environment;
};

export const hasExactKeys = function hasExactKeys<Value extends object>(
  value: Value,
  expected: readonly string[] & readonly (keyof Value | string)[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const requireCurrentGhcrLogin = function requireCurrentGhcrLogin(
  provenance: ImageProvenance,
): CurrentGhcrLogin {
  const receipt = readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.ghcrLogin,
    receiptKindNames.ghcrLogin,
    provenance,
  );
  const binding = currentGhcrCredentialBinding(provenance.builder.stateRoot);
  const { result } = receipt;
  const parsedResult = ghcrLoginResultSchema.safeParse(result);
  if (!parsedResult.success || !hasExactKeys(result, Object.keys(ghcrLoginResultSchema.shape))) {
    throw new Error("GHCR login receipt does not match the current credential boundary.");
  }
  const validated = parsedResult.data;
  if (
    validated.authenticationProvider !== `gh@${githubCliVersion}-keyring` ||
    validated.provenanceDigest !== provenance.digest ||
    validated.authenticationBoundaryDigest !== hashArtifact(JSON.stringify(binding)) ||
    JSON.stringify(validated.authenticationBoundary) !== JSON.stringify(binding)
  ) {
    throw new Error("GHCR login receipt does not match the current credential boundary.");
  }
  const { username } = validated;
  assertGhcrUsername(username);
  return {
    binding,
    identity: {
      digest: validated.identityDigest,
      provenanceDigest: provenance.digest,
      stateDigest: binding.state.digest,
      username,
    },
    receipt,
  };
};

const readGhcrTokenFromStdin = function readGhcrTokenFromStdin(): Buffer {
  const input = readBoundedInput(0, 4096);
  try {
    let end = input.length;
    if (end > 0 && input[end - 1] === 0x0a) {
      end -= 1;
    }
    if (end > 0 && input[end - 1] === 0x0d) {
      end -= 1;
    }
    const token = Buffer.from(input.subarray(0, end));
    if (token.length < 20) {
      token.fill(0);
      throw new Error("GHCR token from stdin is malformed.");
    }
    for (const byte of token) {
      if (byte <= 0x20 || byte >= 0x7f) {
        token.fill(0);
        throw new Error("GHCR token from stdin is malformed.");
      }
    }
    return token;
  } finally {
    input.fill(0);
  }
};

const verifyGhcrLoginWithOwnedProcessGroup = async function verifyGhcrLoginWithOwnedProcessGroup(
  provenance: ImageProvenance,
  identity: Readonly<{
    username: string;
    digest: string;
    provenanceDigest: string;
  }>,
  token: Buffer,
): Promise<string> {
  const detached = platform() !== "win32";
  const child = spawn(ghcrBoundHelperPath(provenance.builder.stateRoot), ["verify-login"], {
    cwd: provenance.builder.root,
    detached,
    env: sanitizedEnvironment(ghcrCredentialEnvironment(provenance.builder.stateRoot, identity)),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  let timedOut = false;
  const terminate = () => {
    if (child.pid === undefined) {
      return;
    }
    try {
      if (detached) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
  };
  const collect = (target: Buffer[], chunk: Buffer) => {
    const copy = Buffer.from(chunk);
    bytes += copy.length;
    if (bytes > 256 * 1024) {
      failed = true;
      copy.fill(0);
      terminate();
    } else {
      target.push(copy);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    collect(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    collect(stderr, chunk);
  });
  child.stdin.on("error", () => {
    failed = true;
    terminate();
  });
  child.stdin.end(token);
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, 50_000);
  try {
    let status = -1;
    try {
      let code: number | null = null;
      child.once("close", (exitCode) => {
        code = exitCode;
      });
      await once(child, "close");
      status = code ?? -1;
    } catch {
      status = -1;
    }
    if (failed || timedOut || status !== 0) {
      throw new Error("GitHub keyring verification failed without recording credential output.");
    }
    return Buffer.concat(stdout).toString("utf-8");
  } finally {
    clearTimeout(timeout);
    for (const chunk of stdout) {
      chunk.fill(0);
    }
    for (const chunk of stderr) {
      chunk.fill(0);
    }
  }
};

const execute = function execute(
  command: CommandSpec,
  cwd: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): string {
  const tool = z.enum(["docker", "docker-buildx", "msb", "node", "pnpm"]).parse(command.program);
  const inspectVersion = (versionTool: ImageTool) => {
    const versionCommand = imageToolVersionCommand(versionTool);
    const versionInvocation = imageToolInvocation(versionTool, versionCommand.args);
    const version = spawnSync(versionInvocation.program, [...versionInvocation.args], {
      cwd,
      encoding: "utf-8",
      env: sanitizedEnvironment(),
      maxBuffer: maximumCommandOutputBytes,
      timeout: 10_000,
    });
    if (version.error !== undefined || version.status !== 0) {
      throw new Error(`${versionTool} version inspection failed.`);
    }
    assertExactImageToolVersion(versionTool, version.stdout);
  };
  if (tool === "msb") {
    inspectVersion("node");
  }
  inspectVersion(tool);
  const toolInvocation = imageToolInvocation(tool, command.args);
  const invocation =
    command.launcher === undefined
      ? toolInvocation
      : (() => {
          if (command.launcher !== "trusted-node" || tool !== "node") {
            throw new Error("The image lifecycle launcher is unsupported.");
          }
          const launcher = join(cwd, ".config/mise/scripts/trusted-node-launcher");
          const stat = lstatSync(launcher);
          const unsafeIdentity = realpathSync(launcher) !== launcher || !stat.isFile();
          const unsafeOwnership = stat.isSymbolicLink() || stat.uid !== (process.getuid?.() ?? -1);
          const unsafePermissions =
            stat.nlink !== 1 ||
            // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
            (stat.mode & 0o022) !== 0;
          if (unsafeIdentity || unsafeOwnership || unsafePermissions) {
            throw new Error("The image lifecycle trusted Node launcher is invalid.");
          }
          return {
            args: [launcher, toolInvocation.program, ...toolInvocation.args],
            program: "/bin/sh",
          };
        })();
  const result = spawnSync(invocation.program, [...invocation.args], {
    cwd,
    encoding: "utf-8",
    env: sanitizedEnvironment({
      ...command.environment,
      ...extraEnvironment,
    }),
    maxBuffer: maximumCommandOutputBytes,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (
    Buffer.byteLength(result.stdout) > maximumCommandOutputBytes ||
    Buffer.byteLength(result.stderr) > maximumCommandOutputBytes
  ) {
    throw new Error(`${command.program} lifecycle command output was too large.`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command.program} lifecycle command failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
  return result.stdout;
};

const verifyImageSourcesUnlocked = function verifyImageSourcesUnlocked(
  approval: LifecycleApproval,
) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.source,
    receiptKindNames.source,
    provenance,
  );
  if (existing !== undefined) {
    return existing;
  }
  return writeReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.source,
    receiptKindNames.source,
    provenance,
    { status: "verified" },
  );
};

const buildImageUnlocked = function buildImageUnlocked(approval: LifecycleApproval) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.build,
    receiptKindNames.build,
    provenance,
  );
  if (existing !== undefined) {
    return existing;
  }
  readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.source,
    receiptKindNames.source,
    provenance,
  );
  const context = materializeSanitizedGitTree(
    provenance.arrusted.root,
    join(provenance.builder.stateRoot, `arrusted-context.tmp-${process.pid}-${randomUUID()}`),
    provenance.arrusted.commit,
    provenance.arrusted.tree,
  );
  try {
    withBuildxRuntime(provenance.builder.stateRoot, (environment) =>
      execute(imageBuildCommand(provenance, context.root), provenance.builder.root, environment),
    );
  } finally {
    removeSanitizedGitTree(context);
  }
  return writeReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.build,
    receiptKindNames.build,
    provenance,
    {
      gitMetadataIncluded: false,
      sanitizedContextEntriesDigest: context.entriesDigest,
      sanitizedContextEntryCount: context.entryCount,
      status: "built",
      tag: provenance.image.tag,
    },
  );
};

const inspectLocalImageUnlocked = function inspectLocalImageUnlocked(approval: LifecycleApproval) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.localImage,
    receiptKindNames.localImage,
    provenance,
  );
  if (existing !== undefined) {
    return existing;
  }
  readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.build,
    receiptKindNames.build,
    provenance,
  );
  const result = parseLocalImageInspection(
    execute(localImageInspectionCommand(provenance), provenance.builder.root),
    provenance,
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.localImage,
    receiptKindNames.localImage,
    provenance,
    result,
  );
};

const pushImageUnlocked = function pushImageUnlocked(approval: LifecycleApproval) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.push,
    receiptKindNames.push,
    provenance,
  );
  if (existing !== undefined) {
    return existing;
  }
  const login = requireCurrentGhcrLogin(provenance);
  const local = readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.localImage,
    receiptKindNames.localImage,
    provenance,
  );
  execute(
    imagePushCommand(provenance),
    provenance.builder.root,
    ghcrCredentialEnvironment(provenance.builder.stateRoot, login.identity),
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.push,
    receiptKindNames.push,
    provenance,
    {
      ghcrLoginReceiptDigest: login.receipt.digest,
      localImageReceiptDigest: local.digest,
      status: "pushed",
      tag: provenance.image.tag,
    },
  );
};

const loginGhcrUnlocked = async function loginGhcrUnlocked(
  approval: LifecycleApproval,
  username: string,
) {
  const provenance = observeImageProvenance(approval);
  readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.source,
    receiptKindNames.source,
    provenance,
  );
  assertGhcrUsername(username);
  currentGhcrCredentialBinding(provenance.builder.stateRoot);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.ghcrLogin,
    receiptKindNames.ghcrLogin,
    provenance,
  );
  if (existing !== undefined) {
    const current = requireCurrentGhcrLogin(provenance);
    if (current.identity.username !== username) {
      throw new Error("Existing GHCR login receipt names another identity.");
    }
    return current.receipt;
  }
  const token = readGhcrTokenFromStdin();
  try {
    const identityDigest = ghcrIdentityDigest(username, provenance.digest, token);
    const identity = {
      digest: identityDigest,
      provenanceDigest: provenance.digest,
      username,
    };
    const result = await verifyGhcrLoginWithOwnedProcessGroup(provenance, identity, token);
    assertVerifiedGhcrLoginPayload(result, username, provenance.digest, identityDigest);
    const binding = currentGhcrCredentialBinding(provenance.builder.stateRoot);
    return writeReceipt(
      provenance.builder.stateRoot,
      receiptFileNames.ghcrLogin,
      receiptKindNames.ghcrLogin,
      provenance,
      {
        authenticationBoundary: binding,
        authenticationBoundaryDigest: hashArtifact(JSON.stringify(binding)),
        authenticationProvider: `gh@${githubCliVersion}-keyring`,
        identityDigest,
        keyringReadbackTransport: "github-cli-keyring",
        operatorApprovalTransport: "one-time-stdin",
        provenanceDigest: provenance.digest,
        providerMutation: "none",
        registry: "ghcr.io",
        schema: "ghcr-login-v3",
        status: "credential-matched",
        username,
      },
    );
  } finally {
    token.fill(0);
  }
};

const inspectRemoteImageUnlocked = function inspectRemoteImageUnlocked(
  approval: LifecycleApproval,
) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.remoteImage,
    receiptKindNames.remoteImage,
    provenance,
  );
  if (existing !== undefined) {
    return existing;
  }
  const local = readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.localImage,
    receiptKindNames.localImage,
    provenance,
  );
  const push = readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.push,
    receiptKindNames.push,
    provenance,
  );
  const login = requireCurrentGhcrLogin(provenance);
  const pushBinding = pushBindingSchema.safeParse(push.result);
  if (
    !pushBinding.success ||
    pushBinding.data.localImageReceiptDigest !== local.digest ||
    pushBinding.data.ghcrLoginReceiptDigest !== login.receipt.digest
  ) {
    throw new Error("Image push receipt is not bound to the local image identity.");
  }
  const localIdentityResult = localImageIdentitySchema.safeParse(local.result);
  if (!localIdentityResult.success) {
    throw new Error("Local image receipt has no exact image identity.");
  }
  const result = withBuildxRuntime(provenance.builder.stateRoot, (buildxEnvironment) => {
    const environment = {
      ...ghcrCredentialEnvironment(provenance.builder.stateRoot, login.identity),
      ...buildxEnvironment,
    };
    const localIdentity = localIdentityResult.data;
    const descriptorRaw = execute(
      remoteDescriptorCommand(provenance),
      provenance.builder.root,
      environment,
    );
    const descriptor = parseRemoteIndexDescriptor(descriptorRaw);
    const selection = parseRemoteIndexInspection(
      descriptorRaw,
      execute(remoteIndexCommand(descriptor.indexReference), provenance.builder.root, environment),
      localIdentity.imageId,
    );
    return parseRemoteImageInspection(
      execute(
        remoteManifestCommand(selection.platformReference),
        provenance.builder.root,
        environment,
      ),
      execute(
        remoteImageCommand(selection.platformReference),
        provenance.builder.root,
        environment,
      ),
      provenance,
      localIdentity,
      selection,
    );
  });
  return writeReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.remoteImage,
    receiptKindNames.remoteImage,
    provenance,
    result,
  );
};

const preloadImageUnlocked = function preloadImageUnlocked(
  approval: LifecycleApproval,
  digestReferenceInput: string,
) {
  const provenance = observeImageProvenance(approval);
  const reference = exactDigestReference(digestReferenceInput);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.preload,
    receiptKindNames.preload,
    provenance,
  );
  if (existing !== undefined) {
    const priorReference = referenceReceiptSchema.safeParse(existing.result);
    if (!priorReference.success || priorReference.data.reference !== reference) {
      throw new Error("Existing preload receipt names another digest.");
    }
    return existing;
  }
  const remote = readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.remoteImage,
    receiptKindNames.remoteImage,
    provenance,
  );
  const remoteReference = referenceReceiptSchema.safeParse(remote.result);
  if (!remoteReference.success || remoteReference.data.reference !== reference) {
    throw new Error("Digest-only preload does not match remote readback.");
  }
  const login = requireCurrentGhcrLogin(provenance);
  const push = readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.push,
    receiptKindNames.push,
    provenance,
  );
  const pushBinding = pushBindingSchema.safeParse(push.result);
  if (!pushBinding.success || pushBinding.data.ghcrLoginReceiptDigest !== login.receipt.digest) {
    throw new Error("Image push receipt does not match the current GHCR login identity.");
  }
  execute(
    imagePreloadCommand(reference),
    provenance.builder.root,
    ghcrCredentialEnvironment(provenance.builder.stateRoot, login.identity),
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.preload,
    receiptKindNames.preload,
    provenance,
    { reference, status: "preloaded" },
  );
};

type ProofRuntimeResult = Readonly<{
  status: "prepared";
  pnpmLockSha256: string;
  dependencyTreeSha256: string;
  nodeModulesTreeSha256: string;
  ignoredInventory: "node_modules/";
}>;

const observeProofRuntime = function observeProofRuntime(
  approval: LifecycleApproval,
): ObservedProofRuntime {
  const provenance = observeImageProvenance(approval, process.cwd(), {
    allowProofRuntime: true,
  });
  const result: ProofRuntimeResult = {
    dependencyTreeSha256: hashArtifact(
      execute(inspectProofRuntimeCommand(), provenance.builder.root),
    ),
    ignoredInventory: "node_modules/",
    nodeModulesTreeSha256: normalizedNodeModulesDigest(
      join(provenance.builder.root, "node_modules"),
    ),
    pnpmLockSha256: hashArtifact(readFileSync(join(provenance.builder.root, "pnpm-lock.yaml"))),
    status: "prepared",
  };
  assertNoSecretMaterial(result);
  return { provenance, result };
};

const prepareProofRuntimeUnlocked = function prepareProofRuntimeUnlocked(
  approval: LifecycleApproval,
) {
  const builderRoot = process.cwd();
  const nodeModules = join(builderRoot, "node_modules");
  if (existsSync(nodeModules)) {
    const current = observeProofRuntime(approval);
    readReceipt(
      current.provenance.builder.stateRoot,
      receiptFileNames.source,
      receiptKindNames.source,
      current.provenance,
    );
    const existing = optionalReceipt(
      current.provenance.builder.stateRoot,
      receiptFileNames.proofRuntime,
      receiptKindNames.proofRuntime,
      current.provenance,
    );
    if (existing !== undefined) {
      if (JSON.stringify(existing.result) !== JSON.stringify(current.result)) {
        throw new Error("Existing proof runtime receipt does not match actual dependency bytes.");
      }
      return existing;
    }
  } else {
    const clean = observeImageProvenance(approval);
    readReceipt(clean.builder.stateRoot, receiptFileNames.source, receiptKindNames.source, clean);
  }
  execute(prepareProofRuntimeCommand(), builderRoot);
  const { provenance, result } = observeProofRuntime(approval);
  readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.source,
    receiptKindNames.source,
    provenance,
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.proofRuntime,
    receiptKindNames.proofRuntime,
    provenance,
    result,
  );
};

const requireCurrentProofRuntime = function requireCurrentProofRuntime(
  approval: LifecycleApproval,
): CurrentProofRuntime {
  const { provenance, result } = observeProofRuntime(approval);
  const receipt = readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.proofRuntime,
    receiptKindNames.proofRuntime,
    provenance,
  );
  if (JSON.stringify(receipt.result) !== JSON.stringify(result)) {
    throw new Error("Proof runtime dependency state drifted after its frozen-install receipt.");
  }
  return { provenance, receipt };
};

const proveSandboxImageUnlocked = function proveSandboxImageUnlocked(
  approval: LifecycleApproval,
  digestReferenceInput: string,
) {
  const { provenance, receipt: proofRuntime } = requireCurrentProofRuntime(approval);
  const reference = exactDigestReference(digestReferenceInput);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.sandboxProof,
    receiptKindNames.sandboxProof,
    provenance,
  );
  if (existing !== undefined) {
    const priorProof = sandboxProofReceiptSchema.safeParse(existing.result);
    const proofMatches =
      priorProof.success && priorProof.data.proofRuntimeReceiptDigest === proofRuntime.digest;
    if (!priorProof.success || priorProof.data.reference !== reference || !proofMatches) {
      throw new Error(
        "Existing sandbox proof does not match the current digest-bound proof runtime.",
      );
    }
    return existing;
  }
  const preload = readReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.preload,
    receiptKindNames.preload,
    provenance,
  );
  const preloadReference = referenceReceiptSchema.safeParse(preload.result);
  if (!preloadReference.success || preloadReference.data.reference !== reference) {
    throw new Error("Sandbox proof does not match the preloaded digest.");
  }
  execute(sandboxProofCommand(reference, provenance.arrusted.root), provenance.builder.root);
  return writeReceipt(
    provenance.builder.stateRoot,
    receiptFileNames.sandboxProof,
    receiptKindNames.sandboxProof,
    provenance,
    {
      proofRuntimeReceiptDigest: proofRuntime.digest,
      readOnly: true,
      reference,
      scope: "typed-identity-and-planning",
      status: "passed",
      terminalPhase: "planned",
    },
  );
};

const locked = async <T>(approval: LifecycleApproval, operation: () => T) =>
  await withLifecycleLock(approval.stateRoot, () => {
    assertLifecycleStateScope(approval);
    reconcileLifecycleTemps(approval.stateRoot);
    return operation();
  });

export const verifyImageSources = async (approval: LifecycleApproval) =>
  await locked(approval, () => verifyImageSourcesUnlocked(approval));
export const buildImage = async (approval: LifecycleApproval) =>
  await locked(approval, () => buildImageUnlocked(approval));
export const inspectLocalImage = async (approval: LifecycleApproval) =>
  await locked(approval, () => inspectLocalImageUnlocked(approval));
export const loginGhcr = async (approval: LifecycleApproval, username: string) =>
  await locked(approval, async () => await loginGhcrUnlocked(approval, username));
export const pushImage = async (approval: LifecycleApproval) =>
  await locked(approval, () => pushImageUnlocked(approval));
export const inspectRemoteImage = async (approval: LifecycleApproval) =>
  await locked(approval, () => inspectRemoteImageUnlocked(approval));
export const preloadImage = async (approval: LifecycleApproval, digestReferenceInput: string) =>
  await locked(approval, () => preloadImageUnlocked(approval, digestReferenceInput));
export const prepareProofRuntime = async (approval: LifecycleApproval) =>
  await locked(approval, () => prepareProofRuntimeUnlocked(approval));
export const proveSandboxImage = async (
  approval: LifecycleApproval,
  digestReferenceInput: string,
) => await locked(approval, () => proveSandboxImageUnlocked(approval, digestReferenceInput));
