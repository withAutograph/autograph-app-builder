import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { arch, homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  parseRemoteImageInspection,
  prepareProofRuntimeCommand,
  remoteDescriptorCommand,
  remoteImageCommand,
  remoteManifestCommand,
  sandboxProofCommand,
  type CommandSpec,
  type ImageProvenance,
  type ImageTool,
} from "./lifecycle.ts";
import {
  assertVerifiedGhcrLoginPayload,
  githubConfigDigest,
  ghcrIdentityDigest,
  readBoundedInput,
} from "./ghcr-bound-helper.ts";

const dockerfilePath = "containers/eve-sandbox/Dockerfile" as const;
const maximumCommandOutputBytes = 4 * 1024 * 1024;
const receiptKinds = {
  "source-receipt.json": "image-source",
  "build-receipt.json": "image-build",
  "ghcr-login-receipt.json": "ghcr-login",
  "local-image-receipt.json": "local-image",
  "push-receipt.json": "image-push",
  "remote-image-receipt.json": "remote-image",
  "preload-receipt.json": "image-preload",
  "proof-runtime-receipt.json": "proof-runtime",
  "sandbox-proof-receipt.json": "sandbox-proof",
} as const;

const targetArguments = {
  MISE_CONFIG_SHA256: ".config/mise/config.toml",
  MISE_LOCK_SHA256: ".config/mise/mise.lock",
  BUN_LOCK_SHA256: "bun.lock",
  APP_IDENTITY_SHA256: ".config/mise/scripts/repository/app-identity.ts",
  APP_CONTRACT_SHA256: ".config/mise/scripts/repository/app-contract.ts",
  REPOSITORY_PREFLIGHT_SHA256:
    ".config/mise/scripts/repository/repository-preflight.ts",
  REPOSITORY_EXEC_SHA256: ".config/mise/tasks/repository/exec",
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
  result: unknown;
  digest: string;
}>;

const fixedGit = "/usr/bin/git";
const githubCliVersion = "2.98.0";
const ghcrDockerConfigName = "config.json";
const ghcrBoundHelperName = "docker-credential-ghcr-bound";
const ghcrDockerConfigBytes = Buffer.from(
  '{"credHelpers":{"ghcr.io":"ghcr-bound"}}\n',
  "utf8",
);
const ghcrBoundHelperBytes = Buffer.from(
  '#!/bin/sh\nexec "$APP_BUILDER_IMAGE_NODE_BIN" --experimental-strip-types "$APP_BUILDER_IMAGE_GHCR_BOUND_HELPER_MODULE" "$@"\n',
  "utf8",
);

type GhcrCredentialBinding = Readonly<{
  version: 2;
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
  verifier: Readonly<{
    wrapperSha256: string;
    moduleSha256: string;
    nodeSha256: string;
  }>;
}>;

const sanitizedEnvironment = (
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => ({
  HOME: homedir(),
  LANG: "C",
  NODE_ENV: "production",
  PATH: "/usr/bin:/bin",
  ...extra,
});

const git = (root: string, args: readonly string[]) =>
  execFileSync(fixedGit, ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: sanitizedEnvironment(),
  }).trim();

function ensureNoLinkPath(path: string, label: string): void {
  const canonical = resolve(path);
  assertCanonicalRoot(canonical, realpathSync(canonical), label);
  const root = resolve(canonical, "/") === canonical ? canonical : undefined;
  if (root !== undefined)
    throw new Error(`${label} cannot be the filesystem root.`);
  let cursor = canonical;
  for (;;) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink())
      throw new Error(`${label} contains a symbolic link.`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function assertAbsoluteInput(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(`${label} must be an absolute normalized path.`);
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function lifecycleLockPort(stateRoot: string): number {
  const value = createHash("sha256").update(stateRoot).digest().readUInt16BE(0);
  return 32_768 + (value % 24_000);
}

export async function withLifecycleLock<T>(
  stateRoot: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  assertAbsoluteInput(stateRoot, "Image lifecycle state root");
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveLock, rejectLock) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      rejectLock(
        error.code === "EADDRINUSE"
          ? new Error(
              "Another image lifecycle operation holds the exclusive external-operation lock.",
            )
          : error,
      );
    });
    server.listen(
      {
        host: "127.0.0.1",
        port: lifecycleLockPort(stateRoot),
        exclusive: true,
      },
      resolveLock,
    );
  });
  server.unref();
  try {
    return await operation();
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) =>
        error === undefined ? resolveClose() : rejectClose(error),
      ),
    );
  }
}

export function normalizedNodeModulesDigest(nodeModulesRoot: string): string {
  const records: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const relativePath = relative(nodeModulesRoot, absolute);
      const stat = lstatSync(absolute);
      const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (isAbsolute(target))
          throw new Error(
            `Proof runtime symlink ${relativePath} has an absolute target.`,
          );
        const resolvedTarget = resolve(dirname(absolute), target);
        if (!containsPath(nodeModulesRoot, resolvedTarget))
          throw new Error(
            `Proof runtime symlink ${relativePath} escapes node_modules.`,
          );
        const canonicalTarget = realpathSync(absolute);
        if (!containsPath(nodeModulesRoot, canonicalTarget))
          throw new Error(
            `Proof runtime symlink ${relativePath} resolves outside node_modules.`,
          );
        records.push(`l\0${relativePath}\0${mode}\0${target}`);
      } else if (stat.isDirectory()) {
        records.push(`d\0${relativePath}\0${mode}`);
        walk(absolute);
      } else if (stat.isFile()) {
        records.push(
          `f\0${relativePath}\0${mode}\0${stat.size}\0${hashArtifact(readFileSync(absolute))}`,
        );
      } else {
        throw new Error(
          `Proof runtime contains unsupported entry ${relativePath}.`,
        );
      }
    }
  };
  walk(nodeModulesRoot);
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

