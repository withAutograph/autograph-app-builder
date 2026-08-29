import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { HOSTED_ARTIFACT_WORKSPACE_CACHE_ROOT } from "../sandbox/hosted-toolchain";
import { hasTestCapability } from "../testing/test-capability";

export const ARRUSTED_TARGET_SHA = "86c1abcc0a29eba070856fde669feba07b7cde47";
export const ARRUSTED_TARGET_TREE = "b47d3c503f7b8e4345731b1d278ff9d83fa2b917";
export const ARRUSTED_BUN_VERSION = "1.3.14";
export const ARRUSTED_RUST_VERSION = "1.97.1";
export const ARRUSTED_MICROFRONTENDS_VERSION = "2.4.0";
export const ARRUSTED_PATH_TO_REGEXP_VERSION = "8.4.2";
export const ARRUSTED_MICROFRONTENDS_PATH_TO_REGEXP_VERSION = "6.3.0";
export const ARRUSTED_APP_VALIDATION_SHA256 =
  "11b090ccc6a41ff7e98eed17b58b8d493f594da60e4e30c1f1f3b5c854fc3a18";
export const ARRUSTED_CREATE_APP_SHA256 =
  "16eac31c8281d70b525450b6dfdb5ffbd3dbda31424da6fcba04de283ced5c6c";
export const ARRUSTED_APP_TEMPLATE_PACKAGE_SHA256 =
  "7674a4db3f07daa15566331b369b536e031699af000e6701962d267dd5f680b5";

export const DEPENDENCY_CACHE_MANIFEST_PATH =
  "/opt/app-builder/dependency-cache/manifest.json";
export const DEPENDENCY_CACHE_ARCHIVE_PATH =
  "/opt/app-builder/dependency-cache/node-modules.tar.gz";
export const DEPENDENCY_CACHE_CARGO_ARCHIVE_PATH =
  "/opt/app-builder/dependency-cache/cargo-closure.tar.gz";
export const DEPENDENCY_CACHE_EXTRACTED_ROOT =
  "/opt/app-builder/dependencies";
export const DEPENDENCY_CACHE_TIMEOUT_MS = 30_000;
export const DEPENDENCY_PREPARATION_TIMEOUT_MS = 120_000;
export const DEPENDENCY_CACHE_OUTPUT_BYTES = 262_144;

const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/u);

const dependencyCacheManifestShapeSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal("builder-execution"),
  platform: z.union([z.literal("linux/arm64"), z.literal("linux/portable")]),
  target: z.strictObject({
    sha: gitObjectId,
    tree: gitObjectId,
    miseConfigSha256: z.literal(
      "be05ac034f1d73b62526a81b8353963692817dfbedce6698e5ff4baacbb0e3a8",
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
    appTemplatePackageSha256: z.literal(
      ARRUSTED_APP_TEMPLATE_PACKAGE_SHA256,
    ),
    repositoryPreflightSha256: z.literal(
      "7c6f5fb5f44aaf436cfc558ea82cc78dae02895dd7012497fa0c1ee7dc589340",
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

export const dependencyCacheManifestSchema =
  dependencyCacheManifestShapeSchema.refine(
    ({ target }) =>
      target.sha === ARRUSTED_TARGET_SHA &&
      target.tree === ARRUSTED_TARGET_TREE,
    "dependency target does not match the committed source binding",
  );

export type DependencyCacheManifest = z.infer<
  typeof dependencyCacheManifestShapeSchema
>;

export type ObservedDependencyCache = {
  manifest: DependencyCacheManifest;
  manifestDigest: string;
  contentDigest: string;
};

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
  const target = input.cache.manifest.target;
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

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

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
): DependencyCacheManifest {
  return {
    version: 1,
    scope: "builder-execution",
    platform: "linux/arm64",
    target: {
      sha: target.sourceSha,
      tree: target.sourceTree,
      miseConfigSha256:
        "be05ac034f1d73b62526a81b8353963692817dfbedce6698e5ff4baacbb0e3a8",
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
        "7c6f5fb5f44aaf436cfc558ea82cc78dae02895dd7012497fa0c1ee7dc589340",
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

export async function inspectDependencyCache(
  sandbox: SandboxSession,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fixtureTarget?: ExactSourceBinding,
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
  const validated = dependencyCacheManifestSchema.safeParse(parsed);
  if (!validated.success)
    throw new Error("The fixed offline dependency cache manifest drifted.");

  const archiveResult = await sandbox.run({
    command: `sha256sum -- ${cachePaths.archive} && stat --format='%s' -- ${cachePaths.archive} && sha256sum -- ${cachePaths.cargoArchive} && stat --format='%s' -- ${cachePaths.cargoArchive}`,
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
  if (
    observedDigest === undefined ||
    !sha256Digest.safeParse(observedDigest).success ||
    observedDigest !== validated.data.closure.archiveSha256 ||
    observedBytes !== validated.data.closure.archiveBytes ||
    observedCargoDigest === undefined ||
    !sha256Digest.safeParse(observedCargoDigest).success ||
    observedCargoDigest !== validated.data.closure.cargoArchiveSha256 ||
    observedCargoBytes !== validated.data.closure.cargoArchiveBytes
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
}) {
  const environment = input.environment ?? process.env;
  const observed = await inspectDependencyCache(
    input.sandbox,
    environment,
    input.target,
  );
  assertExactDependencyTargetBinding({
    workspace: input.target,
    sourceReceipt: input.target,
    cache: observed,
  });
  const root = planningOverlayRoot(input.artifactRevision);
  if (!fixtureDependencyCacheEnabled(environment)) {
    const absoluteNodeModules = dependencyCacheNodeModulesRoot(
      observed.contentDigest,
    );
    await ensureSandboxDirectories(input.sandbox, [root]);
    const extraction = await input.sandbox.run({
      command: `test -d ${absoluteNodeModules} && test ! -L ${absoluteNodeModules} && if find ${absoluteNodeModules} \\( -type f -o -type d \\) -perm /222 -print -quit | grep -q .; then exit 1; fi && rm -rf /workspace/${root}/node_modules && ln -s ${absoluteNodeModules} /workspace/${root}/node_modules && test -L /workspace/${root}/node_modules && test "$(readlink -- /workspace/${root}/node_modules)" = "${absoluteNodeModules}"`,
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
  if (packageVersion !== ARRUSTED_MICROFRONTENDS_VERSION)
    throw new Error("The required offline dependency closure drifted.");
  if (!fixtureDependencyCacheEnabled(environment)) {
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
    const rustToolchain = await input.sandbox.run({
      command: `MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false mise --env app-builder exec --no-deps -- sh -c 'test "$(rustc --version | cut -d" " -f2)" = "${ARRUSTED_RUST_VERSION}" && test "$(cargo --version | cut -d" " -f2)" = "${ARRUSTED_RUST_VERSION}" && CARGO_NET_OFFLINE=true cargo metadata --format-version 1 --locked --all-features >/dev/null'`,
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
  return { ...observed, planningRoot: `/workspace/${root}` };
}

export function dependencyCacheReceiptDigest(
  observed: ObservedDependencyCache,
) {
  return `sha256:${observed.manifestDigest}`;
}
