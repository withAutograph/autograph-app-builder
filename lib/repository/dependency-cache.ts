import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { hasTestCapability } from "../testing/test-capability";

export const ARRUSTED_TARGET_SHA = "c9a5faf2a5b042df708fb8deade12f399ef2547b";
export const ARRUSTED_TARGET_TREE = "7f4cbdac458b74dd51a0c2a516c5da1c2f4d8755";
export const ARRUSTED_BUN_VERSION = "1.3.14";
export const ARRUSTED_MICROFRONTENDS_VERSION = "2.4.0";

export const DEPENDENCY_CACHE_MANIFEST_PATH =
  "/opt/app-builder/dependency-cache/manifest.json";
export const DEPENDENCY_CACHE_ARCHIVE_PATH =
  "/opt/app-builder/dependency-cache/node-modules.tar.gz";
export const DEPENDENCY_CACHE_TIMEOUT_MS = 30_000;
export const DEPENDENCY_PREPARATION_TIMEOUT_MS = 120_000;
export const DEPENDENCY_CACHE_OUTPUT_BYTES = 262_144;

const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/u);

const dependencyCacheManifestShapeSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal("identity-planning"),
  platform: z.literal("linux/arm64"),
  target: z.strictObject({
    sha: gitObjectId,
    tree: gitObjectId,
    miseConfigSha256: z.literal(
      "cf41b10e80b962d5519bcaa17ce4cf58a0a841bb08583a121c585278debc5351",
    ),
    miseLockSha256: z.literal(
      "847ebdcfea49e4550ab80e909e61a855dea0fa8a12ff98c89d99f38fc9ea3ab2",
    ),
    bunLockSha256: z.literal(
      "c82b398f634d1f07bf4dc5f369e26739ea7a5bef37dfc64123bc9492156c90ca",
    ),
    appIdentitySha256: z.literal(
      "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
    ),
    appContractSha256: z.literal(
      "e391e032dcff5c63dea66c64e79c88be3ce4b9e1a00333b11cedb8836e109073",
    ),
    repositoryPreflightSha256: z.literal(
      "5e2cf9854d73f3452dad5ada4720f0f7d009c137c0071845acc8892641126503",
    ),
    repositoryExecSha256: z.literal(
      "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
    ),
  }),
  runtime: z.strictObject({
    bun: z.literal(ARRUSTED_BUN_VERSION),
  }),
  closure: z.strictObject({
    package: z.literal("@vercel/microfrontends"),
    version: z.literal(ARRUSTED_MICROFRONTENDS_VERSION),
    archivePath: z.literal(DEPENDENCY_CACHE_ARCHIVE_PATH),
    archiveSha256: sha256Digest,
    archiveBytes: z.number().int().positive(),
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

const fixtureDependencyCacheEnabled = (
  environment: Readonly<Record<string, string | undefined>>,
) => hasTestCapability("simulated-target", environment);

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
    scope: "identity-planning",
    platform: "linux/arm64",
    target: {
      sha: target.sourceSha,
      tree: target.sourceTree,
      miseConfigSha256:
        "cf41b10e80b962d5519bcaa17ce4cf58a0a841bb08583a121c585278debc5351",
      miseLockSha256:
        "847ebdcfea49e4550ab80e909e61a855dea0fa8a12ff98c89d99f38fc9ea3ab2",
      bunLockSha256:
        "c82b398f634d1f07bf4dc5f369e26739ea7a5bef37dfc64123bc9492156c90ca",
      appIdentitySha256:
        "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
      appContractSha256:
        "e391e032dcff5c63dea66c64e79c88be3ce4b9e1a00333b11cedb8836e109073",
      repositoryPreflightSha256:
        "5e2cf9854d73f3452dad5ada4720f0f7d009c137c0071845acc8892641126503",
      repositoryExecSha256:
        "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
    },
    runtime: { bun: ARRUSTED_BUN_VERSION },
    closure: {
      package: "@vercel/microfrontends",
      version: ARRUSTED_MICROFRONTENDS_VERSION,
      archivePath: DEPENDENCY_CACHE_ARCHIVE_PATH,
      archiveSha256: "2".repeat(64),
      archiveBytes: 1,
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

  const manifestResult = await sandbox.run({
    command: `cat -- ${DEPENDENCY_CACHE_MANIFEST_PATH}`,
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
    command: `sha256sum -- ${DEPENDENCY_CACHE_ARCHIVE_PATH} && stat --format='%s' -- ${DEPENDENCY_CACHE_ARCHIVE_PATH}`,
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
  const [checksumLine, sizeLine] = archiveResult.stdout.trim().split("\n");
  const observedDigest = checksumLine?.trim().split(/\s+/u)[0];
  const observedBytes = Number(sizeLine);
  if (
    observedDigest === undefined ||
    !sha256Digest.safeParse(observedDigest).success ||
    observedDigest !== validated.data.closure.archiveSha256 ||
    observedBytes !== validated.data.closure.archiveBytes
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
    await ensureSandboxDirectories(input.sandbox, [root]);
    const extraction = await input.sandbox.run({
      command: `rm -rf /workspace/${root}/node_modules && cd /workspace/${root} && tar --list --gzip --file ${DEPENDENCY_CACHE_ARCHIVE_PATH} | awk 'substr($0, length($0), 1) == "/"' | while IFS= read -r directory; do mkdir -p -- "$directory"; done && tar --extract --gzip --no-overwrite-dir --file ${DEPENDENCY_CACHE_ARCHIVE_PATH} --no-same-owner --no-same-permissions`,
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
  return { ...observed, planningRoot: `/workspace/${root}` };
}

export function dependencyCacheReceiptDigest(
  observed: ObservedDependencyCache,
) {
  return `sha256:${observed.manifestDigest}`;
}