function assertDisjointRoots(
  stateRoot: string,
  repositoryRoot: string,
  label: string,
): void {
  if (
    containsPath(repositoryRoot, stateRoot) ||
    containsPath(stateRoot, repositoryRoot)
  )
    throw new Error(`${label} must be outside the image lifecycle state root.`);
}

function assertLifecycleStateScope(approval: LifecycleApproval): void {
  const builderRoot = process.cwd();
  assertAbsoluteInput(builderRoot, "Builder root");
  assertAbsoluteInput(approval.arrustedRoot, "Arrusted root");
  assertAbsoluteInput(approval.stateRoot, "Image lifecycle state root");
  ensureNoLinkPath(builderRoot, "Builder root");
  ensureNoLinkPath(approval.arrustedRoot, "Arrusted root");
  if (existsSync(approval.stateRoot)) {
    ensureNoLinkPath(approval.stateRoot, "Image lifecycle state root");
    assertOwnedPrivateDirectory(
      approval.stateRoot,
      "Image lifecycle state root",
    );
  } else {
    ensureNoLinkPath(
      dirname(approval.stateRoot),
      "Image lifecycle state parent",
    );
  }
  assertDisjointRoots(approval.stateRoot, builderRoot, "Builder root");
  assertDisjointRoots(
    approval.stateRoot,
    approval.arrustedRoot,
    "Arrusted root",
  );
}

function assertOwnedPrivateDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700)
    throw new Error(`${label} must be a mode 0700 directory.`);
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== uid)
    throw new Error(`${label} must be owned by the current user.`);
}

function exactDockerArgument(dockerfile: string, name: string): string {
  const match = new RegExp(`^ARG ${name}=([^\\n]+)$`, "mu").exec(dockerfile);
  if (match?.[1] === undefined)
    throw new Error(`Dockerfile is missing exact ${name}.`);
  return match[1];
}

const temporaryReceiptPattern = new RegExp(
  `^(?:${Object.keys(receiptKinds)
    .map((name) => name.replaceAll(".", "[.]"))
    .join("|")})[.]tmp-[0-9]+-[0-9a-f-]{36}$`,
  "u",
);
const temporaryContextPattern =
  /^arrusted-context[.]tmp-[0-9]+-[0-9a-f-]{36}$/u;

export function reconcileLifecycleTemps(stateRoot: string): void {
  if (!existsSync(stateRoot)) return;
  ensureNoLinkPath(stateRoot, "Image lifecycle state root");
  assertOwnedPrivateDirectory(stateRoot, "Image lifecycle state root");
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Image lifecycle recovery requires a current user ID.");
  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    const absolute = join(stateRoot, entry.name);
    const stat = lstatSync(absolute);
    if (temporaryReceiptPattern.test(entry.name)) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        stat.uid !== uid ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new Error("Unsafe interrupted receipt artifact requires review.");
      unlinkSync(absolute);
    } else if (temporaryContextPattern.test(entry.name)) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        stat.uid !== uid ||
        (stat.mode & 0o777) !== 0o700
      )
        throw new Error("Unsafe interrupted build context requires review.");
      rmSync(absolute, { recursive: true, force: false });
    }
  }
}

export type SanitizedGitTree = Readonly<{
  root: string;
  entriesDigest: string;
  entryCount: number;
}>;

function writeExactFile(path: string, bytes: Buffer, mode: number): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
}

