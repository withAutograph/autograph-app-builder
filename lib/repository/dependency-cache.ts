import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import {
  HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT,
  HOSTED_MISE_VERSION,
  HOSTED_NODE_VERSION,
} from "../sandbox/hosted-toolchain";
import {
  DEVELOPMENT_DEPENDENCY_CACHE_ROOT,
  developmentDependencySymlinkScript,
} from "../sandbox/development-toolchain";
import { hasTestCapability } from "../testing/test-capability";
import { safeSourcePath } from "./source-path";

export const ARRUSTED_TARGET_SHA = "d378904a05e1bc2c0896886e6fbd3b816babaee2";
export const ARRUSTED_TARGET_TREE = "6735f4b45cc2b29a139531a41dac990c925e0d39";
export const ARRUSTED_BUN_VERSION = "1.3.14";
export const ARRUSTED_RUST_VERSION = "1.97.1";
export const ARRUSTED_MICROFRONTENDS_VERSION = "2.4.0";
export const ARRUSTED_PATH_TO_REGEXP_VERSION = "8.4.2";
export const ARRUSTED_MICROFRONTENDS_PATH_TO_REGEXP_VERSION = "6.3.0";
export const ARRUSTED_APP_VALIDATION_SHA256 =
  "db6cac93c5a89ba26db8274312959114d674ec1901ee9fcd93ab9d6ef2c503a5";
export const ARRUSTED_CREATE_APP_SHA256 =
  "357d18e3cb355736638ed087355739858da59cf7c43dc09755ac1c589a4397ff";
export const ARRUSTED_APP_TEMPLATE_PACKAGE_SHA256 =
  "c7cb64a189e464abd5f1825db52dcdac62c3898940826d9ae49553291d35d762";

export const DEPENDENCY_CACHE_MANIFEST_PATH =
  "/opt/app-builder/dependency-cache/manifest.json";
export const DEPENDENCY_CACHE_ARCHIVE_PATH =
  "/opt/app-builder/dependency-cache/node-modules.tar.gz";
export const DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH =
  "/opt/app-builder/dependency-cache/cargo-closure.tar.gz";
export const DEPENDENCY_CACHE_EXTRACTED_ROOT = "/opt/app-builder/dependencies";
export const DEPENDENCY_CACHE_TIMEOUT_MS = 30_000;
// A cold, frozen Bun + Cargo closure can exceed two minutes in Vercel
// Sandbox. Keep this below the backend's 15-minute session ceiling while
// preserving a hard bound for the one-time preparation path.
export const DEPENDENCY_PREPARATION_TIMEOUT_MS = 600_000;
export const DEPENDENCY_CACHE_OUTPUT_BYTES = 262_144;
export const LIVE_TEMPLATE_DEPENDENCY_CACHE_ROOT =
  ".app-builder/template-dependency-cache";
export const LIVE_TEMPLATE_DEPENDENCY_BOOTSTRAP_VERSION = 3;
const DEVELOPMENT_TOOLCHAIN_PATH =
  "/workspace/.app-builder/toolchain/bin:/workspace/.app-builder/toolchain/rust/bin:/usr/bin:/bin";
const DEVELOPMENT_CARGO_HOME = "/workspace/.app-builder/toolchain/cargo-home";
const DEVELOPMENT_CARGO_CONFIG =
  `${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/config.toml`;

const REQUIRED_EXECUTION_PACKAGES = [
  ".bin/next",
  ".bin/turbo",
  ".bin/vp",
  "@autograph/vite-config/package.json",
  "@tailwindcss/vite/package.json",
  "@testing-library/react/package.json",
  "@vercel/microfrontends/package.json",
  "@vitejs/plugin-react/package.json",
  "next/package.json",
  "react/package.json",
  "react-dom/package.json",
  "typescript/package.json",
  "turbo/package.json",
  "vite-plus/package.json",
  "vitest/package.json",
] as const;

const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/u);
const dependencyDigest = z.union([sha256Digest, z.literal("absent")]);
const liveTemplatePlatformSchema = z.union([
  z.literal("linux/arm64"),
  z.literal("linux/x86_64"),
]);

const dependencyCacheManifestShapeSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal("builder-execution"),
  platform: z.union([
    z.literal("linux/arm64"),
    z.literal("linux/x86_64"),
    z.literal("linux/portable"),
  ]),
  target: z.strictObject({
    sha: gitObjectId,
    tree: gitObjectId,
    miseConfigSha256: z.literal(
      "da8fe48559f8250494bdbea0f1a6caa644b59d5be14658a7aaf26ccd6fab0199",
    ),
    miseLockSha256: z.literal(
      "415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462",
    ),
    bunLockSha256: z.literal(
      "e313e11efc00e7439a6e91f832c80508a6b15cacda267b86a152f76aa5ad4dd0",
    ),
    cargoLockSha256: z.literal(
      "8ba85741c6021d44cb8f211939f3b0488db22a7b0e11a1d703eccb2d31e259cb",
    ),
    appIdentitySha256: z.literal(
      "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
    ),
    appContractSha256: z.literal(
      "03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e",
    ),
    appValidationSha256: z.literal(ARRUSTED_APP_VALIDATION_SHA256),
    createAppSha256: z.literal(ARRUSTED_CREATE_APP_SHA256),
    appTemplatePackageSha256: z.literal(ARRUSTED_APP_TEMPLATE_PACKAGE_SHA256),
    repositoryPreflightSha256: z.literal(
      "c30fb6d26d49a229d8e4283c1350d86fa61a6f1708ada614f55f8f40358cbbba",
    ),
    repositoryExecSha256: z.literal(
      "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
    ),
  }),
  runtime: z.strictObject({
    bun: z.literal(ARRUSTED_BUN_VERSION),
    rust: z.literal(ARRUSTED_RUST_VERSION),
  }),
  closure: z.strictObject({
    package: z.literal("@vercel/microfrontends"),
    version: z.literal(ARRUSTED_MICROFRONTENDS_VERSION),
    archivePath: z.literal(DEPENDENCY_CACHE_ARCHIVE_PATH),
    archiveSha256: sha256Digest,
    archiveBytes: z.number().int().positive(),
    cargoArchivePath: z.literal(DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH),
    cargoArchiveSha256: sha256Digest,
    cargoArchiveBytes: z.number().int().positive(),
  }),
});

export const hostedExecutionDependencyCacheManifestSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal("builder-execution"),
  platform: z.literal("linux/x86_64"),
  target: z.strictObject({
    sha: z.literal(ARRUSTED_TARGET_SHA),
    tree: z.literal(ARRUSTED_TARGET_TREE),
    miseConfigSha256: z.literal(
      "da8fe48559f8250494bdbea0f1a6caa644b59d5be14658a7aaf26ccd6fab0199",
    ),
    miseLockSha256: z.literal(
      "415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462",
    ),
    bunLockSha256: z.literal(
      "e313e11efc00e7439a6e91f832c80508a6b15cacda267b86a152f76aa5ad4dd0",
    ),
    appIdentitySha256: z.literal(
      "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
    ),
    appContractSha256: z.literal(
      "03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e",
    ),
    repositoryPreflightSha256: z.literal(
      "c30fb6d26d49a229d8e4283c1350d86fa61a6f1708ada614f55f8f40358cbbba",
    ),
    repositoryExecSha256: z.literal(
      "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
    ),
  }),
  runtime: z.strictObject({ bun: z.literal(ARRUSTED_BUN_VERSION) }),
  closure: z.strictObject({
    package: z.literal("@vercel/microfrontends"),
    version: z.literal(ARRUSTED_MICROFRONTENDS_VERSION),
    archivePath: z.literal(DEPENDENCY_CACHE_ARCHIVE_PATH),
    archiveSha256: sha256Digest,
    archiveBytes: z.number().int().positive(),
  }),
});

