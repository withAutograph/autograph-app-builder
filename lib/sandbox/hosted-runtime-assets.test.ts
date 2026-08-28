import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  HOSTED_ARTIFACT_BYTES,
  HOSTED_ARTIFACT_SHA256,
} from "./hosted-artifact";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("hosted runtime asset bundle", () => {
  it("loads every managed seed and the exact artifact without an authored tree", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "hosted-runtime-assets-"));
    temporaryRoots.push(runtimeRoot);
    const seedsModule = pathToFileURL(
      resolve("lib/sandbox/hosted-managed-seeds.ts"),
    ).href;
    const artifactModule = pathToFileURL(
      resolve("lib/sandbox/hosted-artifact.ts"),
    ).href;
    const tsxLoader = import.meta.resolve("tsx/esm");
    const { NODE_OPTIONS: _nodeOptions, ...childEnvironment } = process.env;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        "--input-type=module",
        "--eval",
        `const [crypto, seeds, artifact] = await Promise.all([import("node:crypto"), import(${JSON.stringify(seedsModule)}), import(${JSON.stringify(artifactModule)})]);
const bytes = artifact.readHostedArtifactBytes();
process.stdout.write(JSON.stringify({ artifactBytes: bytes.byteLength, artifactSha256: crypto.createHash("sha256").update(bytes).digest("hex"), seedCount: seeds.readHostedManagedSeedFiles().length }));`,
      ],
      {
        cwd: runtimeRoot,
        encoding: "utf8",
        env: childEnvironment,
      },
    );

    expect(JSON.parse(output)).toEqual({
      artifactBytes: HOSTED_ARTIFACT_BYTES,
      artifactSha256: HOSTED_ARTIFACT_SHA256,
      seedCount: 12,
    });
  });
});