export function materializeSanitizedGitTree(
  sourceRoot: string,
  destinationRoot: string,
  expectedCommit: string,
  expectedTree: string,
): SanitizedGitTree {
  assertAbsoluteInput(sourceRoot, "Sanitized tree source");
  assertAbsoluteInput(destinationRoot, "Sanitized tree destination");
  ensureNoLinkPath(sourceRoot, "Sanitized tree source");
  if (existsSync(destinationRoot))
    throw new Error("Sanitized build context destination already exists.");
  const destinationParent = dirname(destinationRoot);
  ensureNoLinkPath(destinationParent, "Sanitized tree destination parent");
  if (git(sourceRoot, ["rev-parse", "HEAD"]) !== expectedCommit)
    throw new Error("Sanitized context source commit changed.");
  if (git(sourceRoot, ["rev-parse", "HEAD^{tree}"]) !== expectedTree)
    throw new Error("Sanitized context source tree changed.");
  const listing = execFileSync(
    fixedGit,
    ["-C", sourceRoot, "ls-tree", "-rz", "-r", "--full-tree", "HEAD"],
    { maxBuffer: 128 * 1024 * 1024, env: sanitizedEnvironment() },
  ).toString("utf8");
  const records: string[] = [];
  mkdirSync(destinationRoot, { mode: 0o700 });
  try {
    for (const row of listing.split("\0").filter(Boolean)) {
      const match = /^([0-9]{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/u.exec(
        row,
      );
      if (match === null)
        throw new Error("Sanitized context contains an unsupported Git entry.");
      const [, mode, type, objectId, path] = match;
      if (
        type !== "blob" ||
        path === undefined ||
        path.includes("\\") ||
        path.includes("\ufffd") ||
        path
          .split("/")
          .some((part) => part === "" || part === "." || part === "..") ||
        path === ".git" ||
        path.startsWith(".git/") ||
        path === ".app-builder-source-manifest.json"
      )
        throw new Error("Sanitized context contains an unsafe Git path.");
      if (mode !== "100644" && mode !== "100755" && mode !== "120000")
        throw new Error("Sanitized context contains an unsupported Git mode.");
      const absolute = resolve(destinationRoot, path);
      if (!containsPath(destinationRoot, absolute))
        throw new Error("Sanitized context path escapes its root.");
      const parent = dirname(absolute);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      ensureNoLinkPath(parent, `Sanitized context parent for ${path}`);
      const bytes = execFileSync(
        fixedGit,
        ["-C", sourceRoot, "cat-file", "blob", objectId],
        { maxBuffer: 128 * 1024 * 1024, env: sanitizedEnvironment() },
      );
      if (mode === "120000") {
        const target = bytes.toString("utf8");
        if (
          target === "" ||
          target.includes("\0") ||
          target.includes("\ufffd") ||
          isAbsolute(target) ||
          !containsPath(destinationRoot, resolve(parent, target))
        )
          throw new Error(`Sanitized context symlink ${path} is unsafe.`);
        symlinkSync(target, absolute);
      } else {
        writeExactFile(absolute, bytes, mode === "100755" ? 0o755 : 0o644);
      }
      records.push(`${mode}\0${objectId}\0${path}`);
    }
    const entriesDigest = hashArtifact(records.join("\n"));
    const manifest = {
      version: 1,
      source: { commit: expectedCommit, tree: expectedTree },
      entriesDigest,
      entryCount: records.length,
    };
    assertNoSecretMaterial(manifest);
    writeExactFile(
      join(destinationRoot, ".app-builder-source-manifest.json"),
      Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"),
      0o444,
    );
    return { root: destinationRoot, entriesDigest, entryCount: records.length };
  } catch (error) {
    rmSync(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}

function removeSanitizedGitTree(context: SanitizedGitTree): void {
  if (!temporaryContextPattern.test(context.root.split(sep).at(-1) ?? ""))
    throw new Error("Refusing to remove a non-lifecycle build context.");
  const stat = lstatSync(context.root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Refusing to remove an unsafe lifecycle build context.");
  rmSync(context.root, { recursive: true, force: false });
}

function writeReceipt(
  stateRoot: string,
  filename: string,
  kind: string,
  provenance: ImageProvenance,
  result: unknown,
): ReceiptEnvelope {
  const unsigned = { version: 1 as const, kind, provenance, result };
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
    if (existing.digest !== receipt.digest)
      throw new Error(`${kind} already has a different exact receipt.`);
    return existing;
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return receipt;
}

function readReceipt(
  stateRoot: string,
  filename: string,
  kind: string,
  provenance: ImageProvenance,
): ReceiptEnvelope {
  const path = join(stateRoot, filename);
  ensureNoLinkPath(path, `${kind} receipt`);
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    uid === undefined ||
    stat.uid !== uid
  )
    throw new Error(`${kind} receipt must be an owned mode 0600 regular file.`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ReceiptEnvelope;
  if (
    parsed.version !== 1 ||
    parsed.kind !== kind ||
    parsed.provenance.digest !== provenance.digest
  )
    throw new Error(`${kind} receipt does not match exact provenance.`);
  const { digest, ...unsigned } = parsed;
  if (digest !== hashArtifact(JSON.stringify(unsigned)))
    throw new Error(`${kind} receipt digest is invalid.`);
  assertNoSecretMaterial(parsed);
  return parsed;
}

function optionalReceipt(
  stateRoot: string,
  filename: string,
  kind: string,
  provenance: ImageProvenance,
): ReceiptEnvelope | undefined {
  return existsSync(join(stateRoot, filename))
    ? readReceipt(stateRoot, filename, kind, provenance)
    : undefined;
}

function verifyStateRootContents(provenance: ImageProvenance): void {
  for (const entry of readdirSync(provenance.builder.stateRoot, {
    withFileTypes: true,
  })) {
    if (entry.name === ghcrDockerConfigName) {
      assertExactGhcrDockerConfig(provenance.builder.stateRoot);
      continue;
    }
    if (entry.name === ghcrBoundHelperName) {
      assertExactGhcrBoundHelper(provenance.builder.stateRoot);
      continue;
    }
    const kind = receiptKinds[entry.name as keyof typeof receiptKinds];
    if (kind === undefined || !entry.isFile() || entry.isSymbolicLink())
      throw new Error(
        "Image lifecycle state contains an unknown or unsafe artifact.",
      );
    readReceipt(provenance.builder.stateRoot, entry.name, kind, provenance);
  }
}

export function observeImageProvenance(
  approval: LifecycleApproval,
  builderRootInput: string = process.cwd(),
  options: Readonly<{ allowProofRuntime?: boolean }> = {},
): ImageProvenance {
  assertAbsoluteInput(builderRootInput, "Builder root");
  assertAbsoluteInput(approval.arrustedRoot, "Arrusted root");
  assertAbsoluteInput(approval.stateRoot, "Image lifecycle state root");
  const builderRoot = resolve(builderRootInput);
  const arrustedRoot = resolve(approval.arrustedRoot);
  const stateRoot = resolve(approval.stateRoot);
  ensureNoLinkPath(builderRoot, "Builder root");
  ensureNoLinkPath(arrustedRoot, "Arrusted root");
  if (!existsSync(stateRoot)) {
    const parent = dirname(stateRoot);
    ensureNoLinkPath(parent, "Image lifecycle state parent");
    mkdirSync(stateRoot, { recursive: false, mode: 0o700 });
  }
  ensureNoLinkPath(stateRoot, "Image lifecycle state root");
  assertOwnedPrivateDirectory(stateRoot, "Image lifecycle state root");
  assertDisjointRoots(stateRoot, builderRoot, "Builder root");
  assertDisjointRoots(stateRoot, arrustedRoot, "Arrusted root");
  const builderDotGit = join(builderRoot, ".git");
  ensureNoLinkPath(builderDotGit, "Builder Git metadata");
  assertStandaloneGitMetadata(
    lstatSync(builderDotGit).isDirectory(),
    "Builder",
  );
  const dotGit = join(arrustedRoot, ".git");
  ensureNoLinkPath(dotGit, "Arrusted Git metadata");
  assertStandaloneGitMetadata(lstatSync(dotGit).isDirectory(), "Arrusted");
  const dockerfileAbsolute = join(builderRoot, dockerfilePath);
  ensureNoLinkPath(dockerfileAbsolute, "Sandbox Dockerfile");
  const dockerfile = readFileSync(dockerfileAbsolute, "utf8");
  if (
    exactDockerArgument(dockerfile, "TARGET_SHA") !== ARRUSTED_IMAGE_TARGET_SHA
  )
    throw new Error(
      "Dockerfile target commit does not match lifecycle policy.",
    );
  if (
    exactDockerArgument(dockerfile, "TARGET_TREE") !==
    ARRUSTED_IMAGE_TARGET_TREE
  )
    throw new Error("Dockerfile target tree does not match lifecycle policy.");
  const targetFiles = Object.fromEntries(
    Object.entries(targetArguments).map(([argument, relativePath]) => {
      const absolute = join(arrustedRoot, relativePath);
      ensureNoLinkPath(absolute, `Arrusted target file ${relativePath}`);
      const digest = hashArtifact(readFileSync(absolute));
      if (exactDockerArgument(dockerfile, argument) !== digest)
        throw new Error(`Arrusted target file ${relativePath} drifted.`);
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
      "--porcelain=v1",
      "--ignored",
      "--untracked-files=normal",
    ]);
    assertProofRuntimeIgnoredInventory(collapsedIgnored);
    const nodeModules = join(builderRoot, "node_modules");
    ensureNoLinkPath(nodeModules, "Builder proof-runtime node_modules");
    const stat = lstatSync(nodeModules);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || uid === undefined || stat.uid !== uid)
      throw new Error(
        "Builder proof-runtime node_modules must be a real current-user-owned directory.",
      );
  }
  const provenance = createExactImageProvenance({
    builderRoot,
    stateRoot,
    observedBuilderCommit: git(builderRoot, ["rev-parse", "HEAD"]),
    observedBuilderTree: git(builderRoot, ["rev-parse", "HEAD^{tree}"]),
    expectedBuilderCommit: approval.builderCommit,
    expectedBuilderTree: approval.builderTree,
    builderStatus: git(builderRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    builderIgnored: options.allowProofRuntime === true ? "" : builderIgnored,
    arrustedRoot,
    observedArrustedCommit: git(arrustedRoot, ["rev-parse", "HEAD"]),
    observedArrustedTree: git(arrustedRoot, ["rev-parse", "HEAD^{tree}"]),
    arrustedStatus: git(arrustedRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    arrustedIgnored: git(arrustedRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
    ]),
    dockerfileSha256: hashArtifact(dockerfile),
    expectedDockerfileSha256: approval.dockerfileSha256,
    targetFiles,
  });
  verifyStateRootContents(provenance);
  return provenance;
}

const toolEnvironmentKeys = {
  docker: "APP_BUILDER_IMAGE_DOCKER_BIN",
  "docker-buildx": "APP_BUILDER_IMAGE_BUILDX_BIN",
  msb: "APP_BUILDER_IMAGE_MSB_BIN",
  node: "APP_BUILDER_IMAGE_NODE_BIN",
  pnpm: "APP_BUILDER_IMAGE_PNPM_BIN",
} as const;

function exactGithubCli(): string {
  const configured = process.env.APP_BUILDER_IMAGE_GH_BIN;
  if (configured === undefined || !isAbsolute(configured))
    throw new Error("GitHub CLI must be resolved by the owning mise task.");
  const binary = realpathSync(configured);
  if (binary !== configured || binary.split(sep).at(-1) !== "gh")
    throw new Error("GitHub CLI must use its canonical exact path.");
  const stat = lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("GitHub CLI does not resolve to a regular file.");
  const version = spawnSync(binary, ["version"], {
    encoding: "utf8",
    maxBuffer: maximumCommandOutputBytes,
    timeout: 10_000,
    env: sanitizedEnvironment(),
  });
  if (
    version.error !== undefined ||
    version.status !== 0 ||
    !version.stdout.startsWith(`gh version ${githubCliVersion} `)
  )
    throw new Error("GitHub CLI version is unsupported.");
  return binary;
}

function exactGithubConfigRoot(): string {
  const root = realpathSync(join(homedir(), ".config/gh"));
  ensureNoLinkPath(root, "GitHub configuration root");
  githubConfigDigest(root);
  return root;
}

function exactToolBinary(program: ImageTool): string {
  const key = toolEnvironmentKeys[program];
  const configured = process.env[key];
  if (configured === undefined || !resolve(configured).startsWith("/"))
    throw new Error(`${program} must be resolved by the owning mise task.`);
  const binary = realpathSync(configured);
  const stat = lstatSync(binary);
  if (!stat.isFile())
    throw new Error(`${program} does not resolve to a regular file.`);
  return binary;
}

function ghcrDockerConfigPath(stateRoot: string): string {
  return join(stateRoot, ghcrDockerConfigName);
}

function ghcrBoundHelperPath(stateRoot: string): string {
  return join(stateRoot, ghcrBoundHelperName);
}

function assertExactGhcrDockerConfig(stateRoot: string): void {
  const path = ghcrDockerConfigPath(stateRoot);
  ensureNoLinkPath(path, "GHCR Docker configuration");
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    uid === undefined ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error(
      "GHCR Docker configuration must be an owned mode 0600 regular file.",
    );
  if (!readFileSync(path).equals(ghcrDockerConfigBytes))
    throw new Error(
      "GHCR Docker configuration does not match the closed schema.",
    );
}

function ensureGhcrDockerConfig(stateRoot: string): void {
  const path = ghcrDockerConfigPath(stateRoot);
  if (!existsSync(path)) writeExactFile(path, ghcrDockerConfigBytes, 0o600);
  assertExactGhcrDockerConfig(stateRoot);
}

function assertExactGhcrBoundHelper(stateRoot: string): void {
  const path = ghcrBoundHelperPath(stateRoot);
  ensureNoLinkPath(path, "GHCR bound helper");
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    uid === undefined ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error(
      "GHCR bound helper must be an owned mode 0700 regular file.",
    );
  if (!readFileSync(path).equals(ghcrBoundHelperBytes))
    throw new Error(
      "GHCR bound helper does not match the closed implementation.",
    );
}

function ensureGhcrBoundHelper(stateRoot: string): void {
  const path = ghcrBoundHelperPath(stateRoot);
  if (!existsSync(path)) writeExactFile(path, ghcrBoundHelperBytes, 0o700);
  assertExactGhcrBoundHelper(stateRoot);
}

function exactGhcrBoundHelperModule(): string {
  const path = realpathSync(
    join(process.cwd(), "lib/image/ghcr-bound-helper.ts"),
  );
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("GHCR bound helper module is invalid.");
  return path;
}

export function currentGhcrCredentialBinding(
  stateRoot: string,
): GhcrCredentialBinding {
  ensureGhcrDockerConfig(stateRoot);
  ensureGhcrBoundHelper(stateRoot);
  const gh = exactGithubCli();
  const ghConfigRoot = exactGithubConfigRoot();
  const verifierModule = exactGhcrBoundHelperModule();
  const node = exactToolBinary("node");
  return {
    version: 2,
    platform: `${platform()}/${arch()}`,
    provider: {
      name: "gh",
      version: githubCliVersion,
      sha256: hashArtifact(readFileSync(gh)),
      configDigest: githubConfigDigest(ghConfigRoot),
      authenticationSource: "keyring",
      protocol: "operator-stdin-keyring-readback-v2",
      statusCommand: [
        "auth",
        "status",
        "--active",
        "--hostname",
        "github.com",
        "--json",
        "hosts",
      ],
      keyringReadCommand: [
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        "<receipt-username>",
      ],
      userCommand: ["api", "/user", "--jq", ".login"],
      membershipCommand: [
        "api",
        "/user/memberships/orgs/withAutograph",
        "--jq",
        "[.state,.role,.organization.login] | @tsv",
      ],
    },
    consumers: {
      dockerSha256: hashArtifact(readFileSync(exactToolBinary("docker"))),
      buildxSha256: hashArtifact(
        readFileSync(exactToolBinary("docker-buildx")),
      ),
    },
    dockerConfig: {
      sha256: hashArtifact(ghcrDockerConfigBytes),
      providerName: "ghcr-bound",
    },
    verifier: {
      wrapperSha256: hashArtifact(ghcrBoundHelperBytes),
      moduleSha256: hashArtifact(readFileSync(verifierModule)),
      nodeSha256: hashArtifact(readFileSync(node)),
    },
  };
}

export function ghcrCredentialEnvironment(
  stateRoot: string,
  identity?: Readonly<{
    username: string;
    digest: string;
    provenanceDigest: string;
  }>,
): Readonly<Record<string, string>> {
  const gh = exactGithubCli();
  const ghConfigRoot = exactGithubConfigRoot();
  ensureGhcrDockerConfig(stateRoot);
  ensureGhcrBoundHelper(stateRoot);
  const environment: Record<string, string> = {
    PATH: `${stateRoot}:/usr/bin:/bin`,
    DOCKER_CONFIG: stateRoot,
    APP_BUILDER_IMAGE_NODE_BIN: exactToolBinary("node"),
    APP_BUILDER_IMAGE_GH_BIN: gh,
    APP_BUILDER_IMAGE_GHCR_BOUND_HELPER_MODULE: exactGhcrBoundHelperModule(),
    APP_BUILDER_GH_SHA256: hashArtifact(readFileSync(gh)),
    APP_BUILDER_GH_CONFIG_DIR: ghConfigRoot,
    APP_BUILDER_GH_CONFIG_DIGEST: githubConfigDigest(ghConfigRoot),
  };
  if (identity !== undefined) {
    environment.APP_BUILDER_GHCR_USERNAME = identity.username;
    environment.APP_BUILDER_GHCR_IDENTITY_DIGEST = identity.digest;
    environment.APP_BUILDER_GHCR_PROVENANCE_DIGEST = identity.provenanceDigest;
  }
  return environment;
}

function requireCurrentGhcrLogin(provenance: ImageProvenance): Readonly<{
  receipt: ReceiptEnvelope;
  binding: GhcrCredentialBinding;
  identity: Readonly<{
    username: string;
    digest: string;
    provenanceDigest: string;
  }>;
}> {
  const receipt = readReceipt(
    provenance.builder.stateRoot,
    "ghcr-login-receipt.json",
    "ghcr-login",
    provenance,
  );
  const binding = currentGhcrCredentialBinding(provenance.builder.stateRoot);
  const result = receipt.result;
  const expectedResultKeys = [
    "authenticationBoundary",
    "authenticationBoundaryDigest",
    "authenticationProvider",
    "identityDigest",
    "keyringReadbackTransport",
    "operatorApprovalTransport",
    "providerMutation",
    "provenanceDigest",
    "registry",
    "schema",
    "status",
    "username",
  ].join(",");
  if (
    typeof result !== "object" ||
    result === null ||
    Object.keys(result).sort().join(",") !== expectedResultKeys ||
    (result as { status?: unknown }).status !== "credential-matched" ||
    (result as { registry?: unknown }).registry !== "ghcr.io" ||
    (result as { schema?: unknown }).schema !== "ghcr-login-v2" ||
    (result as { authenticationProvider?: unknown }).authenticationProvider !==
      `gh@${githubCliVersion}-keyring` ||
    (result as { operatorApprovalTransport?: unknown })
      .operatorApprovalTransport !== "one-time-stdin" ||
    (result as { keyringReadbackTransport?: unknown })
      .keyringReadbackTransport !== "github-cli-keyring" ||
    (result as { providerMutation?: unknown }).providerMutation !== "none" ||
    (result as { provenanceDigest?: unknown }).provenanceDigest !==
      provenance.digest ||
    (result as { authenticationBoundaryDigest?: unknown })
      .authenticationBoundaryDigest !== hashArtifact(JSON.stringify(binding)) ||
    JSON.stringify(
      (result as { authenticationBoundary?: unknown }).authenticationBoundary,
    ) !== JSON.stringify(binding) ||
    typeof (result as { username?: unknown }).username !== "string" ||
    !/^[a-f0-9]{64}$/u.test(
      String((result as { identityDigest?: unknown }).identityDigest),
    )
  )
    throw new Error(
      "GHCR login receipt does not match the current credential boundary.",
    );
  const username = (result as { username: string }).username;
  assertGhcrUsername(username);
  return {
    receipt,
    binding,
    identity: {
      username,
      digest: String((result as { identityDigest: string }).identityDigest),
      provenanceDigest: provenance.digest,
    },
  };
}

function readGhcrTokenFromStdin(): Buffer {
  const input = readBoundedInput(0, 4096);
  try {
    let end = input.length;
    if (end > 0 && input[end - 1] === 0x0a) end -= 1;
    if (end > 0 && input[end - 1] === 0x0d) end -= 1;
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
}

async function verifyGhcrLoginWithOwnedProcessGroup(
  provenance: ImageProvenance,
  identity: Readonly<{
    username: string;
    digest: string;
    provenanceDigest: string;
  }>,
  token: Buffer,
): Promise<string> {
  const detached = platform() !== "win32";
  const child = spawn(
    ghcrBoundHelperPath(provenance.builder.stateRoot),
    ["verify-login"],
    {
      cwd: provenance.builder.root,
      detached,
      env: sanitizedEnvironment(
        ghcrCredentialEnvironment(provenance.builder.stateRoot, identity),
      ),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  let timedOut = false;
  const terminate = () => {
    if (child.pid === undefined) return;
    try {
      if (detached) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
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
    } else target.push(copy);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
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
    const status = await new Promise<number>((resolveStatus) => {
      child.once("error", () => resolveStatus(-1));
      child.once("close", (code) => resolveStatus(code ?? -1));
    });
    if (failed || timedOut || status !== 0)
      throw new Error(
        "GitHub keyring verification failed without recording credential output.",
      );
    return Buffer.concat(stdout).toString("utf8");
  } finally {
    clearTimeout(timeout);
    for (const chunk of stdout) chunk.fill(0);
    for (const chunk of stderr) chunk.fill(0);
  }
}

function execute(
  command: CommandSpec,
  cwd: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): string {
  const tool = command.program as ImageTool;
  const binary = exactToolBinary(tool);
  const versionCommand = imageToolVersionCommand(tool);
  const version = spawnSync(binary, [...versionCommand.args], {
    cwd,
    encoding: "utf8",
    maxBuffer: maximumCommandOutputBytes,
    env: sanitizedEnvironment(),
  });
  if (version.error !== undefined || version.status !== 0)
    throw new Error(`${tool} version inspection failed.`);
  assertExactImageToolVersion(tool, version.stdout);
  const result = spawnSync(binary, [...command.args], {
    cwd,
    encoding: "utf8",
    maxBuffer: maximumCommandOutputBytes,
    env: sanitizedEnvironment({
      ...(command.environment ?? {}),
      ...extraEnvironment,
    }),
  });
  if (result.error !== undefined) throw result.error;
  if (
    Buffer.byteLength(result.stdout) > maximumCommandOutputBytes ||
    Buffer.byteLength(result.stderr) > maximumCommandOutputBytes
  )
    throw new Error(
      `${command.program} lifecycle command output was too large.`,
    );
  if (result.status !== 0)
    throw new Error(
      `${command.program} lifecycle command failed with exit code ${result.status ?? "unknown"}.`,
    );
  return result.stdout;
}

function verifyImageSourcesUnlocked(approval: LifecycleApproval) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    "source-receipt.json",
    "image-source",
    provenance,
  );
  if (existing !== undefined) return existing;
  return writeReceipt(
    provenance.builder.stateRoot,
    "source-receipt.json",
    "image-source",
    provenance,
    { status: "verified" },
  );
}

function buildImageUnlocked(approval: LifecycleApproval) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    "build-receipt.json",
    "image-build",
    provenance,
  );
  if (existing !== undefined) return existing;
  readReceipt(
    provenance.builder.stateRoot,
    "source-receipt.json",
    "image-source",
    provenance,
  );
  const context = materializeSanitizedGitTree(
    provenance.arrusted.root,
    join(
      provenance.builder.stateRoot,
      `arrusted-context.tmp-${process.pid}-${randomUUID()}`,
    ),
    provenance.arrusted.commit,
    provenance.arrusted.tree,
  );
  try {
    execute(
      imageBuildCommand(provenance, context.root),
      provenance.builder.root,
    );
  } finally {
    removeSanitizedGitTree(context);
  }
  return writeReceipt(
    provenance.builder.stateRoot,
    "build-receipt.json",
    "image-build",
    provenance,
    {
      status: "built",
      tag: provenance.image.tag,
      sanitizedContextEntriesDigest: context.entriesDigest,
      sanitizedContextEntryCount: context.entryCount,
      gitMetadataIncluded: false,
    },
  );
}

function inspectLocalImageUnlocked(approval: LifecycleApproval) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    "local-image-receipt.json",
    "local-image",
    provenance,
  );
  if (existing !== undefined) return existing;
  readReceipt(
    provenance.builder.stateRoot,
    "build-receipt.json",
    "image-build",
    provenance,
  );
  const result = parseLocalImageInspection(
    execute(localImageInspectionCommand(provenance), provenance.builder.root),
    provenance,
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    "local-image-receipt.json",
    "local-image",
    provenance,
    result,
  );
}

function pushImageUnlocked(approval: LifecycleApproval) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    "push-receipt.json",
    "image-push",
    provenance,
  );
  if (existing !== undefined) return existing;
  const login = requireCurrentGhcrLogin(provenance);
  const local = readReceipt(
    provenance.builder.stateRoot,
    "local-image-receipt.json",
    "local-image",
    provenance,
  );
  execute(
    imagePushCommand(provenance),
    provenance.builder.root,
    ghcrCredentialEnvironment(provenance.builder.stateRoot, login.identity),
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    "push-receipt.json",
    "image-push",
    provenance,
    {
      status: "pushed",
      tag: provenance.image.tag,
      localImageReceiptDigest: local.digest,
      ghcrLoginReceiptDigest: login.receipt.digest,
    },
  );
}