export const developmentDependencyCacheManifestSchema = z.strictObject({
  version: z.literal(2),
  scope: z.literal("development-execution"),
  platform: z.union([z.literal("linux/arm64"), z.literal("linux/amd64")]),
  dependencyKey: sha256Digest,
  lockfiles: z.strictObject({
    ".config/mise/config.toml": dependencyDigest,
    ".config/mise/mise.lock": dependencyDigest,
    "bun.lock": dependencyDigest,
    "Cargo.lock": dependencyDigest,
  }),
  runtime: z.strictObject({
    node: z.literal("24.18.0"),
    bun: z.literal(ARRUSTED_BUN_VERSION),
    mise: z.literal("2026.8.12"),
    rust: z.literal(ARRUSTED_RUST_VERSION),
  }),
  closure: z.strictObject({
    package: z.literal("@vercel/microfrontends"),
    version: z.literal(ARRUSTED_MICROFRONTENDS_VERSION),
    archivePath: z.literal(
      `${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/node-modules.tar.gz`,
    ),
    archiveSha256: sha256Digest,
    archiveBytes: z.number().int().positive(),
    cargoArchivePath: z.literal(
      `${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo-closure.tar.gz`,
    ),
    cargoArchiveSha256: sha256Digest,
    cargoArchiveBytes: z.number().int().positive(),
  }),
});

const requiredLiveTemplateDependencyInputs = [
  ".config/mise/config.toml",
  ".config/mise/mise.lock",
  "package.json",
  "bun.lock",
  "Cargo.toml",
  "Cargo.lock",
] as const;

const liveTemplateDependencyInputsSchema = z
  .record(z.string(), sha256Digest)
  .refine(
    (inputs) =>
      requiredLiveTemplateDependencyInputs.every(
        (path) => inputs[path] !== undefined,
      ),
    "required dependency inputs are missing",
  );

const cacheSourcePathSchema = z.string().refine(safeSourcePath);
const liveTemplateNodeModulesPathSchema = z
  .string()
  .regex(
    /^\/workspace\/\.app-builder\/template-dependency-cache\/[0-9a-f]{64}\/linux\/(?:arm64|x86_64)\/source\/(?:node_modules|.+\/node_modules)$/u,
  )
  .refine((value) => !value.includes("/../"));
const workspaceDependencyRootSchema = z.strictObject({
  path: cacheSourcePathSchema.refine(
    (value) => value === "node_modules" || value.endsWith("/node_modules"),
  ),
  nodeModulesPath: liveTemplateNodeModulesPathSchema,
  digest: sha256Digest,
});
const workspaceDependencyLinkSchema = z.strictObject({
  path: cacheSourcePathSchema,
  target: z.string().min(1).max(4096),
  sourcePath: cacheSourcePathSchema,
});

const liveTemplateDependencyCacheManifestSchema = z.strictObject({
  version: z.literal(4),
  scope: z.literal("live-template-execution"),
  platform: z.union([z.literal("linux/arm64"), z.literal("linux/x86_64")]),
  dependencyKey: sha256Digest,
  dependencyInputs: liveTemplateDependencyInputsSchema,
  runtime: z.strictObject({
    node: z.literal(HOSTED_NODE_VERSION),
    mise: z.literal(HOSTED_MISE_VERSION),
    bun: z.literal(ARRUSTED_BUN_VERSION),
    rust: z.literal(ARRUSTED_RUST_VERSION),
  }),
  bootstrapVersion: z.literal(LIVE_TEMPLATE_DEPENDENCY_BOOTSTRAP_VERSION),
  closure: z.strictObject({
    nodeModulesPath: liveTemplateNodeModulesPathSchema,
    nodeModulesDigest: sha256Digest,
    workspaceNodeModules: z.array(workspaceDependencyRootSchema),
    workspaceLinks: z.array(workspaceDependencyLinkSchema),
    cargoHomePath: z
      .string()
      .regex(
        /^\/workspace\/\.app-builder\/template-dependency-cache\/[0-9a-f]{64}\/linux\/(?:arm64|x86_64)\/cargo-home$/u,
      ),
    cargoHomeDigest: sha256Digest,
    microfrontendsVersion: z.string().min(1),
  }),
});

export const dependencyCacheManifestSchema =
  dependencyCacheManifestShapeSchema.refine(
    ({ target }) =>
      target.sha === ARRUSTED_TARGET_SHA &&
      target.tree === ARRUSTED_TARGET_TREE,
    "dependency target does not match the committed source binding",
  );

export type DependencyCacheManifest =
  | z.infer<typeof dependencyCacheManifestShapeSchema>
  | z.infer<typeof hostedExecutionDependencyCacheManifestSchema>
  | z.infer<typeof developmentDependencyCacheManifestSchema>
  | z.infer<typeof liveTemplateDependencyCacheManifestSchema>;

export type ObservedDependencyCache = {
  manifest: DependencyCacheManifest;
  manifestDigest: string;
  contentDigest: string;
};

const executionDependencyRootSchema = z.strictObject({
  path: cacheSourcePathSchema.refine(
    (value) => value === "node_modules" || value.endsWith("/node_modules"),
  ),
  cachePath: z
    .string()
    .regex(
      /^(?:\/opt\/app-builder\/dependencies\/[0-9a-f]{64}\/node_modules|\/workspace\/\.app-builder\/dependency-cache\/dependencies\/[0-9a-f]{64}\/node_modules|\/workspace\/\.app-builder\/hosted-dependencies\/[0-9a-f]{64}\/node_modules|\/workspace\/\.app-builder\/template-dependency-cache\/[0-9a-f]{64}\/linux\/(?:arm64|x86_64)\/source\/(?:node_modules|.+\/node_modules))$/u,
    ),
  digest: sha256Digest,
});

export const executionDependencyLayoutSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("fixture"),
    roots: z.tuple([]),
    workspaceLinks: z.tuple([]),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("cache"),
    roots: z.array(executionDependencyRootSchema).min(1),
    workspaceLinks: z.array(workspaceDependencyLinkSchema),
  }),
]);

export type ExecutionDependencyLayout = z.infer<
  typeof executionDependencyLayoutSchema
>;

export class DependencyCacheMissingError extends Error {
  readonly code = "dependency_cache_missing" as const;

  constructor(message: string) {
    super(message);
    this.name = "DependencyCacheMissingError";
  }
}

export function shouldPreferLiveTemplateDependencies(
  _sourceReceiptVersion: number,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return environment.APP_BUILDER_EXECUTION_MODE !== "development";
}

type ExactSourceBinding = {
  sourceSha: string;
  sourceTree: string;
};

type ExactDependencyReceiptBinding = ExactSourceBinding & {
  sourceReceiptDigest: string;
  targetSha: string;
  targetTree: string;
};

export function assertExactDependencyTargetBinding(input: {
  workspace: ExactSourceBinding;
  sourceReceipt: ExactSourceBinding & { digest?: string };
  cache: ObservedDependencyCache;
  dependencyReceipt?: ExactDependencyReceiptBinding;
}): void {
  const target = dependencyTargetForWorkspace(input.cache, input.workspace);
  if (
    input.workspace.sourceSha !== input.sourceReceipt.sourceSha ||
    input.workspace.sourceTree !== input.sourceReceipt.sourceTree ||
    input.workspace.sourceSha !== target.sha ||
    input.workspace.sourceTree !== target.tree ||
    (input.dependencyReceipt !== undefined &&
      (input.dependencyReceipt.sourceSha !== input.workspace.sourceSha ||
        input.dependencyReceipt.sourceTree !== input.workspace.sourceTree ||
        input.sourceReceipt.digest === undefined ||
        input.dependencyReceipt.sourceReceiptDigest !==
          input.sourceReceipt.digest ||
        input.dependencyReceipt.targetSha !== target.sha ||
        input.dependencyReceipt.targetTree !== target.tree))
  )
    throw new Error(
      "The prepared source does not match the immutable dependency target.",
    );
}

