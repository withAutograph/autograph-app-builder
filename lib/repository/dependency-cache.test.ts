import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
  DEPENDENCY_CACHE_ARCHIVE_PATH,
  assertExactDependencyTargetBinding,
  inspectDependencyCache,
  materializeOfflineDependencies,
} from "./dependency-cache";

const archiveDigest = "a".repeat(64);
const manifest = {
  version: 1,
  scope: "identity-planning",
  platform: "linux/arm64",
  target: {
    sha: ARRUSTED_TARGET_SHA,
    tree: ARRUSTED_TARGET_TREE,
    miseConfigSha256:
      "563ef5a6a44ce320ce4833f61391ebd9f41b02ac542d4254f04087285ce449ae",
    miseLockSha256:
      "415008336ed45882fce91f681fdce7648583ce6744372beb4d5212ab644e3462",
    bunLockSha256:
      "a3c9712b469ef5bf8d22ae588b42c5834fff53adb2cf6c0ed84ebac9f3e0999b",
    appIdentitySha256:
      "10d474a28cb941686e768cf642f0e0466a6ac1c359ef5d3c2737c5548606ff6c",
    appContractSha256:
      "03889bce16d5368da287ae4215056ed786ba8c161b3bb4a0e10c9e17cb70994e",
    repositoryPreflightSha256:
      "6e3d96c9373d046f24d654bada360d08bbbbc155bc3b382fc9fc1a0009e7a6e6",
    repositoryExecSha256:
      "7816d61ce34ccf3b7680d6e03ddd8655650312901f23a03fae2b1aab50a051dc",
  },
  runtime: { bun: "1.3.14" },
  closure: {
    package: "@vercel/microfrontends",
    version: "2.4.0",
    archivePath: DEPENDENCY_CACHE_ARCHIVE_PATH,
    archiveSha256: archiveDigest,
    archiveBytes: 123,
  },
} as const;

function sandboxFixture(inputManifest: unknown = manifest) {
  const run = vi
    .fn()
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: `${JSON.stringify(inputManifest)}\n`,
      stderr: "",
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: `${archiveDigest}  ${DEPENDENCY_CACHE_ARCHIVE_PATH}\n123\n`,
      stderr: "",
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
  run.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
  const sandbox = {
    run,
    readTextFile: vi.fn(async () => JSON.stringify({ version: "2.4.0" })),
  } as unknown as SandboxSession;
  return { run, sandbox };
}

describe("offline dependency cache", () => {
  it("binds fixture cache observations to the exact prepared source", async () => {
    const target = {
      sourceSha: "3".repeat(40),
      sourceTree: "4".repeat(40),
    };
    const cache = await inspectDependencyCache(
      {} as SandboxSession,
      process.env,
      target,
    );

    expect(cache.manifest.target).toEqual(
      expect.objectContaining({
        sha: target.sourceSha,
        tree: target.sourceTree,
      }),
    );
    expect(() =>
      assertExactDependencyTargetBinding({
        workspace: target,
        sourceReceipt: target,
        cache,
      }),
    ).not.toThrow();
  });

  it("rejects source-tree and durable dependency-receipt drift", async () => {
    const target = {
      sourceSha: "3".repeat(40),
      sourceTree: "4".repeat(40),
    };
    const cache = await inspectDependencyCache(
      {} as SandboxSession,
      process.env,
      target,
    );

    expect(() =>
      assertExactDependencyTargetBinding({
        workspace: target,
        sourceReceipt: { ...target, sourceTree: "5".repeat(40) },
        cache,
      }),
    ).toThrow("prepared source does not match");
    expect(() =>
      assertExactDependencyTargetBinding({
        workspace: target,
        sourceReceipt: target,
        cache,
        dependencyReceipt: {
          ...target,
          targetSha: target.sourceSha,
          targetTree: "5".repeat(40),
        },
      }),
    ).toThrow("prepared source does not match");
  });

  it("verifies target-bound manifest and archive bytes before extraction", async () => {
    const { run, sandbox } = sandboxFixture();
    const result = await materializeOfflineDependencies({
      sandbox,
      artifactRevision: "b".repeat(64),
      target: {
        sourceSha: ARRUSTED_TARGET_SHA,
        sourceTree: ARRUSTED_TARGET_TREE,
      },
      environment: {},
    });
    expect(result.contentDigest).toBe(archiveDigest);
    expect(run).toHaveBeenNthCalledWith(1, {
      command: "cat -- /opt/app-builder/dependency-cache/manifest.json",
      workingDirectory: "/workspace",
      abortSignal: expect.any(AbortSignal),
    });
    expect(run).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        command: expect.stringContaining(
          `.app-builder/target-inputs/${"b".repeat(64)}/repository/node_modules`,
        ),
        workingDirectory: "/workspace",
      }),
    );
    expect(run.mock.calls[3]?.[0]).not.toHaveProperty("env");
    expect(run.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("--no-overwrite-dir"),
      }),
    );
    expect(run.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining(
          'while IFS= read -r directory; do mkdir -p -- "$directory"; done',
        ),
      }),
    );
  });

  it("rejects target drift and does not extract", async () => {
    const { run, sandbox } = sandboxFixture({
      ...manifest,
      target: { ...manifest.target, sha: "0".repeat(40) },
    });
    await expect(inspectDependencyCache(sandbox, {})).rejects.toThrow(
      "manifest drifted",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps the image recipe bound to the exact target and closure", () => {
    const dockerfile = readFileSync(
      new URL("../../containers/eve-sandbox/Dockerfile", import.meta.url),
      "utf8",
    );
    expect(dockerfile).toContain(`ARG TARGET_SHA=${ARRUSTED_TARGET_SHA}`);
    expect(dockerfile).toContain(`ARG TARGET_TREE=${ARRUSTED_TARGET_TREE}`);
    expect(dockerfile).toContain("COPY --from=arrusted-target");
    expect(dockerfile).toContain(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(dockerfile).toContain("gzip --no-name --best");
    expect(dockerfile).toContain("@vercel/microfrontends");
    expect(dockerfile).toContain("RUN --network=none");
  });
});