async function loginGhcrUnlocked(
  approval: LifecycleApproval,
  username: string,
) {
  const provenance = observeImageProvenance(approval);
  readReceipt(
    provenance.builder.stateRoot,
    "source-receipt.json",
    "image-source",
    provenance,
  );
  assertGhcrUsername(username);
  const binding = currentGhcrCredentialBinding(provenance.builder.stateRoot);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    "ghcr-login-receipt.json",
    "ghcr-login",
    provenance,
  );
  if (existing !== undefined) {
    const current = requireCurrentGhcrLogin(provenance);
    if (current.identity.username !== username)
      throw new Error("Existing GHCR login receipt names another identity.");
    return current.receipt;
  }
  const token = readGhcrTokenFromStdin();
  try {
    const identityDigest = ghcrIdentityDigest(
      username,
      provenance.digest,
      token,
    );
    const identity = {
      username,
      digest: identityDigest,
      provenanceDigest: provenance.digest,
    };
    const result = await verifyGhcrLoginWithOwnedProcessGroup(
      provenance,
      identity,
      token,
    );
    assertVerifiedGhcrLoginPayload(
      result,
      username,
      provenance.digest,
      identityDigest,
    );
    return writeReceipt(
      provenance.builder.stateRoot,
      "ghcr-login-receipt.json",
      "ghcr-login",
      provenance,
      {
        schema: "ghcr-login-v2",
        status: "credential-matched",
        registry: "ghcr.io",
        username,
        authenticationProvider: `gh@${githubCliVersion}-keyring`,
        operatorApprovalTransport: "one-time-stdin",
        keyringReadbackTransport: "github-cli-keyring",
        providerMutation: "none",
        authenticationBoundary: binding,
        authenticationBoundaryDigest: hashArtifact(JSON.stringify(binding)),
        identityDigest,
        provenanceDigest: provenance.digest,
      },
    );
  } finally {
    token.fill(0);
  }
}