export function dependencyTargetForWorkspace(
  cache: ObservedDependencyCache,
  workspace: ExactSourceBinding,
): { sha: string; tree: string } {
  return cache.manifest.scope === "development-execution" ||
    cache.manifest.scope === "live-template-execution"
    ? { sha: workspace.sourceSha, tree: workspace.sourceTree }
    : { sha: cache.manifest.target.sha, tree: cache.manifest.target.tree };
}

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function isLiveTemplateDependencyInputPath(path: string) {
  return (
    requiredLiveTemplateDependencyInputs.includes(
      path as (typeof requiredLiveTemplateDependencyInputs)[number],
    ) ||
    path.endsWith("/package.json") ||
    path.endsWith("/Cargo.toml") ||
    path === "bunfig.toml" ||
    path.endsWith("/bunfig.toml") ||
    path === "rust-toolchain.toml" ||
    path === ".cargo/config.toml"
  );
}

type LiveTemplateDependencyIdentity = Readonly<{
  platform: z.infer<typeof liveTemplatePlatformSchema>;
  dependencyKey: string;
  dependencyInputs: z.infer<typeof liveTemplateDependencyInputsSchema>;
  runtime: {
    node: typeof HOSTED_NODE_VERSION;
    mise: typeof HOSTED_MISE_VERSION;
    bun: typeof ARRUSTED_BUN_VERSION;
    rust: typeof ARRUSTED_RUST_VERSION;
  };
  bootstrapVersion: typeof LIVE_TEMPLATE_DEPENDENCY_BOOTSTRAP_VERSION;
}>;

