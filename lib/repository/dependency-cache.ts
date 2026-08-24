import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";

export const ARRUSTED_TARGET_SHA = "e4e76f52a365c6b8da2f84698b38844f26a31750";
export const ARRUSTED_TARGET_TREE = "7244f79f2ec523d0269fda6a9b59a1067bd723f8";
export const ARRUSTED_BUN_VERSION = "1.3.14";
export const ARRUSTED_MICROFRONTENDS_VERSION = "2.4.0";

export const DEPENDENCY_CACHE_MANIFEST_PATH =
  "/opt/app-builder/dependency-cache/manifest.json";
export const DEPENDENCY_CACHE_ARCHIVE_PATH =
  "/opt/app-builder/dependency-cache/node-modules.tar";
export const DEPENDENCY_CACHE_TIMEOUT_MS = 30_000;
export const DEPENDENCY_CACHE_OUTPUT_BYTES = 262_144;

const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/u);

export const dependencyCacheManifestSchema = z.strictObject({
  version: z.literal(1),
  scope: z.literal("identity-planning"),
  platform: z.literal("linux/arm64"),
  target: z.strictObject({
    sha: z.literal(ARRUSTED_TARGET_SHA),
    tree: z.literal(ARRUSTED_TARGET_TREE),
    miseConfigSha256: z.literal(
      "a9d2bf3a9366e38a1d75eb05d21b7a7dde46a5530afc5be2bff96be73ceb3782",
    ),
    miseLockSha256: z.literal(
      "847ebdcfea49e4550ab80e909e61a855dea0fa8a12ff98c89d99f38fc9ea3ab2",
    ),
    bunLockSha256: z.literal(
      "e2818f05408189b47223b67f71a66f1e8f9c8a31e5ad8326ba4a22130b5e6a33",
    ),
    appIdentitySha256: z.literal(
      "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
    ),
    appContractSha256: z.literal(
      "e391e032dcff5c63dea66c64e79c88be3ce4b9e1a00333b11cedb8836e109073",
    ),
    repositoryPreflightSha256: z.literal(
      "898751baaebc72d82e591afde5f07ad37570a065f60c122bf23b2f85996df37e",
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

export type DependencyCacheManifest = z.infer<
  typeof dependencyCacheManifestSchema
>;

export type ObservedDependencyCache = {
  manifest: DependencyCacheManifest;
  manifestDigest: string;
  contentDigest: string;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const fixtureDependencyCacheEnabled = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  environment.APP_BUILDER_TEST_MODEL === "1" &&
  environment.APP_BUILDER_REAL_SANDBOX !== "1";

function boundedOutput(stdout: string, stderr: string, label: string) {
  if (
    Buffer.byteLength(stdout) > DEPENDENCY_CACHE_OUTPUT_BYTES ||
    Buffer.byteLength(stderr) > DEPENDENCY_CACHE_OUTPUT_BYTES
  )
    throw new Error(`${label} output exceeded the fixed size limit.`);
}

function fixtureManifest(): DependencyCacheManifest {
  return {
    version: 1,
    scope: "identity-planning",
    platform: "linux/arm64",
    target: {
      sha: ARRUSTED_TARGET_SHA,
      tree: ARRUSTED_TARGET_TREE,
      miseConfigSha256:
        "a9d2bf3a9366e38a1d75eb05d21b7a7dde46a5530afc5be2bff96be73ceb3782",
      miseLockSha256:
        "847ebdcfea49e4550ab80e909e61a855dea0fa8a12ff98c89d99f38fc9ea3ab2",
      bunLockSha256:
        "e2818f05408189b47223b67f71a66f1e8f9c8a31e5ad8326ba4a22130b5e6a33",
      appIdentitySha256:
        "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
      appContractSha256:
        "e391e032dcff5c63dea66c64e79c88be3ce4b9e1a00333b11cedb8836e109073",
      repositoryPreflightSha256:
        "898751baaebc72d82e591afde5f07ad37570a065f60c122bf23b2f85996df37e",
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
): Promise<ObservedDependencyCache> {
  if (fixtureDependencyCacheEnabled(environment)) {
    const manifest = fixtureManifest();
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
  environment?: Readonly<Record<string, string | undefined>>;
}) {
  const environment = input.environment ?? process.env;
  const observed = await inspectDependencyCache(input.sandbox, environment);
  const root = planningOverlayRoot(input.artifactRevision);
  if (!fixtureDependencyCacheEnabled(environment)) {
    const extraction = await input.sandbox.run({
      command: `rm -rf /workspace/${root}/node_modules && tar --extract --file ${DEPENDENCY_CACHE_ARCHIVE_PATH} --directory /workspace/${root} --no-same-owner --no-same-permissions`,
      workingDirectory: "/workspace",
      abortSignal: AbortSignal.timeout(DEPENDENCY_CACHE_TIMEOUT_MS),
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