function inspectRemoteImageUnlocked(approval: LifecycleApproval) {
  const provenance = observeImageProvenance(approval);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    "remote-image-receipt.json",
    "remote-image",
    provenance,
  );
  if (existing !== undefined) return existing;
  const local = readReceipt(
    provenance.builder.stateRoot,
    "local-image-receipt.json",
    "local-image",
    provenance,
  );
  const push = readReceipt(
    provenance.builder.stateRoot,
    "push-receipt.json",
    "image-push",
    provenance,
  );
  const login = requireCurrentGhcrLogin(provenance);
  if (
    typeof push.result !== "object" ||
    push.result === null ||
    (push.result as { localImageReceiptDigest?: unknown })
      .localImageReceiptDigest !== local.digest ||
    (push.result as { ghcrLoginReceiptDigest?: unknown })
      .ghcrLoginReceiptDigest !== login.receipt.digest
  )
    throw new Error(
      "Image push receipt is not bound to the local image identity.",
    );
  if (typeof local.result !== "object" || local.result === null)
    throw new Error("Local image receipt has no exact image identity.");
  const result = parseRemoteImageInspection(
    execute(
      remoteDescriptorCommand(provenance),
      provenance.builder.root,
      ghcrCredentialEnvironment(provenance.builder.stateRoot, login.identity),
    ),
    execute(
      remoteManifestCommand(provenance),
      provenance.builder.root,
      ghcrCredentialEnvironment(provenance.builder.stateRoot, login.identity),
    ),
    execute(
      remoteImageCommand(provenance),
      provenance.builder.root,
      ghcrCredentialEnvironment(provenance.builder.stateRoot, login.identity),
    ),
    provenance,
    local.result as { imageId: string; rootFsLayers: readonly string[] },
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    "remote-image-receipt.json",
    "remote-image",
    provenance,
    result,
  );
}