export function liveTemplateDependencyKey(input: {
  platform: string;
  dependencyInputs: Readonly<Record<string, string>>;
  runtime: Readonly<Record<string, string>>;
  bootstrapVersion: number;
}) {
  return sha256(
    JSON.stringify({
      version: 1,
      platform: input.platform,
      dependencyInputs: Object.fromEntries(
        Object.entries(input.dependencyInputs).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      runtime: input.runtime,
      bootstrapVersion: input.bootstrapVersion,
    }),
  );
}

function liveTemplateManifestPath(
  dependencyKey: string,
  platform: z.infer<typeof liveTemplatePlatformSchema>,
) {
  return `${LIVE_TEMPLATE_DEPENDENCY_CACHE_ROOT}/${dependencyKey}/${platform}/manifest.json`;
}

export function dependencyCacheNodeModulesRoot(contentDigest: string): string {
  if (!sha256Digest.safeParse(contentDigest).success)
    throw new Error("The dependency cache content digest is invalid.");
  return `${DEPENDENCY_CACHE_EXTRACTED_ROOT}/${contentDigest}/node_modules`;
}

const fixtureDependencyCacheEnabled = (
  environment: Readonly<Record<string, string | undefined>>,
) => hasTestCapability("simulated-target", environment);

const hostedArtifactDependencyCacheEnabled = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  environment.APP_BUILDER_HOSTED_ARTIFACT_PROOF === "1" &&
  hasTestCapability("mock-model", environment);

const hostedSeedDependencyCacheEnabled = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  environment.VERCEL === "1" ||
  hostedArtifactDependencyCacheEnabled(environment);

const hostedWorkspaceDependencyExtractionEnabled = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  environment.VERCEL === "1" ||
  hostedArtifactDependencyCacheEnabled(environment);

export function materializedDependencyNodeModulesRoot(
  contentDigest: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (isDevelopmentExecution(environment))
    return `${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/dependencies/${contentDigest}/node_modules`;
  const immutableImageRoot = dependencyCacheNodeModulesRoot(contentDigest);
  if (hostedWorkspaceDependencyExtractionEnabled(environment))
    return `/workspace/.app-builder/hosted-dependencies/${contentDigest}/node_modules`;
  return immutableImageRoot;
}

export function dependencyExecutionLayout(
  observed: ObservedDependencyCache,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExecutionDependencyLayout {
  if (fixtureDependencyCacheEnabled(environment))
    return { version: 1, kind: "fixture", roots: [], workspaceLinks: [] };
  if (observed.manifest.scope === "live-template-execution") {
    return executionDependencyLayoutSchema.parse({
      version: 1,
      kind: "cache",
      roots: [
        {
          path: "node_modules",
          cachePath: observed.manifest.closure.nodeModulesPath,
          digest: observed.manifest.closure.nodeModulesDigest,
        },
        ...observed.manifest.closure.workspaceNodeModules.map((root) => ({
          path: root.path,
          cachePath: root.nodeModulesPath,
          digest: root.digest,
        })),
      ],
      workspaceLinks: observed.manifest.closure.workspaceLinks,
    });
  }
  return executionDependencyLayoutSchema.parse({
    version: 1,
    kind: "cache",
    roots: [
      {
        path: "node_modules",
        cachePath: materializedDependencyNodeModulesRoot(
          observed.contentDigest,
          environment,
        ),
        digest: observed.contentDigest,
      },
    ],
    workspaceLinks: [],
  });
}

export function executionDependencyLayoutDigest(
  layout: ExecutionDependencyLayout,
) {
  return sha256(JSON.stringify(executionDependencyLayoutSchema.parse(layout)));
}

export const executionDependencyViewScript = String.raw`
const fs = require("node:fs");
const path = require("node:path");

const [layoutPath, overlayRootInput, viewRootInput, workspaceRootInput = "/workspace"] = process.argv.slice(2);
const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
const requestedWorkspaceRoot = path.resolve(workspaceRootInput);
const workspaceRoot = fs.realpathSync(workspaceRootInput);
const safeRelative = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !path.isAbsolute(value) &&
  value !== ".." &&
  !value.startsWith(".." + path.sep) &&
  !value.split(/[\\/]/u).includes("..");
const contains = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
};
const canonicalWorkspaceChild = (candidate) => {
  const relative = path.relative(requestedWorkspaceRoot, path.resolve(candidate));
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) process.exit(1);
  return path.resolve(workspaceRoot, relative);
};
const overlayRoot = canonicalWorkspaceChild(overlayRootInput);
const viewRoot = canonicalWorkspaceChild(viewRootInput);
if (!layout || layout.version !== 1 || layout.kind !== "cache" || !Array.isArray(layout.roots) || layout.roots.length === 0 || !Array.isArray(layout.workspaceLinks)) process.exit(1);
if (!contains(workspaceRoot, overlayRoot) || !contains(path.join(workspaceRoot, ".app-builder/dependency-views"), viewRoot)) process.exit(1);
const rootByPath = new Map();
for (const root of layout.roots) {
  if (!safeRelative(root.path) || !(root.path === "node_modules" || root.path.endsWith("/node_modules")) || typeof root.cachePath !== "string" || !path.isAbsolute(root.cachePath)) process.exit(1);
  const stat = fs.lstatSync(root.cachePath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) process.exit(1);
  rootByPath.set(root.path, root);
}
if (rootByPath.size !== layout.roots.length || !rootByPath.has("node_modules")) process.exit(1);
const rootCache = rootByPath.get("node_modules").cachePath;
const sourceRoot = path.resolve(rootCache, "..");
for (const root of layout.roots) {
  if (path.resolve(sourceRoot, root.path) !== path.resolve(root.cachePath)) process.exit(1);
}
const workspaceLinks = new Map();
for (const link of layout.workspaceLinks) {
  if (!safeRelative(link.path) || !safeRelative(link.sourcePath) || typeof link.target !== "string" || link.target.length === 0 || link.target.length > 4096) process.exit(1);
  const owner = [...rootByPath.keys()].filter((rootPath) => link.path.startsWith(rootPath + "/")).sort((left, right) => right.length - left.length)[0];
  if (!owner || workspaceLinks.has(link.path)) process.exit(1);
  const cachedLink = path.resolve(sourceRoot, link.path);
  if (!contains(sourceRoot, cachedLink) || !fs.lstatSync(cachedLink).isSymbolicLink() || fs.readlinkSync(cachedLink) !== link.target) process.exit(1);
  if (fs.realpathSync(cachedLink) !== fs.realpathSync(path.resolve(sourceRoot, link.sourcePath))) process.exit(1);
  const overlayTarget = path.resolve(overlayRoot, link.sourcePath);
  if (!contains(overlayRoot, overlayTarget) || !fs.existsSync(overlayTarget)) process.exit(1);
  workspaceLinks.set(link.path, { ...link, overlayTarget });
}

fs.rmSync(viewRoot, { recursive: true, force: true });
fs.mkdirSync(viewRoot, { recursive: true, mode: 0o755 });
const populate = (cacheDirectory, viewDirectory, relativeDirectory) => {
  fs.mkdirSync(viewDirectory, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(cacheDirectory, { withFileTypes: true })) {
    const relative = relativeDirectory ? relativeDirectory + "/" + entry.name : entry.name;
    const cached = path.join(cacheDirectory, entry.name);
    const viewed = path.join(viewDirectory, entry.name);
    const workspace = workspaceLinks.get(relative);
    if (workspace) {
      fs.symlinkSync(workspace.overlayTarget, viewed);
      continue;
    }
    const hasWorkspaceDescendant = [...workspaceLinks.keys()].some((candidate) => candidate.startsWith(relative + "/"));
    if (hasWorkspaceDescendant) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) process.exit(1);
      populate(cached, viewed, relative);
      continue;
    }
    fs.symlinkSync(cached, viewed);
  }
};
for (const root of layout.roots) {
  const viewDependencyRoot = path.resolve(viewRoot, root.path);
  if (!contains(viewRoot, viewDependencyRoot)) process.exit(1);
  populate(root.cachePath, viewDependencyRoot, root.path);
  const overlayDependencyRoot = path.resolve(overlayRoot, root.path);
  if (!contains(overlayRoot, overlayDependencyRoot)) process.exit(1);
  fs.rmSync(overlayDependencyRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(overlayDependencyRoot), { recursive: true, mode: 0o755 });
  fs.symlinkSync(viewDependencyRoot, overlayDependencyRoot);
}
`;

export async function materializeExecutionDependencyView(input: {
  sandbox: SandboxSession;
  layout: ExecutionDependencyLayout;
  overlayRoot: string;
  viewKey: string;
}) {
  const layout = executionDependencyLayoutSchema.parse(input.layout);
  if (layout.kind === "fixture") return;
  if (!sha256Digest.safeParse(input.viewKey).success)
    throw new Error("The dependency view key is invalid.");
  if (!safeSourcePath(input.overlayRoot))
    throw new Error("The dependency overlay path is invalid.");
  const layoutDigest = executionDependencyLayoutDigest(layout);
  const layoutPath = `.app-builder/dependency-layouts/${layoutDigest}.json`;
  const viewRoot = `.app-builder/dependency-views/${layoutDigest}/${input.viewKey}`;
  await ensureSandboxDirectories(input.sandbox, [
    ".app-builder/dependency-layouts",
    `.app-builder/dependency-views/${layoutDigest}`,
  ]);
  await input.sandbox.writeTextFile({
    path: layoutPath,
    content: `${JSON.stringify(layout)}\n`,
  });
  const result = await input.sandbox.run({
    command: `node - '/workspace/${layoutPath}' '/workspace/${input.overlayRoot}' '/workspace/${viewRoot}' '/workspace' <<'NODE'\n${executionDependencyViewScript}\nNODE`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(DEPENDENCY_PREPARATION_TIMEOUT_MS),
  });
  boundedOutput(
    result.stdout,
    result.stderr,
    "Dependency view materialization",
  );
  if (result.exitCode !== 0)
    throw new Error("The dependency execution view could not be materialized.");
}

function isDevelopmentExecution(
  environment: Readonly<Record<string, string | undefined>>,
) {
  return environment.APP_BUILDER_EXECUTION_MODE === "development";
}

function dependencyCachePaths(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const root = isDevelopmentExecution(environment)
    ? DEVELOPMENT_DEPENDENCY_CACHE_ROOT
    : hostedArtifactDependencyCacheEnabled(environment)
    ? HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT
    : "/opt/app-builder/dependency-cache";
  return {
    manifest: `${root}/manifest.json`,
    archive: `${root}/node-modules.tar.gz`,
    cargoArchive: `${root}/cargo-closure.tar.gz`,
  };
}

function boundedOutput(stdout: string, stderr: string, label: string) {
  if (
    Buffer.byteLength(stdout) > DEPENDENCY_CACHE_OUTPUT_BYTES ||
    Buffer.byteLength(stderr) > DEPENDENCY_CACHE_OUTPUT_BYTES
  )
    throw new Error(`${label} output exceeded the fixed size limit.`);
}

function fixtureManifest(
  target: ExactSourceBinding = {
    sourceSha: ARRUSTED_TARGET_SHA,
    sourceTree: ARRUSTED_TARGET_TREE,
  },
): z.infer<typeof dependencyCacheManifestShapeSchema> {
  return {
    version: 1,
    scope: "builder-execution",
    platform: "linux/arm64",
    target: {
      sha: target.sourceSha,
      tree: target.sourceTree,
      miseConfigSha256:
        "da8fe48559f8250494bdbea0f1a6caa644b59d5be14658a7aaf26ccd6fab0199",
      miseLockSha256:
        "415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462",
      bunLockSha256:
        "e313e11efc00e7439a6e91f832c80508a6b15cacda267b86a152f76aa5ad4dd0",
      cargoLockSha256:
        "8ba85741c6021d44cb8f211939f3b0488db22a7b0e11a1d703eccb2d31e259cb",
      appIdentitySha256:
        "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
      appContractSha256:
        "03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e",
      appValidationSha256: ARRUSTED_APP_VALIDATION_SHA256,
      createAppSha256: ARRUSTED_CREATE_APP_SHA256,
      appTemplatePackageSha256: ARRUSTED_APP_TEMPLATE_PACKAGE_SHA256,
      repositoryPreflightSha256:
        "c30fb6d26d49a229d8e4283c1350d86fa61a6f1708ada614f55f8f40358cbbba",
      repositoryExecSha256:
        "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
    },
    runtime: {
      bun: ARRUSTED_BUN_VERSION,
      rust: ARRUSTED_RUST_VERSION,
    },
    closure: {
      package: "@vercel/microfrontends",
      version: ARRUSTED_MICROFRONTENDS_VERSION,
      archivePath: DEPENDENCY_CACHE_ARCHIVE_PATH,
      archiveSha256: "2".repeat(64),
      archiveBytes: 1,
      cargoArchivePath: DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH,
      cargoArchiveSha256: "3".repeat(64),
      cargoArchiveBytes: 1,
    },
  };
}

const liveTemplateClosureObservationSchema = z.strictObject({
  platform: liveTemplatePlatformSchema,
  nodeModulesDigest: sha256Digest,
  workspaceNodeModules: z.array(workspaceDependencyRootSchema),
  workspaceLinks: z.array(workspaceDependencyLinkSchema),
  cargoHomeDigest: sha256Digest,
  microfrontendsVersion: z.string().min(1),
});

const LIVE_TEMPLATE_BOOTSTRAP_HOSTS = [
  "github.com",
  "mise.jdx.dev",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
] as const;

function liveTemplateDependencyWorkspaceRoot(
  dependencyKey: string,
  platform: z.infer<typeof liveTemplatePlatformSchema>,
) {
  return `/workspace/${LIVE_TEMPLATE_DEPENDENCY_CACHE_ROOT}/${dependencyKey}/${platform}/source`;
}

function liveTemplateCargoHomeRoot(
  dependencyKey: string,
  platform: z.infer<typeof liveTemplatePlatformSchema>,
) {
  return `/workspace/${LIVE_TEMPLATE_DEPENDENCY_CACHE_ROOT}/${dependencyKey}/${platform}/cargo-home`;
}

export const liveTemplateClosureInspectionScript = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [sourceRootInput, cargoHomeInput, platform, sourceManifestPath] = process.argv.slice(2);
const sourceRoot = fs.realpathSync(sourceRootInput);
const cargoHomePath = fs.realpathSync(cargoHomeInput);
const contains = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
};
const relativeSourcePath = (candidate) => path.relative(sourceRoot, candidate).split(path.sep).join("/");
const manifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
if (!Array.isArray(manifest) || manifest.length === 0) process.exit(1);
const tracked = new Set(manifest.map((entry) => entry && entry.path));
if (tracked.size !== manifest.length || [...tracked].some((entry) => typeof entry !== "string")) process.exit(1);
const isTrackedWorkspacePath = (candidate) => {
  const relative = relativeSourcePath(candidate);
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return false;
  return tracked.has(relative) || [...tracked].some((entry) => entry.startsWith(relative + "/"));
};

const dependencyRoots = [];
const discoverRoots = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name === "node_modules") {
      dependencyRoots.push(absolute);
      continue;
    }
    discoverRoots(absolute);
  }
};
discoverRoots(sourceRoot);
dependencyRoots.sort((left, right) => {
  const leftPath = relativeSourcePath(left);
  const rightPath = relativeSourcePath(right);
  if (leftPath === "node_modules") return -1;
  if (rightPath === "node_modules") return 1;
  return leftPath.localeCompare(rightPath);
});
if (dependencyRoots.length === 0 || relativeSourcePath(dependencyRoots[0]) !== "node_modules") process.exit(1);

