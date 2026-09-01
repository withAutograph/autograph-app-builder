import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT } from "../sandbox/hosted-toolchain";
import { hasTestCapability } from "../testing/test-capability";

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
export const DEPENDENCY_PREPARATION_TIMEOUT_MS = 120_000;
export const DEPENDENCY_CACHE_OUTPUT_BYTES = 262_144;
export const LIVE_TEMPLATE_DEPENDENCY_CACHE_ROOT =
  ".app-builder/template-dependency-cache";
const LIVE_TEMPLATE_NODE_MODULES_PATH = "/workspace/repository/node_modules";
const DEVELOPMENT_TOOLCHAIN_PATH =
  "/workspace/.app-builder/toolchain/bin:/workspace/.app-builder/toolchain/rust/bin:/usr/bin:/bin";
const DEVELOPMENT_CARGO_HOME = "/workspace/.app-builder/toolchain/cargo-home";
const DEVELOPMENT_CARGO_CONFIG = "/opt/app-builder/cargo/config.toml";

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
  closure: dependencyCacheManifestShapeSchema.shape.closure,
});

const liveTemplateDependencyCacheManifestSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal("live-template-execution"),
  platform: z.union([z.literal("linux/arm64"), z.literal("linux/x86_64")]),
  target: z.strictObject({ sha: gitObjectId, tree: gitObjectId }),
  locks: z.strictObject({
    miseConfigSha256: sha256Digest,
    miseLockSha256: sha256Digest,
    bunLockSha256: sha256Digest,
    cargoLockSha256: sha256Digest,
  }),
  closure: z.strictObject({
    nodeModulesPath: z.literal(LIVE_TEMPLATE_NODE_MODULES_PATH),
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

export class DependencyCacheMissingError extends Error {
  readonly code = "dependency_cache_missing" as const;

  constructor(message: string) {
    super(message);
    this.name = "DependencyCacheMissingError";
  }
}

type ExactSourceBinding = {
  sourceSha: string;
  sourceTree: string;
};

type ExactDependencyReceiptBinding = ExactSourceBinding & {
  targetSha: string;
  targetTree: string;
};

export function assertExactDependencyTargetBinding(input: {
  workspace: ExactSourceBinding;
  sourceReceipt: ExactSourceBinding;
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

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function liveTemplateManifestPath(
  target: ExactSourceBinding,
  platform: z.infer<typeof liveTemplatePlatformSchema>,
) {
  return `${LIVE_TEMPLATE_DEPENDENCY_CACHE_ROOT}/${target.sourceSha}/${platform}/manifest.json`;
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
  const immutableImageRoot = dependencyCacheNodeModulesRoot(contentDigest);
  if (hostedWorkspaceDependencyExtractionEnabled(environment))
    return `/workspace/.app-builder/hosted-dependencies/${contentDigest}/node_modules`;
  return immutableImageRoot;
}

function dependencyCachePaths(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const root = hostedArtifactDependencyCacheEnabled(environment)
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

const liveTemplateBootstrapObservationSchema = z.strictObject({
  platform: liveTemplatePlatformSchema,
  locks: liveTemplateDependencyCacheManifestSchema.shape.locks,
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

const liveTemplateBootstrapCommand = String.raw`
set -euo pipefail
cd /workspace/repository
mise trust >&2
mise install >&2
bun install --frozen-lockfile --ignore-scripts --linker=hoisted >&2
cargo fetch --locked >&2
for required in .bin/next .bin/turbo .bin/vp @autograph/vite-config/package.json @tailwindcss/vite/package.json @testing-library/react/package.json @vercel/microfrontends/package.json @vitejs/plugin-react/package.json next/package.json react/package.json react-dom/package.json typescript/package.json turbo/package.json vite-plus/package.json vitest/package.json; do
  test -e "node_modules/$required"
done
chmod -R a-w,a+rX node_modules
node -e 'const c=require("node:crypto"),f=require("node:fs");const sha=(p)=>c.createHash("sha256").update(f.readFileSync(p)).digest("hex");const arch=process.arch==="x64"?"linux/x86_64":process.arch==="arm64"?"linux/arm64":"unsupported";console.log(JSON.stringify({platform:arch,locks:{miseConfigSha256:sha(".config/mise/config.toml"),miseLockSha256:sha(".config/mise/mise.lock"),bunLockSha256:sha("bun.lock"),cargoLockSha256:sha("Cargo.lock")},microfrontendsVersion:JSON.parse(f.readFileSync("node_modules/@vercel/microfrontends/package.json","utf8")).version}))'`;

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

export async function bootstrapLiveTemplateDependencies(input: {
  sandbox: SandboxSession;
  target: ExactSourceBinding;
}): Promise<ObservedDependencyCache> {
  const platform = await liveTemplatePlatform(input.sandbox);
  const prior = await input.sandbox.readTextFile({
    path: liveTemplateManifestPath(input.target, platform),
  });
  if (prior !== null) {
    let manifest: ReturnType<
      typeof liveTemplateDependencyCacheManifestSchema.safeParse
    >;
    try {
      manifest = liveTemplateDependencyCacheManifestSchema.safeParse(
        JSON.parse(prior) as unknown,
      );
    } catch {
      throw new Error(
        "The live template dependency cache manifest is invalid.",
      );
    }
    if (
      manifest.success &&
      manifest.data.target.sha === input.target.sourceSha &&
      manifest.data.target.tree === input.target.sourceTree
    )
      return {
        manifest: manifest.data,
        manifestDigest: sha256(prior),
        contentDigest: sha256(
          JSON.stringify({
            locks: manifest.data.locks,
            closure: manifest.data.closure,
            platform: manifest.data.platform,
          }),
        ),
      };
  }
  await input.sandbox.setNetworkPolicy({
    allow: [...LIVE_TEMPLATE_BOOTSTRAP_HOSTS],
  });
  let result;
  try {
    result = await input.sandbox.run({
      command: liveTemplateBootstrapCommand,
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
  let observation: z.infer<typeof liveTemplateBootstrapObservationSchema>;
  try {
    observation = liveTemplateBootstrapObservationSchema.parse(
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
    version: 1 as const,
    scope: "live-template-execution" as const,
    platform: observation.platform,
    target: { sha: input.target.sourceSha, tree: input.target.sourceTree },
    locks: observation.locks,
    closure: {
      nodeModulesPath: LIVE_TEMPLATE_NODE_MODULES_PATH,
      microfrontendsVersion: observation.microfrontendsVersion,
    },
  };
  const parsed = liveTemplateDependencyCacheManifestSchema.parse(manifest);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  await ensureSandboxDirectories(input.sandbox, [
    `${LIVE_TEMPLATE_DEPENDENCY_CACHE_ROOT}/${input.target.sourceSha}/${platform}`,
  ]);
  await input.sandbox.writeTextFile({
    path: liveTemplateManifestPath(input.target, platform),
    content: serialized,
  });
  return {
    manifest: parsed,
    manifestDigest: sha256(serialized),
    contentDigest: sha256(
      JSON.stringify({
        locks: parsed.locks,
        closure: parsed.closure,
        platform: parsed.platform,
      }),
    ),
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
    const liveManifest = await sandbox.readTextFile({
      path: liveTemplateManifestPath(fixtureTarget, platform),
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
    if (
      manifest.target.sha !== fixtureTarget.sourceSha ||
      manifest.target.tree !== fixtureTarget.sourceTree ||
      manifest.platform !== platform
    )
      throw new Error("The live template dependency cache source drifted.");
    return {
      manifest,
      manifestDigest: sha256(liveManifest),
      contentDigest: sha256(
        JSON.stringify({
          locks: manifest.locks,
          closure: manifest.closure,
          platform: manifest.platform,
        }),
      ),
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
  if (!fixtureDependencyCacheEnabled(environment)) {
    const liveTemplate = observed.manifest.scope === "live-template-execution";
    const hostedExecution =
      !liveTemplate && hostedWorkspaceDependencyExtractionEnabled(environment);
    const hostedDependencyRoot = `/workspace/.app-builder/hosted-dependencies/${observed.contentDigest}`;
    const absoluteNodeModules = liveTemplate
      ? LIVE_TEMPLATE_NODE_MODULES_PATH
      : materializedDependencyNodeModulesRoot(
          observed.contentDigest,
          environment,
        );
    const developmentWorkspaceDependencyLink = developmentExecution
      ? `test -d /workspace/repository && test ! -L /workspace/repository && if [ -e /workspace/repository/node_modules ] || [ -L /workspace/repository/node_modules ]; then test -L /workspace/repository/node_modules && test "$(readlink -- /workspace/repository/node_modules)" = "${absoluteNodeModules}"; else ln -s ${absoluteNodeModules} /workspace/repository/node_modules; fi && test -L /workspace/repository/node_modules && test "$(readlink -- /workspace/repository/node_modules)" = "${absoluteNodeModules}" && `
      : "";
    const installHostedClosure = hostedExecution
      ? `if [ ! -d ${absoluteNodeModules} ]; then rm -rf ${hostedDependencyRoot} && install -d -m 0755 ${hostedDependencyRoot} && tar --extract --gzip --file ${dependencyCachePaths(environment).archive} --directory ${hostedDependencyRoot} --no-same-owner --no-same-permissions && chmod -R a-w,a+rX ${hostedDependencyRoot}; fi && `
      : "";
    await ensureSandboxDirectories(input.sandbox, [root]);
    const requiredExecutionClosure = REQUIRED_EXECUTION_PACKAGES.map(
      (path) => `test -e ${absoluteNodeModules}/${path}`,
    ).join(" && ");
    const extraction = await input.sandbox.run({
      command: `${installHostedClosure}test -d ${absoluteNodeModules} && test ! -L ${absoluteNodeModules} && ${requiredExecutionClosure} && test -x ${absoluteNodeModules}/.bin/next && test -x ${absoluteNodeModules}/.bin/turbo && test -x ${absoluteNodeModules}/.bin/vp && bun ${absoluteNodeModules}/.bin/next --version >/dev/null && bun ${absoluteNodeModules}/.bin/turbo --version >/dev/null && bun ${absoluteNodeModules}/.bin/vp --version >/dev/null && if find ${absoluteNodeModules} \\( -type f -o -type d \\) -perm /222 -print -quit | grep -q .; then exit 1; fi && ${developmentWorkspaceDependencyLink}rm -rf /workspace/${root}/node_modules && ln -s ${absoluteNodeModules} /workspace/${root}/node_modules && test -L /workspace/${root}/node_modules && test "$(readlink -- /workspace/${root}/node_modules)" = "${absoluteNodeModules}" && cd /workspace/${root} && bun --eval 'await import("@autograph/vite-config")'`,
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
  return { ...observed, planningRoot: `/workspace/${root}` };
}

export function dependencyCacheReceiptDigest(
  observed: ObservedDependencyCache,
) {
  return `sha256:${observed.manifestDigest}`;
}