function preloadImageUnlocked(
  approval: LifecycleApproval,
  digestReferenceInput: string,
) {
  const provenance = observeImageProvenance(approval);
  const reference = exactDigestReference(digestReferenceInput);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    "preload-receipt.json",
    "image-preload",
    provenance,
  );
  if (existing !== undefined) {
    if (
      typeof existing.result !== "object" ||
      existing.result === null ||
      (existing.result as { reference?: unknown }).reference !== reference
    )
      throw new Error("Existing preload receipt names another digest.");
    return existing;
  }
  const remote = readReceipt(
    provenance.builder.stateRoot,
    "remote-image-receipt.json",
    "remote-image",
    provenance,
  );
  if (
    typeof remote.result !== "object" ||
    remote.result === null ||
    (remote.result as { reference?: unknown }).reference !== reference
  )
    throw new Error("Digest-only preload does not match remote readback.");
  execute(imagePreloadCommand(reference), provenance.builder.root);
  return writeReceipt(
    provenance.builder.stateRoot,
    "preload-receipt.json",
    "image-preload",
    provenance,
    { status: "preloaded", reference },
  );
}

type ProofRuntimeResult = Readonly<{
  status: "prepared";
  pnpmLockSha256: string;
  dependencyTreeSha256: string;
  nodeModulesTreeSha256: string;
  ignoredInventory: "node_modules/";
}>;