const workspaceLinks = new Map();
function digestTree(root, allowTrackedWorkspaceLinks) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o222) !== 0) process.exit(1);
  const hash = crypto.createHash("sha256");
  const visit = (directory, relativeDirectory = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relative = relativeDirectory ? relativeDirectory + "/" + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        if ((stat.mode & 0o222) !== 0) process.exit(1);
        hash.update("directory\0" + relative + "\0");
        visit(absolute, relative);
      } else if (stat.isFile()) {
        if ((stat.mode & 0o222) !== 0) process.exit(1);
        hash.update("file\0" + relative + "\0" + stat.size + "\0");
        hash.update(fs.readFileSync(absolute));
        hash.update("\0");
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        if (target.includes("/workspace/repository")) process.exit(1);
        let resolved;
        try {
          resolved = fs.realpathSync(absolute);
        } catch {
          process.exit(1);
        }
        if (!contains(allowTrackedWorkspaceLinks ? sourceRoot : root, resolved)) process.exit(1);
        const dependencyTarget = dependencyRoots.some((dependencyRoot) =>
          contains(dependencyRoot, resolved),
        );
        if (
          allowTrackedWorkspaceLinks &&
          !contains(root, resolved) &&
          !dependencyTarget
        ) {
          if (!isTrackedWorkspacePath(resolved)) process.exit(1);
          const linkPath = relativeSourcePath(absolute);
          workspaceLinks.set(linkPath, {
            path: linkPath,
            target,
            sourcePath: relativeSourcePath(resolved),
          });
        }
        hash.update("symlink\0" + relative + "\0" + target + "\0");
      } else {
        process.exit(1);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

const workspaceNodeModules = dependencyRoots.map((root) => ({
  path: relativeSourcePath(root),
  nodeModulesPath: root,
  digest: digestTree(root, true),
}));
const nodeModulesPath = dependencyRoots[0];
const packageJson = JSON.parse(
  fs.readFileSync(path.join(nodeModulesPath, "@vercel/microfrontends/package.json"), "utf8"),
);
console.log(JSON.stringify({
  platform,
  nodeModulesDigest: workspaceNodeModules[0].digest,
  workspaceNodeModules: workspaceNodeModules.slice(1),
  workspaceLinks: [...workspaceLinks.values()].sort((left, right) => left.path.localeCompare(right.path)),
  cargoHomeDigest: digestTree(cargoHomePath, false),
  microfrontendsVersion: packageJson.version,
}));
`;

function liveTemplateClosureInspectionCommand(
  input: LiveTemplateDependencyIdentity,
) {
  const sourceRoot = liveTemplateDependencyWorkspaceRoot(
    input.dependencyKey,
    input.platform,
  );
  const cargoHomePath = liveTemplateCargoHomeRoot(
    input.dependencyKey,
    input.platform,
  );
  return String.raw`node - '${sourceRoot}' '${cargoHomePath}' '${input.platform}' '/workspace/.app-builder/source-files.json' <<'NODE'
${liveTemplateClosureInspectionScript}
NODE`;
}

function liveTemplateBootstrapCommand(input: LiveTemplateDependencyIdentity) {
  const workspace = liveTemplateDependencyWorkspaceRoot(
    input.dependencyKey,
    input.platform,
  );
  const cargoHome = liveTemplateCargoHomeRoot(
    input.dependencyKey,
    input.platform,
  );
  return String.raw`
set -euo pipefail
test -d /workspace/repository
test ! -L /workspace/repository
rm -rf ${workspace} ${cargoHome}
install -d -m 0755 ${workspace} ${cargoHome}
git -C /workspace/repository archive --format=tar HEAD | tar --extract --file - --directory ${workspace}
cd ${workspace}
test "$(node --version)" = "v${HOSTED_NODE_VERSION}"
test "$(bun --version)" = "${ARRUSTED_BUN_VERSION}"
test "$(rustc --version | cut -d' ' -f2)" = "${ARRUSTED_RUST_VERSION}"
test "$(cargo --version | cut -d' ' -f2)" = "${ARRUSTED_RUST_VERSION}"
bun install --frozen-lockfile --ignore-scripts --linker=hoisted >&2
CARGO_HOME=${cargoHome} cargo fetch --locked >&2
for required in .bin/next .bin/turbo .bin/vp @autograph/vite-config/package.json @tailwindcss/vite/package.json @testing-library/react/package.json @vercel/microfrontends/package.json @vitejs/plugin-react/package.json next/package.json react/package.json react-dom/package.json typescript/package.json turbo/package.json vite-plus/package.json vitest/package.json; do
  test -e "node_modules/$required"
done
node - "${workspace}" "${workspace}" <<'NODE'
${developmentDependencySymlinkScript}
NODE
chmod -R a-w,a+rX ${workspace} ${cargoHome}
${liveTemplateClosureInspectionCommand(input)}`;
}

async function liveTemplatePlatform(
  sandbox: SandboxSession,
): Promise<z.infer<typeof liveTemplatePlatformSchema>> {
  const result = await sandbox.run({
    command:
      'set -eu; test "$(uname -s)" = Linux; case "$(uname -m)" in x86_64) printf "%s\\n" linux/x86_64 ;; aarch64|arm64) printf "%s\\n" linux/arm64 ;; *) exit 1 ;; esac',
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(DEPENDENCY_CACHE_TIMEOUT_MS),
  });
  boundedOutput(result.stdout, result.stderr, "Template dependency platform");
  if (result.exitCode !== 0)
    throw new Error("The template dependency platform is unsupported.");
  const platform = liveTemplatePlatformSchema.safeParse(result.stdout.trim());
  if (!platform.success)
    throw new Error("The template dependency platform is invalid.");
  return platform.data;
}

const preparedDependencyInputSchema = z.strictObject({
  mode: z.union([z.literal("100644"), z.literal("100755")]),
  objectId: gitObjectId,
  path: z.string().refine(safeSourcePath),
  sha256: sha256Digest,
});

async function inspectLiveTemplateDependencyIdentity(
  sandbox: SandboxSession,
  platform: z.infer<typeof liveTemplatePlatformSchema>,
): Promise<LiveTemplateDependencyIdentity> {
  const manifestSource = await sandbox.readTextFile({
    path: ".app-builder/source-files.json",
  });
  if (manifestSource === null)
    throw new Error("The prepared source manifest is missing.");
  let entries: z.infer<typeof preparedDependencyInputSchema>[];
  try {
    entries = z
      .array(preparedDependencyInputSchema)
      .min(1)
      .parse(JSON.parse(manifestSource) as unknown);
  } catch {
    throw new Error("The prepared source manifest is invalid.");
  }
  const files = new Map(entries.map((entry) => [entry.path, entry]));
  if (files.size !== entries.length)
    throw new Error("The prepared source manifest is invalid.");
  const dependencyInputPaths = entries
    .map(({ path }) => path)
    .filter(isLiveTemplateDependencyInputPath)
    .sort();
  const dependencyInputs = liveTemplateDependencyInputsSchema.parse(
    Object.fromEntries(
      await Promise.all(
        dependencyInputPaths.map(async (path) => {
          const entry = files.get(path);
          const content = await sandbox.readBinaryFile({
            path: `repository/${path}`,
          });
          if (
            entry === undefined ||
            content === null ||
            sha256(content) !== entry.sha256
          )
            throw new Error("A dependency input changed after source review.");
          return [path, entry.sha256] as const;
        }),
      ),
    ),
  );
  const basis = {
    version: 1 as const,
    platform,
    dependencyInputs,
    runtime: {
      node: HOSTED_NODE_VERSION,
      mise: HOSTED_MISE_VERSION,
      bun: ARRUSTED_BUN_VERSION,
      rust: ARRUSTED_RUST_VERSION,
    },
    bootstrapVersion: LIVE_TEMPLATE_DEPENDENCY_BOOTSTRAP_VERSION,
  } as const;
  return {
    platform,
    dependencyKey: liveTemplateDependencyKey(basis),
    dependencyInputs,
    runtime: basis.runtime,
    bootstrapVersion: basis.bootstrapVersion,
  };
}

function expectedLiveTemplateNodeModulesPath(
  identity: LiveTemplateDependencyIdentity,
) {
  return `${liveTemplateDependencyWorkspaceRoot(identity.dependencyKey, identity.platform)}/node_modules`;
}

function expectedLiveTemplateCargoHomePath(
  identity: LiveTemplateDependencyIdentity,
) {
  return liveTemplateCargoHomeRoot(identity.dependencyKey, identity.platform);
}

function assertExactLiveTemplateManifest(
  manifest: z.infer<typeof liveTemplateDependencyCacheManifestSchema>,
  identity: LiveTemplateDependencyIdentity,
) {
  const sourceRoot = liveTemplateDependencyWorkspaceRoot(
    identity.dependencyKey,
    identity.platform,
  );
  if (
    manifest.platform !== identity.platform ||
    manifest.dependencyKey !== identity.dependencyKey ||
    JSON.stringify(manifest.dependencyInputs) !==
      JSON.stringify(identity.dependencyInputs) ||
    JSON.stringify(manifest.runtime) !== JSON.stringify(identity.runtime) ||
    manifest.bootstrapVersion !== identity.bootstrapVersion ||
    manifest.closure.nodeModulesPath !==
      expectedLiveTemplateNodeModulesPath(identity) ||
    manifest.closure.cargoHomePath !==
      expectedLiveTemplateCargoHomePath(identity) ||
    manifest.closure.workspaceNodeModules.some(
      (entry) => entry.nodeModulesPath !== `${sourceRoot}/${entry.path}`,
    ) ||
    manifest.closure.workspaceLinks.some(
      (entry) => entry.path === entry.sourcePath,
    )
  )
    throw new Error("The live template dependency cache binding drifted.");
}

function assertExactLiveTemplateClosure(
  manifest: z.infer<typeof liveTemplateDependencyCacheManifestSchema>,
  observation: z.infer<typeof liveTemplateClosureObservationSchema>,
) {
  if (
    observation.platform !== manifest.platform ||
    observation.nodeModulesDigest !== manifest.closure.nodeModulesDigest ||
    JSON.stringify(observation.workspaceNodeModules) !==
      JSON.stringify(manifest.closure.workspaceNodeModules) ||
    JSON.stringify(observation.workspaceLinks) !==
      JSON.stringify(manifest.closure.workspaceLinks) ||
    observation.cargoHomeDigest !== manifest.closure.cargoHomeDigest ||
    observation.microfrontendsVersion !== manifest.closure.microfrontendsVersion
  )
    throw new Error("The live template dependency cache closure drifted.");
}

async function inspectLiveTemplateClosure(input: {
  sandbox: SandboxSession;
  identity: LiveTemplateDependencyIdentity;
}) {
  const result = await input.sandbox.run({
    command: liveTemplateClosureInspectionCommand(input.identity),
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(DEPENDENCY_CACHE_TIMEOUT_MS),
  });
  boundedOutput(
    result.stdout,
    result.stderr,
    "Template dependency closure inspection",
  );
  if (result.exitCode !== 0)
    throw new Error("The live template dependency cache closure is missing.");
  try {
    return liveTemplateClosureObservationSchema.parse(
      JSON.parse(result.stdout) as unknown,
    );
  } catch {
    throw new Error("The live template dependency cache closure is invalid.");
  }
}

function liveTemplateContentDigest(
  manifest: z.infer<typeof liveTemplateDependencyCacheManifestSchema>,
) {
  return sha256(
    JSON.stringify({
      platform: manifest.platform,
      dependencyKey: manifest.dependencyKey,
      dependencyInputs: manifest.dependencyInputs,
      runtime: manifest.runtime,
      bootstrapVersion: manifest.bootstrapVersion,
      closure: manifest.closure,
    }),
  );
}

export async function bootstrapLiveTemplateDependencies(input: {
  sandbox: SandboxSession;
}): Promise<ObservedDependencyCache> {
  const platform = await liveTemplatePlatform(input.sandbox);
  const identity = await inspectLiveTemplateDependencyIdentity(
    input.sandbox,
    platform,
  );
  const manifestPath = liveTemplateManifestPath(
    identity.dependencyKey,
    platform,
  );
  const prior = await input.sandbox.readTextFile({
    path: manifestPath,
  });
  if (prior !== null) {
    let manifest: z.infer<typeof liveTemplateDependencyCacheManifestSchema>;
    try {
      manifest = liveTemplateDependencyCacheManifestSchema.parse(
        JSON.parse(prior) as unknown,
      );
    } catch {
      throw new Error(
        "The live template dependency cache manifest is invalid.",
      );
    }
    assertExactLiveTemplateManifest(manifest, identity);
    const observation = await inspectLiveTemplateClosure({
      sandbox: input.sandbox,
      identity,
    });
    assertExactLiveTemplateClosure(manifest, observation);
    return {
      manifest,
      manifestDigest: sha256(prior),
      contentDigest: liveTemplateContentDigest(manifest),
    };
  }
  await ensureSandboxDirectories(input.sandbox, [
    `${LIVE_TEMPLATE_DEPENDENCY_CACHE_ROOT}/${identity.dependencyKey}/${platform}`,
  ]);
  await input.sandbox.setNetworkPolicy({
    allow: [...LIVE_TEMPLATE_BOOTSTRAP_HOSTS],
  });
  let result;
  try {
    result = await input.sandbox.run({
      command: liveTemplateBootstrapCommand(identity),
      workingDirectory: "/workspace",
      abortSignal: AbortSignal.timeout(DEPENDENCY_PREPARATION_TIMEOUT_MS),
    });
  } finally {
    await input.sandbox.setNetworkPolicy("deny-all");
  }
  boundedOutput(result.stdout, result.stderr, "Template dependency bootstrap");
  if (result.exitCode !== 0)
    throw new Error(
      "The canonical template dependencies could not be bootstrapped.",
    );
  let observation: z.infer<typeof liveTemplateClosureObservationSchema>;
  try {
    observation = liveTemplateClosureObservationSchema.parse(
      JSON.parse(result.stdout) as unknown,
    );
  } catch {
    throw new Error(
      "The canonical template dependency bootstrap receipt is invalid.",
    );
  }
  if (observation.platform !== platform)
    throw new Error("The canonical template dependency platform drifted.");
  const manifest = {
    version: 4 as const,
    scope: "live-template-execution" as const,
    platform: observation.platform,
    dependencyKey: identity.dependencyKey,
    dependencyInputs: identity.dependencyInputs,
    runtime: identity.runtime,
    bootstrapVersion: identity.bootstrapVersion,
    closure: {
      nodeModulesPath: expectedLiveTemplateNodeModulesPath(identity),
      nodeModulesDigest: observation.nodeModulesDigest,
      workspaceNodeModules: observation.workspaceNodeModules,
      workspaceLinks: observation.workspaceLinks,
      cargoHomePath: expectedLiveTemplateCargoHomePath(identity),
      cargoHomeDigest: observation.cargoHomeDigest,
      microfrontendsVersion: observation.microfrontendsVersion,
    },
  };
  const parsed = liveTemplateDependencyCacheManifestSchema.parse(manifest);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  await input.sandbox.writeTextFile({
    path: manifestPath,
    content: serialized,
  });
  return {
    manifest: parsed,
    manifestDigest: sha256(serialized),
    contentDigest: liveTemplateContentDigest(parsed),
  };
}

export async function inspectDependencyCache(
  sandbox: SandboxSession,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fixtureTarget?: ExactSourceBinding,
  preferLiveTemplate = false,
): Promise<ObservedDependencyCache> {
  if (fixtureDependencyCacheEnabled(environment)) {
    const manifest = fixtureManifest(fixtureTarget);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    return {
      manifest,
      manifestDigest: sha256(serialized),
      contentDigest: manifest.closure.archiveSha256,
    };
  }
  if (preferLiveTemplate && fixtureTarget !== undefined) {
    const platform = await liveTemplatePlatform(sandbox);
    const identity = await inspectLiveTemplateDependencyIdentity(
      sandbox,
      platform,
    );
    const liveManifest = await sandbox.readTextFile({
      path: liveTemplateManifestPath(identity.dependencyKey, platform),
    });
    if (liveManifest === null)
      throw new DependencyCacheMissingError(
        "The live template dependency cache is missing.",
      );
    let manifest: z.infer<typeof liveTemplateDependencyCacheManifestSchema>;
    try {
      manifest = liveTemplateDependencyCacheManifestSchema.parse(
        JSON.parse(liveManifest) as unknown,
      );
    } catch {
      throw new Error(
        "The live template dependency cache manifest is invalid.",
      );
    }
    assertExactLiveTemplateManifest(manifest, identity);
    const observation = await inspectLiveTemplateClosure({
      sandbox,
      identity,
    });
    assertExactLiveTemplateClosure(manifest, observation);
    return {
      manifest,
      manifestDigest: sha256(liveManifest),
      contentDigest: liveTemplateContentDigest(manifest),
    };
  }

  const cachePaths = dependencyCachePaths(environment);

  const manifestResult = await sandbox.run({
    command: `cat -- ${cachePaths.manifest}`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(DEPENDENCY_CACHE_TIMEOUT_MS),
  });
  boundedOutput(
    manifestResult.stdout,
    manifestResult.stderr,
    "Dependency cache manifest inspection",
  );
  if (manifestResult.exitCode !== 0)
    throw new Error("The fixed offline dependency cache manifest is missing.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestResult.stdout) as unknown;
  } catch {
    throw new Error("The fixed offline dependency cache manifest is invalid.");
  }
  const hostedExecution = hostedSeedDependencyCacheEnabled(environment);
  const developmentExecution =
    environment.APP_BUILDER_EXECUTION_MODE === "development";
  const validated = (
    hostedExecution
      ? hostedExecutionDependencyCacheManifestSchema
      : developmentExecution
        ? developmentDependencyCacheManifestSchema
        : dependencyCacheManifestSchema
  ).safeParse(parsed);
  if (!validated.success)
    throw new Error("The fixed offline dependency cache manifest drifted.");
  if (developmentExecution) {
    const developmentManifest = developmentDependencyCacheManifestSchema.parse(
      validated.data,
    );
    if (
      developmentManifest.dependencyKey !==
      environment.APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY
    )
      throw new Error("The development dependency cache key drifted.");
  }

  const archiveResult = await sandbox.run({
    command: hostedExecution
      ? `sha256sum -- ${cachePaths.archive} && stat --format='%s' -- ${cachePaths.archive}`
      : `sha256sum -- ${cachePaths.archive} && stat --format='%s' -- ${cachePaths.archive} && sha256sum -- ${cachePaths.cargoArchive} && stat --format='%s' -- ${cachePaths.cargoArchive}`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(DEPENDENCY_CACHE_TIMEOUT_MS),
  });
  boundedOutput(
    archiveResult.stdout,
    archiveResult.stderr,
    "Dependency cache content inspection",
  );
  if (archiveResult.exitCode !== 0)
    throw new Error("The fixed offline dependency cache archive is missing.");
  const [checksumLine, sizeLine, cargoChecksumLine, cargoSizeLine] =
    archiveResult.stdout.trim().split("\n");
  const observedDigest = checksumLine?.trim().split(/\s+/u)[0];
  const observedBytes = Number(sizeLine);
  const observedCargoDigest = cargoChecksumLine?.trim().split(/\s+/u)[0];
  const observedCargoBytes = Number(cargoSizeLine);
  const fullClosure = hostedExecution
    ? undefined
    : developmentExecution
      ? developmentDependencyCacheManifestSchema.parse(validated.data).closure
      : dependencyCacheManifestSchema.parse(validated.data).closure;
  if (
    observedDigest === undefined ||
    !sha256Digest.safeParse(observedDigest).success ||
    observedDigest !== validated.data.closure.archiveSha256 ||
    observedBytes !== validated.data.closure.archiveBytes ||
    (fullClosure !== undefined &&
      (observedCargoDigest === undefined ||
        !sha256Digest.safeParse(observedCargoDigest).success ||
        observedCargoDigest !== fullClosure.cargoArchiveSha256 ||
        observedCargoBytes !== fullClosure.cargoArchiveBytes))
  )
    throw new Error("The fixed offline dependency cache archive drifted.");

  return {
    manifest: validated.data,
    manifestDigest: sha256(manifestResult.stdout),
    contentDigest: observedDigest,
  };
}

export function planningOverlayRoot(artifactRevision: string) {
  if (!sha256Digest.safeParse(artifactRevision).success)
    throw new Error("The AppSpec artifact revision is invalid.");
  return `.app-builder/target-inputs/${artifactRevision}/repository`;
}

export async function materializeOfflineDependencies(input: {
  sandbox: SandboxSession;
  artifactRevision: string;
  target: ExactSourceBinding;
  environment?: Readonly<Record<string, string | undefined>>;
  preferLiveTemplate?: boolean;
}) {
  const environment = input.environment ?? process.env;
  const observed = await inspectDependencyCache(
    input.sandbox,
    environment,
    input.target,
    input.preferLiveTemplate,
  );
  assertExactDependencyTargetBinding({
    workspace: input.target,
    sourceReceipt: input.target,
    cache: observed,
  });
  const developmentExecution =
    observed.manifest.scope === "development-execution";
  const root = planningOverlayRoot(input.artifactRevision);
  const dependencyLayout = dependencyExecutionLayout(observed, environment);
  if (!fixtureDependencyCacheEnabled(environment)) {
    const liveTemplate = observed.manifest.scope === "live-template-execution";
    const hostedExecution =
      !liveTemplate && hostedWorkspaceDependencyExtractionEnabled(environment);
    const hostedDependencyRoot = `/workspace/.app-builder/hosted-dependencies/${observed.contentDigest}`;
    const absoluteNodeModules =
      observed.manifest.scope === "live-template-execution"
        ? observed.manifest.closure.nodeModulesPath
        : materializedDependencyNodeModulesRoot(
            observed.contentDigest,
            environment,
          );
    const installHostedClosure = hostedExecution
      ? `if [ ! -d ${absoluteNodeModules} ]; then rm -rf ${hostedDependencyRoot} && install -d -m 0755 ${hostedDependencyRoot} && tar --extract --gzip --file ${dependencyCachePaths(environment).archive} --directory ${hostedDependencyRoot} --no-same-owner --no-same-permissions && chmod -R a-w,a+rX ${hostedDependencyRoot}; fi && `
      : "";
    await ensureSandboxDirectories(input.sandbox, [root]);
    const requiredExecutionClosure = REQUIRED_EXECUTION_PACKAGES.map(
      (path) => `test -e ${absoluteNodeModules}/${path}`,
    ).join(" && ");
    const extraction = await input.sandbox.run({
      command: `${installHostedClosure}test -d ${absoluteNodeModules} && test ! -L ${absoluteNodeModules} && ${developmentExecution ? `test "$(realpath ${DEVELOPMENT_DEPENDENCY_CACHE_ROOT})" = "${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}" && test "$(realpath ${absoluteNodeModules})" = "${absoluteNodeModules}" && ` : ""}${requiredExecutionClosure} && test -x ${absoluteNodeModules}/.bin/next && test -x ${absoluteNodeModules}/.bin/turbo && test -x ${absoluteNodeModules}/.bin/vp && bun ${absoluteNodeModules}/.bin/next --version >/dev/null && bun ${absoluteNodeModules}/.bin/turbo --version >/dev/null && bun ${absoluteNodeModules}/.bin/vp --version >/dev/null && ${developmentExecution ? `if find ${absoluteNodeModules} \\( -type f -o -type d \\) -perm /022 -print -quit | grep -q .; then exit 1; fi && ` : `if find ${absoluteNodeModules} \\( -type f -o -type d \\) -perm /222 -print -quit | grep -q .; then exit 1; fi && `}test ! -e /workspace/repository/node_modules && test ! -L /workspace/repository/node_modules`,
      workingDirectory: "/workspace",
      abortSignal: AbortSignal.timeout(DEPENDENCY_PREPARATION_TIMEOUT_MS),
    });
    boundedOutput(
      extraction.stdout,
      extraction.stderr,
      "Offline dependency materialization",
    );
    if (extraction.exitCode !== 0)
      throw new Error(
        "The fixed offline dependency cache could not be materialized.",
      );
    await materializeExecutionDependencyView({
      sandbox: input.sandbox,
      layout: dependencyLayout,
      overlayRoot: root,
      viewKey: input.artifactRevision,
    });
    const resolution = await input.sandbox.run({
      command: `cd /workspace/${root} && bun --eval 'await import("@autograph/vite-config")'`,
      workingDirectory: "/workspace",
      abortSignal: AbortSignal.timeout(DEPENDENCY_CACHE_TIMEOUT_MS),
    });
    boundedOutput(
      resolution.stdout,
      resolution.stderr,
      "Dependency view resolution",
    );
    if (resolution.exitCode !== 0)
      throw new Error("The dependency execution view is incomplete.");
  }
  const packageContent = fixtureDependencyCacheEnabled(environment)
    ? JSON.stringify({ version: ARRUSTED_MICROFRONTENDS_VERSION })
    : await input.sandbox.readTextFile({
        path: `${root}/node_modules/@vercel/microfrontends/package.json`,
      });
  if (packageContent === null)
    throw new Error("The required offline dependency closure is incomplete.");
  let packageVersion: unknown;
  try {
    packageVersion = (JSON.parse(packageContent) as { version?: unknown })
      .version;
  } catch {
    throw new Error("The required offline dependency closure is invalid.");
  }
  const expectedMicrofrontendsVersion =
    observed.manifest.scope === "live-template-execution"
      ? observed.manifest.closure.microfrontendsVersion
      : ARRUSTED_MICROFRONTENDS_VERSION;
  if (packageVersion !== expectedMicrofrontendsVersion)
    throw new Error("The required offline dependency closure drifted.");
  if (
    !fixtureDependencyCacheEnabled(environment) &&
    !hostedArtifactDependencyCacheEnabled(environment) &&
    observed.manifest.scope !== "live-template-execution"
  ) {
    const resolution = await input.sandbox.run({
      command: `bun -e 'const fs=require("node:fs"); const read=(path)=>JSON.parse(fs.readFileSync(path,"utf8")).version; const {match}=require("path-to-regexp"); const result=match("/vendor")("/vendor"); if(read("../../node_modules/path-to-regexp/package.json")!=="${ARRUSTED_PATH_TO_REGEXP_VERSION}" || read("../../node_modules/@vercel/microfrontends/package.json")!=="${ARRUSTED_MICROFRONTENDS_VERSION}" || read("../../node_modules/@vercel/microfrontends/node_modules/path-to-regexp/package.json")!=="${ARRUSTED_MICROFRONTENDS_PATH_TO_REGEXP_VERSION}" || result?.path!=="/vendor") process.exit(1)'`,
      workingDirectory: `/workspace/${root}/packages/platform-microfrontends`,
      abortSignal: AbortSignal.timeout(DEPENDENCY_CACHE_TIMEOUT_MS),
    });
    boundedOutput(
      resolution.stdout,
      resolution.stderr,
      "Offline dependency resolution",
    );
    if (resolution.exitCode !== 0)
      throw new Error("The required offline dependency closure is incomplete.");
    if (!hostedSeedDependencyCacheEnabled(environment)) {
      const rustToolchain = await input.sandbox.run({
        command: developmentExecution
          ? `PATH=${DEVELOPMENT_TOOLCHAIN_PATH} CARGO_HOME=${DEVELOPMENT_CARGO_HOME} CARGO_NET_OFFLINE=true sh -c 'test "$(rustc --version | cut -d" " -f2)" = "${ARRUSTED_RUST_VERSION}" && test "$(cargo --version | cut -d" " -f2)" = "${ARRUSTED_RUST_VERSION}" && test -r ${DEVELOPMENT_CARGO_CONFIG} && cargo metadata --config ${DEVELOPMENT_CARGO_CONFIG} --offline --format-version 1 --locked --all-features >/dev/null'`
          : `MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false mise --env app-builder exec --no-deps -- sh -c 'test "$(rustc --version | cut -d" " -f2)" = "${ARRUSTED_RUST_VERSION}" && test "$(cargo --version | cut -d" " -f2)" = "${ARRUSTED_RUST_VERSION}" && CARGO_NET_OFFLINE=true cargo metadata --format-version 1 --locked --all-features >/dev/null'`,
        workingDirectory: `/workspace/${root}`,
        abortSignal: AbortSignal.timeout(DEPENDENCY_CACHE_TIMEOUT_MS),
      });
      boundedOutput(
        rustToolchain.stdout,
        rustToolchain.stderr,
        "Offline Rust toolchain inspection",
      );
      if (rustToolchain.exitCode !== 0)
        throw new Error("The required offline Rust toolchain is incomplete.");
    }
  }
  return {
    ...observed,
    dependencyLayout,
    planningRoot: `/workspace/${root}`,
  };
}

export function dependencyCacheReceiptDigest(
  observed: ObservedDependencyCache,
) {
  return `sha256:${observed.manifestDigest}`;
}