function observeProofRuntime(
  approval: LifecycleApproval,
): Readonly<{ provenance: ImageProvenance; result: ProofRuntimeResult }> {
  const provenance = observeImageProvenance(approval, process.cwd(), {
    allowProofRuntime: true,
  });
  const result: ProofRuntimeResult = {
    status: "prepared",
    pnpmLockSha256: hashArtifact(
      readFileSync(join(provenance.builder.root, "pnpm-lock.yaml")),
    ),
    dependencyTreeSha256: hashArtifact(
      execute(inspectProofRuntimeCommand(), provenance.builder.root),
    ),
    nodeModulesTreeSha256: normalizedNodeModulesDigest(
      join(provenance.builder.root, "node_modules"),
    ),
    ignoredInventory: "node_modules/",
  };
  assertNoSecretMaterial(result);
  return { provenance, result };
}

function prepareProofRuntimeUnlocked(approval: LifecycleApproval) {
  const builderRoot = process.cwd();
  const nodeModules = join(builderRoot, "node_modules");
  if (existsSync(nodeModules)) {
    const current = observeProofRuntime(approval);
    readReceipt(
      current.provenance.builder.stateRoot,
      "source-receipt.json",
      "image-source",
      current.provenance,
    );
    const existing = optionalReceipt(
      current.provenance.builder.stateRoot,
      "proof-runtime-receipt.json",
      "proof-runtime",
      current.provenance,
    );
    if (existing !== undefined) {
      if (JSON.stringify(existing.result) !== JSON.stringify(current.result))
        throw new Error(
          "Existing proof runtime receipt does not match actual dependency bytes.",
        );
      return existing;
    }
  } else {
    const clean = observeImageProvenance(approval);
    readReceipt(
      clean.builder.stateRoot,
      "source-receipt.json",
      "image-source",
      clean,
    );
  }
  execute(prepareProofRuntimeCommand(), builderRoot);
  const { provenance, result } = observeProofRuntime(approval);
  readReceipt(
    provenance.builder.stateRoot,
    "source-receipt.json",
    "image-source",
    provenance,
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    "proof-runtime-receipt.json",
    "proof-runtime",
    provenance,
    result,
  );
}

function requireCurrentProofRuntime(
  approval: LifecycleApproval,
): Readonly<{ provenance: ImageProvenance; receipt: ReceiptEnvelope }> {
  const { provenance, result } = observeProofRuntime(approval);
  const receipt = readReceipt(
    provenance.builder.stateRoot,
    "proof-runtime-receipt.json",
    "proof-runtime",
    provenance,
  );
  if (JSON.stringify(receipt.result) !== JSON.stringify(result))
    throw new Error(
      "Proof runtime dependency state drifted after its frozen-install receipt.",
    );
  return { provenance, receipt };
}

function proveSandboxImageUnlocked(
  approval: LifecycleApproval,
  digestReferenceInput: string,
) {
  const { provenance, receipt: proofRuntime } =
    requireCurrentProofRuntime(approval);
  const reference = exactDigestReference(digestReferenceInput);
  const existing = optionalReceipt(
    provenance.builder.stateRoot,
    "sandbox-proof-receipt.json",
    "sandbox-proof",
    provenance,
  );
  if (existing !== undefined) {
    if (
      typeof existing.result !== "object" ||
      existing.result === null ||
      (existing.result as { reference?: unknown }).reference !== reference ||
      (existing.result as { proofRuntimeReceiptDigest?: unknown })
        .proofRuntimeReceiptDigest !== proofRuntime.digest
    )
      throw new Error(
        "Existing sandbox proof does not match the current digest-bound proof runtime.",
      );
    return existing;
  }
  const preload = readReceipt(
    provenance.builder.stateRoot,
    "preload-receipt.json",
    "image-preload",
    provenance,
  );
  if (
    typeof preload.result !== "object" ||
    preload.result === null ||
    (preload.result as { reference?: unknown }).reference !== reference
  )
    throw new Error("Sandbox proof does not match the preloaded digest.");
  execute(
    sandboxProofCommand(reference, provenance.arrusted.root),
    provenance.builder.root,
  );
  return writeReceipt(
    provenance.builder.stateRoot,
    "sandbox-proof-receipt.json",
    "sandbox-proof",
    provenance,
    {
      status: "passed",
      reference,
      readOnly: true,
      scope: "typed-identity-and-planning",
      terminalPhase: "planned",
      proofRuntimeReceiptDigest: proofRuntime.digest,
    },
  );
}

const locked = <T>(approval: LifecycleApproval, operation: () => T) =>
  withLifecycleLock(approval.stateRoot, () => {
    assertLifecycleStateScope(approval);
    reconcileLifecycleTemps(approval.stateRoot);
    return operation();
  });

export const verifyImageSources = (approval: LifecycleApproval) =>
  locked(approval, () => verifyImageSourcesUnlocked(approval));
export const buildImage = (approval: LifecycleApproval) =>
  locked(approval, () => buildImageUnlocked(approval));
export const inspectLocalImage = (approval: LifecycleApproval) =>
  locked(approval, () => inspectLocalImageUnlocked(approval));
export const loginGhcr = (approval: LifecycleApproval, username: string) =>
  locked(approval, () => loginGhcrUnlocked(approval, username));
export const pushImage = (approval: LifecycleApproval) =>
  locked(approval, () => pushImageUnlocked(approval));
export const inspectRemoteImage = (approval: LifecycleApproval) =>
  locked(approval, () => inspectRemoteImageUnlocked(approval));
export const preloadImage = (
  approval: LifecycleApproval,
  digestReferenceInput: string,
) =>
  locked(approval, () => preloadImageUnlocked(approval, digestReferenceInput));
export const prepareProofRuntime = (approval: LifecycleApproval) =>
  locked(approval, () => prepareProofRuntimeUnlocked(approval));
export const proveSandboxImage = (
  approval: LifecycleApproval,
  digestReferenceInput: string,
) =>
  locked(approval, () =>
    proveSandboxImageUnlocked(approval, digestReferenceInput),
  );
